const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  MAX_WEBSOCKET_TICKETS_PER_USER,
  WEBSOCKET_TICKET_DURATION_MS,
  createAuthenticationService,
  hashPassword,
} = require('../authentication');

const WORKSPACE_ID = 'service-test-workspace';
const BOOTSTRAP_USERNAME = 'service-bootstrap';
const BOOTSTRAP_PASSWORD = 'first-bootstrap-password-2046';

function createMemoryStore({ initial = {}, pauseSessionLookup = null } = {}) {
  let database = {
    users: [], workspacememberships: [], authsessions: [],
    ...structuredClone(initial),
  };
  const model = collectionName => ({
    collectionName,
    async findOne(query = {}) {
      const record = database[collectionName].find(item =>
        Object.entries(query).every(([key, value]) => String(item[key]) === String(value)));
      if (collectionName === 'authsessions' && pauseSessionLookup?.shouldPause()) {
        await pauseSessionLookup.pause();
      }
      return record ? structuredClone(record) : null;
    },
  });
  const mutateDBAtomically = mutation => {
    const snapshot = structuredClone(database);
    const result = mutation(snapshot);
    if (result?.commit !== false) database = snapshot;
    return result?.value ?? result;
  };
  return {
    models: {
      User: model('users'),
      WorkspaceMembership: model('workspacememberships'),
      AuthSession: model('authsessions'),
    },
    mutateDBAtomically,
    get database() { return structuredClone(database); },
  };
}

function makeService(store, now = Date.now) {
  return createAuthenticationService({
    ...store.models,
    workspaceId: WORKSPACE_ID,
    mutateDBAtomically: store.mutateDBAtomically,
    now,
  });
}

const bootstrapEnvironment = {
  NODE_ENV: 'production',
  CODESTUDIO_BOOTSTRAP_ADMIN_USERNAME: BOOTSTRAP_USERNAME,
  CODESTUDIO_BOOTSTRAP_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
};

test('bootstrap creates one admin and the same credentials restart idempotently', async () => {
  const store = createMemoryStore();
  const firstStart = makeService(store);
  await firstStart.initialize(bootstrapEnvironment);
  const original = store.database;
  assert.equal(original.users.length, 1);
  assert.equal(original.workspacememberships.length, 1);
  assert.equal(original.workspacememberships[0].role, 'admin');

  const restarted = makeService(store);
  await restarted.initialize(bootstrapEnvironment);
  assert.deepEqual(store.database, original);
  assert.ok(await restarted.login(BOOTSTRAP_USERNAME, BOOTSTRAP_PASSWORD));
});

test('bootstrap refuses to take over a matching existing non-admin username', async () => {
  const existingPassword = 'existing-account-password-2046';
  const userId = 'preexisting-user-id';
  const store = createMemoryStore({ initial: {
    users: [{
      _id: userId, username: BOOTSTRAP_USERNAME,
      passwordHash: await hashPassword(existingPassword), disabled: false,
      createdAt: new Date(0).toISOString(),
    }],
    workspacememberships: [{ _id: 'membership', userId, workspaceId: WORKSPACE_ID, role: 'member' }],
  } });
  const original = store.database;
  const service = makeService(store);
  await assert.rejects(service.initialize(bootstrapEnvironment), /bootstrap administrator conflicts with an existing account/i);
  assert.deepEqual(store.database, original);
  assert.equal(store.database.workspacememberships[0].role, 'member');
});

test('bootstrap refuses an existing admin when configured credentials do not match', async () => {
  const userId = 'existing-admin-id';
  const store = createMemoryStore({ initial: {
    users: [{
      _id: userId, username: BOOTSTRAP_USERNAME,
      passwordHash: await hashPassword('different-existing-password-2046'), disabled: false,
      createdAt: new Date(0).toISOString(),
    }],
    workspacememberships: [{ _id: 'membership', userId, workspaceId: WORKSPACE_ID, role: 'admin' }],
  } });
  const original = store.database;
  await assert.rejects(makeService(store).initialize(bootstrapEnvironment), /bootstrap administrator conflicts with an existing account/i);
  assert.deepEqual(store.database, original);
});

test('expired tickets are pruned on issuance and per-user outstanding tickets are bounded', async () => {
  let now = 1000;
  const store = createMemoryStore();
  const service = makeService(store, () => now);
  await service.initialize(bootstrapEnvironment);
  const login = await service.login(BOOTSTRAP_USERNAME, BOOTSTRAP_PASSWORD);
  const identity = await service.authenticate(login.token);
  const expiredTickets = [];
  for (let index = 0; index < MAX_WEBSOCKET_TICKETS_PER_USER; index += 1) {
    expiredTickets.push(await service.issueWebSocketTicket(identity, `old-document-${index}`));
  }
  assert.equal((await service.issueWebSocketTicket(identity, 'over-limit')).reason, 'ticket_limit');

  now += WEBSOCKET_TICKET_DURATION_MS + 1;
  const activeTickets = [];
  for (let index = 0; index < MAX_WEBSOCKET_TICKETS_PER_USER; index += 1) {
    const result = await service.issueWebSocketTicket(identity, `document-${index}`);
    assert.equal(result.ok, true);
    activeTickets.push(result.ticket);
  }
  assert.equal((await service.issueWebSocketTicket(identity, 'over-limit-again')).reason, 'ticket_limit');
  assert.equal(service.consumeWebSocketTicket(expiredTickets[0].ticket, 'old-document-0'), null);
  assert.equal(service.consumeWebSocketTicket(activeTickets[0], 'wrong-document'), null);
  assert.equal(service.consumeWebSocketTicket(activeTickets[1], 'document-1')?.userId, identity.userId);
  const revokedTicket = await service.issueWebSocketTicket(identity, 'revoked-document');
  await service.logout(login.token);
  assert.equal(service.consumeWebSocketTicket(revokedTicket.ticket, 'revoked-document'), null);
});

