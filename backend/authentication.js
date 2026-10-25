const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);
const SESSION_DURATION_MS = 8 * 60 * 60 * 1000;
const WEBSOCKET_TICKET_DURATION_MS = 30 * 1000;
const MAX_WEBSOCKET_TICKETS_PER_USER = 12;
const PASSWORD_MIN_LENGTH = 12;

function workspaceIdFromEnvironment(env = process.env) {
  const workspaceId = env.CODESTUDIO_WORKSPACE_ID?.trim() || 'codestudio-default';
  if (!/^[A-Za-z0-9_-]{3,80}$/.test(workspaceId)) {
    throw new Error('CODESTUDIO_WORKSPACE_ID must contain 3 to 80 letters, numbers, underscores, or hyphens.');
  }
  return workspaceId;
}

function validateUsername(username) {
  return typeof username === 'string' && /^[A-Za-z0-9._-]{3,64}$/.test(username);
}

function validatePassword(password) {
  return typeof password === 'string' && Buffer.byteLength(password, 'utf8') >= PASSWORD_MIN_LENGTH
    && Buffer.byteLength(password, 'utf8') <= 1024;
}

async function hashPassword(password, salt = crypto.randomBytes(16)) {
  const derived = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$16384$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

async function verifyPassword(password, encodedHash) {
  if (typeof password !== 'string' || typeof encodedHash !== 'string') return false;
  const [algorithm, cost, saltText, expectedText] = encodedHash.split('$');
  if (algorithm !== 'scrypt' || cost !== '16384' || !saltText || !expectedText) return false;
  try {
    const salt = Buffer.from(saltText, 'base64url');
    const expected = Buffer.from(expectedText, 'base64url');
    if (salt.length !== 16 || expected.length !== 64) return false;
    const actual = await scrypt(password, salt, expected.length, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function publicUser(user, membership) {
  return {
    id: String(user._id),
    username: user.username,
    color: colorForUserId(user._id),
    role: membership.role,
    workspaceId: membership.workspaceId,
  };
}

function bootstrapConflictError() {
  const error = new Error('Configured bootstrap administrator conflicts with an existing account; choose a new bootstrap username or resolve the account administratively.');
  error.code = 'BOOTSTRAP_ADMIN_CONFLICT';
  return error;
}

function validateAuthenticationConfiguration(env = process.env) {
  const devBypass = env.NODE_ENV === 'development' && env.CODESTUDIO_DEV_AUTH_BYPASS === 'true';
  if (env.CODESTUDIO_DEV_AUTH_BYPASS === 'true' && !devBypass) {
    throw new Error('CODESTUDIO_DEV_AUTH_BYPASS is permitted only when NODE_ENV is development.');
  }
  const bootstrapUsername = typeof env.CODESTUDIO_BOOTSTRAP_ADMIN_USERNAME === 'string'
    && env.CODESTUDIO_BOOTSTRAP_ADMIN_USERNAME.trim()
    ? env.CODESTUDIO_BOOTSTRAP_ADMIN_USERNAME.trim() : undefined;
  const bootstrapPassword = typeof env.CODESTUDIO_BOOTSTRAP_ADMIN_PASSWORD === 'string'
    && env.CODESTUDIO_BOOTSTRAP_ADMIN_PASSWORD.length > 0
    ? env.CODESTUDIO_BOOTSTRAP_ADMIN_PASSWORD : undefined;
  if (env.NODE_ENV === 'production' && (!validateUsername(bootstrapUsername) || !validatePassword(bootstrapPassword))) {
    throw new Error('Production requires valid CODESTUDIO_BOOTSTRAP_ADMIN_USERNAME and CODESTUDIO_BOOTSTRAP_ADMIN_PASSWORD settings.');
  }
  if ((bootstrapUsername === undefined) !== (bootstrapPassword === undefined)) {
    throw new Error('Both bootstrap administrator settings must be provided together.');
  }
  if (bootstrapUsername !== undefined
    && (!validateUsername(bootstrapUsername) || !validatePassword(bootstrapPassword))) {
    throw new Error('Bootstrap administrator credentials do not meet the required format and password length.');
  }
  return { devBypass, bootstrapUsername, bootstrapPassword };
}

function createAuthenticationService({ User, WorkspaceMembership, AuthSession, workspaceId, mutateDBAtomically, now = Date.now }) {
  const websocketTickets = new Map();
  let devBypass = false;
  let sessionLifecycleQueue = Promise.resolve();

  function serializeSessionLifecycle(operation) {
    const result = sessionLifecycleQueue.then(operation, operation);
    sessionLifecycleQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  function removeTicketsForIdentity({ userId, sessionTokenHash }) {
    for (const [ticket, entry] of websocketTickets) {
      if ((userId && entry.identity.userId === userId)
        || (sessionTokenHash && entry.identity.sessionTokenHash === sessionTokenHash)) {
        websocketTickets.delete(ticket);
      }
    }
  }

  function removeExpiredTickets() {
    const time = now();
    for (const [ticket, entry] of websocketTickets) {
      if (entry.expiresAt <= time) websocketTickets.delete(ticket);
    }
  }

  async function initialize(env = process.env) {
    const config = validateAuthenticationConfiguration(env);
    devBypass = config.devBypass;
    const { bootstrapUsername, bootstrapPassword } = config;
    if (bootstrapUsername === undefined) return;

    const existingUser = await User.findOne({ username: bootstrapUsername });
    if (existingUser) {
      const membership = await WorkspaceMembership.findOne({ userId: String(existingUser._id), workspaceId });
      if (existingUser.disabled || membership?.role !== 'admin'
        || !await verifyPassword(bootstrapPassword, existingUser.passwordHash)) {
        throw bootstrapConflictError();
      }
      return;
    }

    const passwordHash = await hashPassword(bootstrapPassword);
    const result = mutateDBAtomically(db => {
      const racedUser = db[User.collectionName].find(record => record.username === bootstrapUsername);
      if (racedUser) return { commit: false, value: { created: false, user: racedUser } };
      const created = {
        _id: crypto.randomUUID(), username: bootstrapUsername, passwordHash,
        disabled: false, createdAt: new Date(now()).toISOString(),
      };
      db[User.collectionName].push(created);
      db[WorkspaceMembership.collectionName].push({
        _id: crypto.randomUUID(), userId: created._id, workspaceId, role: 'admin',
      });
      return { value: { created: true, user: created } };
    });
    if (result.created) return;

    const membership = await WorkspaceMembership.findOne({ userId: String(result.user._id), workspaceId });
    if (result.user.disabled || membership?.role !== 'admin'
      || !await verifyPassword(bootstrapPassword, result.user.passwordHash)) {
      throw bootstrapConflictError();
    }
  }

  function developmentPrincipal() {
    return {
      userId: 'local-development-user',
      username: 'Local developer',
      color: colorForUserId('local-development-user'),
      role: 'admin',
      workspaceId,
      devBypass: true,
    };
  }

  async function login(username, password) {
    const user = validateUsername(username) ? await User.findOne({ username }) : null;
    const valid = user && !user.disabled && await verifyPassword(password, user.passwordHash);
    if (!valid) return null;
    const membership = await WorkspaceMembership.findOne({ userId: String(user._id), workspaceId });
    if (!membership) return null;
    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = now() + SESSION_DURATION_MS;
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    mutateDBAtomically(db => {
      db[AuthSession.collectionName].push({
        _id: crypto.randomUUID(), tokenHash, userId: String(user._id), workspaceId, expiresAt,
      });
    });
    return { token, user: publicUser(user, membership), expiresAt };
  }

  async function authenticate(token) {
    if (devBypass) return developmentPrincipal();
    if (typeof token !== 'string' || token.length < 40 || token.length > 100) return null;
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const session = await AuthSession.findOne({ tokenHash });
    if (!session || session.expiresAt <= now() || session.workspaceId !== workspaceId) {
      if (session) {
        mutateDBAtomically(db => {
          db[AuthSession.collectionName] = db[AuthSession.collectionName]
            .filter(record => record.tokenHash !== tokenHash);
        });
      }
      return null;
    }
    const user = await User.findOne({ _id: session.userId });
    if (!user || user.disabled) return null;
    const membership = await WorkspaceMembership.findOne({ userId: String(user._id), workspaceId });
    if (!membership) return null;
    return {
      userId: String(user._id), username: user.username, color: colorForUserId(user._id),
      role: membership.role, workspaceId,
      sessionTokenHash: tokenHash, expiresAt: session.expiresAt,
    };
  }

  async function isIdentityActive(identity) {
    if (identity?.devBypass) return devBypass && identity.workspaceId === workspaceId;
    if (!identity?.sessionTokenHash || identity.expiresAt <= now()) return false;
    const session = await AuthSession.findOne({ tokenHash: identity.sessionTokenHash });
    if (!session || session.expiresAt <= now() || session.userId !== identity.userId
      || session.workspaceId !== workspaceId) return false;
    const user = await User.findOne({ _id: session.userId });
    const membership = await WorkspaceMembership.findOne({ userId: session.userId, workspaceId });
    return Boolean(user && !user.disabled && membership);
  }

  function withActiveIdentity(identity, admission) {
    return serializeSessionLifecycle(async () => {
      if (!await isIdentityActive(identity)) return false;
      const result = admission();
      if (result && typeof result.then === 'function') {
        throw new Error('WebSocket admission callbacks must complete synchronously.');
      }
      return result === undefined ? true : result;
    });
  }

  function logout(token, onRevoked = () => {}) {
    if (typeof token !== 'string') return Promise.resolve();
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    return serializeSessionLifecycle(() => {
      mutateDBAtomically(db => {
        db[AuthSession.collectionName] = db[AuthSession.collectionName]
          .filter(session => session.tokenHash !== tokenHash);
      });
      removeTicketsForIdentity({ sessionTokenHash: tokenHash });
      onRevoked();
    });
  }

  function issueWebSocketTicket(identity, documentId) {
    return serializeSessionLifecycle(async () => {
      if (!await isIdentityActive(identity)) return { ok: false, reason: 'session_revoked' };
      // Development WebSocket admission deliberately bypasses tickets, so do
      // not accumulate unused ticket records for that explicit local mode.
      if (identity.devBypass) return { ok: true, ticket: 'development-bypass' };
      removeExpiredTickets();
      const outstanding = [...websocketTickets.values()].filter(entry =>
        entry.identity.userId === identity.userId
        && entry.identity.workspaceId === identity.workspaceId);
      if (outstanding.length >= MAX_WEBSOCKET_TICKETS_PER_USER) return { ok: false, reason: 'ticket_limit' };
      const ticket = crypto.randomBytes(32).toString('base64url');
      websocketTickets.set(ticket, { identity, documentId, expiresAt: now() + WEBSOCKET_TICKET_DURATION_MS });
      return { ok: true, ticket };
    });
  }

  function consumeWebSocketTicket(ticket, documentId) {
    if (typeof ticket !== 'string') return null;
    removeExpiredTickets();
    const entry = websocketTickets.get(ticket);
    websocketTickets.delete(ticket);
    if (!entry || entry.expiresAt <= now() || entry.documentId !== documentId) return null;
    return entry.identity;
  }

  function disableWorkspaceUser(userId, onRevoked = () => {}) {
    if (!userId || typeof userId !== 'string') return Promise.resolve(false);
    return serializeSessionLifecycle(() => {
      const disabled = mutateDBAtomically(db => {
        const user = db[User.collectionName].find(record => String(record._id) === userId);
        if (!user) return { commit: false, value: false };
        user.disabled = true;
        db[AuthSession.collectionName] = db[AuthSession.collectionName]
          .filter(session => session.userId !== userId);
        return { value: true };
      });
      if (disabled) {
        removeTicketsForIdentity({ userId });
        onRevoked();
      }
      return disabled;
    });
  }

  async function createWorkspaceUser(username, password) {
    if (!validateUsername(username) || !validatePassword(password)) {
      return { ok: false, error: `Username must be 3–64 letters, numbers, dots, underscores, or hyphens; password must be at least ${PASSWORD_MIN_LENGTH} characters.` };
    }
    if (await User.findOne({ username })) return { ok: false, error: 'Username already exists.' };
    const passwordHash = await hashPassword(password);
    const result = mutateDBAtomically(db => {
      if (db[User.collectionName].some(record => record.username === username)) {
        return { commit: false, value: { ok: false, error: 'Username already exists.' } };
      }
      const user = {
        _id: crypto.randomUUID(), username, passwordHash,
        disabled: false, createdAt: new Date(now()).toISOString(),
      };
      const membership = { _id: crypto.randomUUID(), userId: user._id, workspaceId, role: 'member' };
      db[User.collectionName].push(user);
      db[WorkspaceMembership.collectionName].push(membership);
      return { value: { ok: true, user: publicUser(user, membership) } };
    });
    if (!result.ok) return result;
    return result;
  }

  function identityForRequest(req) {
    const requestedWorkspace = req.get('X-CodeStudio-Workspace-Id');
    if (requestedWorkspace && requestedWorkspace !== req.auth?.workspaceId) return false;
    return Boolean(req.auth && req.auth.workspaceId === workspaceId);
  }

  return {
    validateConfiguration: validateAuthenticationConfiguration,
    initialize,
    login,
    authenticate,
    isIdentityActive,
    withActiveIdentity,
    logout,
    issueWebSocketTicket,
    consumeWebSocketTicket,
    createWorkspaceUser,
    disableWorkspaceUser,
    identityForRequest,
    developmentPrincipal,
    get devBypass() { return devBypass; },
  };
}

function colorForUserId(userId) {
  const digest = crypto.createHash('sha256').update(String(userId)).digest();
  return `#${digest.subarray(0, 3).toString('hex')}`;
}

module.exports = {
  PASSWORD_MIN_LENGTH,
  SESSION_DURATION_MS,
  WEBSOCKET_TICKET_DURATION_MS,
  MAX_WEBSOCKET_TICKETS_PER_USER,
  colorForUserId,
  createAuthenticationService,
  hashPassword,
  validatePassword,
  validateAuthenticationConfiguration,
  validateUsername,
  verifyPassword,
  workspaceIdFromEnvironment,
};