test('disabling an account invalidates its outstanding unused WebSocket tickets', async () => {
  const store = createMemoryStore();
  const service = makeService(store);
  await service.initialize(bootstrapEnvironment);
  const login = await service.login(BOOTSTRAP_USERNAME, BOOTSTRAP_PASSWORD);
  const identity = await service.authenticate(login.token);
  const ticket = await service.issueWebSocketTicket(identity, 'disable-target-document');
  assert.equal(ticket.ok, true);

  let revocationHandled = false;
  await service.disableWorkspaceUser(identity.userId, () => { revocationHandled = true; });
  assert.equal(revocationHandled, true);
  assert.equal(service.consumeWebSocketTicket(ticket.ticket, 'disable-target-document'), null);
  assert.equal(await service.isIdentityActive(identity), false);
});

test('explicit development bypass does not allocate tickets the WebSocket server will ignore', async () => {
  const store = createMemoryStore();
  const service = makeService(store);
  await service.initialize({ NODE_ENV: 'development', CODESTUDIO_DEV_AUTH_BYPASS: 'true' });
  const identity = await service.authenticate(null);
  const ticket = await service.issueWebSocketTicket(identity, 'local-document');
  assert.deepEqual(ticket, { ok: true, ticket: 'development-bypass' });
  assert.equal(service.consumeWebSocketTicket(ticket.ticket, 'local-document'), null);
});

test('logout during asynchronous room preparation prevents final admission and room updates', async () => {
  const store = createMemoryStore();
  const service = makeService(store);
  await service.initialize(bootstrapEnvironment);
  const login = await service.login(BOOTSTRAP_USERNAME, BOOTSTRAP_PASSWORD);
  const identity = await service.authenticate(login.token);
  let releasePreparation;
  let preparationStarted;
  const started = new Promise(resolve => { preparationStarted = resolve; });
  const preparation = new Promise(resolve => { releasePreparation = resolve; });
  const participants = new Set();
  let deliveredUpdates = 0;

  const admission = (async () => {
    preparationStarted();
    await preparation;
    return service.withActiveIdentity(identity, () => {
      participants.add('revoked-socket');
      return true;
    });
  })();
  await started;
  await service.logout(login.token, () => participants.delete('revoked-socket'));
  releasePreparation();
  assert.equal(await admission, false);
  for (const _participant of participants) deliveredUpdates += 1;
  assert.deepEqual([...participants], []);
  assert.equal(deliveredUpdates, 0);
});

test('disabling an account during asynchronous room preparation prevents final admission', async () => {
  const store = createMemoryStore();
  const service = makeService(store);
  await service.initialize(bootstrapEnvironment);
  const login = await service.login(BOOTSTRAP_USERNAME, BOOTSTRAP_PASSWORD);
  const identity = await service.authenticate(login.token);
  let releasePreparation;
  let preparationStarted;
  const started = new Promise(resolve => { preparationStarted = resolve; });
  const preparation = new Promise(resolve => { releasePreparation = resolve; });
  let roomJoined = false;

  const admission = (async () => {
    preparationStarted();
    await preparation;
    return service.withActiveIdentity(identity, () => {
      roomJoined = true;
      return true;
    });
  })();
  await started;
  await service.disableWorkspaceUser(identity.userId, () => { roomJoined = false; });
  releasePreparation();
  assert.equal(await admission, false);
  assert.equal(roomJoined, false);
});

test('admission and revocation are serialized so a registered connection is closed by the later revocation', async () => {
  let pause = true;
  let releaseSessionRead;
  let sessionReadStarted;
  const sessionStarted = new Promise(resolve => { sessionReadStarted = resolve; });
  const sessionBarrier = new Promise(resolve => { releaseSessionRead = resolve; });
  const store = createMemoryStore({ pauseSessionLookup: {
    shouldPause: () => pause,
    pause: async () => {
      pause = false;
      sessionReadStarted();
      await sessionBarrier;
    },
  } });
  const service = makeService(store);
  await service.initialize(bootstrapEnvironment);
  const login = await service.login(BOOTSTRAP_USERNAME, BOOTSTRAP_PASSWORD);
  // The first session lookup is intentionally gated inside the final admission
  // check. Logout queues behind it and must close what admission registers.
  const identityPromise = service.authenticate(login.token);
  await sessionStarted;
  releaseSessionRead();
  const identity = await identityPromise;
  let releaseAdmissionRead;
  let admissionReadStarted;
  const admittedStarted = new Promise(resolve => { admissionReadStarted = resolve; });
  const admissionBarrier = new Promise(resolve => { releaseAdmissionRead = resolve; });
  pause = true;
  store.models.AuthSession.findOne = async query => {
    const record = store.database.authsessions.find(item => item.tokenHash === query.tokenHash);
    if (pause) {
      pause = false;
      admissionReadStarted();
      await admissionBarrier;
    }
    return record || null;
  };
  const participants = new Set();
  const admission = service.withActiveIdentity(identity, () => {
    participants.add('registered-socket');
    return true;
  });
  await admittedStarted;
  let revokedAndClosed = false;
  const logout = service.logout(login.token, () => {
    participants.delete('registered-socket');
    revokedAndClosed = true;
  });
  releaseAdmissionRead();
  assert.equal(await admission, true);
  await logout;
  assert.equal(revokedAndClosed, true);
  assert.deepEqual([...participants], []);
});
