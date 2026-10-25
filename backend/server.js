// backend/server.js
require('dotenv').config();

const { resolveDataDirectory, validateProductionDataDirectory } = require('./storageConfiguration');
const DATA_DIR = resolveDataDirectory(process.env, __dirname);
if (process.env.NODE_ENV === 'production') validateProductionDataDirectory(DATA_DIR);
// Resolve once so the JSON metadata store and Yjs histories share the exact
// same root, including the unchanged backend-directory development default.
process.env.CODESTUDIO_DATA_DIR = DATA_DIR;

// Intercept mongoose imports to use mockMongoose instead
const mockMongoose = require('./mockMongoose');
require.cache[require.resolve('mongoose')] = {
  exports: mockMongoose
};

const express = require('express');
const cors = require('cors');
const http = require('http');
const crypto = require('node:crypto');
const { Server } = require('ws');
const { setupWSConnection } = require('y-websocket/bin/utils');
const yUtils = require('y-websocket/bin/utils');
const Y = require('yjs');
const mongoose = require('mongoose');
const File = require('./models/File');
const Folder = require('./models/Folder');
const FileTombstone = require('./models/FileTombstone');
const Member = require('./models/Member');
const User = require('./models/User');
const WorkspaceMembership = require('./models/WorkspaceMembership');
const AuthSession = require('./models/AuthSession');
const { createAuthenticationService, workspaceIdFromEnvironment } = require('./authentication');
const { createYjsPersistence } = require('./yjsPersistence');
const { searchText: searchProjectText, DEFAULT_RESULT_LIMIT } = require('./projectSearch');
const {
  BACKEND_BIND_HOST,
  BACKEND_PORT,
  assertPublicBindDisabled,
  isAllowedFrontendOrigin,
} = require('./networkBoundary');
const { isValidProjectPath, parentProjectPath, projectPathAncestors } = require('./projectPaths');
const { renameFileMetadata, renameFolderMetadata, deleteEmptyFolderMetadata } = require('./projectTreeMutations');
const WORKSPACE_ID = workspaceIdFromEnvironment();
const authentication = createAuthenticationService({
  User,
  WorkspaceMembership,
  AuthSession,
  workspaceId: WORKSPACE_ID,
  mutateDBAtomically: mockMongoose.mutateDBAtomically,
});
authentication.validateConfiguration(process.env);

// Deployment-facing bind configuration remains loopback-only until the API,
// event stream, and WebSocket admission all enforce authentication and access.
assertPublicBindDisabled(BACKEND_BIND_HOST);

const app = express();
const PORT = BACKEND_PORT;
const EXECUTION_UNAVAILABLE_REASON = 'JavaScript execution is disabled because a verified local isolation runtime is unavailable.';
let projectMutationQueue = Promise.resolve();
let roomAdmissionPauseCount = 0;
const closingRooms = new Set();
const closingDocumentIds = new Set();
const roomConnections = new Map();
const projectEventClients = new Set();
const authenticatedConnections = new Set();
const loginFailureBuckets = new Map();
const LOGIN_FAILURE_LIMIT = 8;
const LOGIN_FAILURE_WINDOW_MS = 15 * 60 * 1000;
const FILE_DELETED_CLOSE_CODE = 1008;
const FILE_DELETED_CLOSE_REASON = 'File deleted';
const ROOM_CLOSING_CLOSE_CODE = 1013;
const ROOM_CLOSING_CLOSE_REASON = 'File deletion in progress';

function trackRoomConnection(roomName, socket, clientId, userId) {
  const connections = roomConnections.get(roomName) || new Set();
  const connection = { socket, clientId, userId };
  connections.add(connection);
  roomConnections.set(roomName, connections);
  socket.once('close', () => {
    connections.delete(connection);
    if (connections.size === 0) roomConnections.delete(roomName);
  });
  return connection;
}

function registerAuthenticatedConnection(identity, close) {
  const record = { identity, close, timer: null };
  authenticatedConnections.add(record);
  if (Number.isFinite(identity.expiresAt)) {
    const delay = Math.max(0, identity.expiresAt - Date.now());
    record.timer = setTimeout(() => closeAuthenticatedRecord(record, 'Session expired'), delay);
    record.timer.unref?.();
  }
  return () => {
    if (record.timer) clearTimeout(record.timer);
    authenticatedConnections.delete(record);
  };
}

function closeAuthenticatedRecord(record, reason) {
  try { record.close(reason); } catch { /* The peer may already be closing. */ }
}

function revokeAuthenticatedConnections({ userId, sessionTokenHash }, reason) {
  for (const record of [...authenticatedConnections]) {
    if ((userId && record.identity.userId === userId)
      || (sessionTokenHash && record.identity.sessionTokenHash === sessionTokenHash)) {
      closeAuthenticatedRecord(record, reason);
    }
  }
}

function queueProjectMutation(mutation) {
  const operation = projectMutationQueue.then(mutation, mutation);
  projectMutationQueue = operation.catch(() => {});
  return operation;
}

function queueRoomCoordinatedTreeMutation(mutation) {
  // Close admission before the queued operation yields. The short global gate
  // is deliberately stronger than path-based locking: folder moves affect a
  // whole subtree, while active sockets remain attached to their stable IDs.
  roomAdmissionPauseCount += 1;
  return queueProjectMutation(mutation).finally(() => { roomAdmissionPauseCount -= 1; });
}

function publishProjectEvent(event) {
  const frame = `event: project-change\ndata: ${JSON.stringify({ ...event, workspaceId: WORKSPACE_ID })}\n\n`;
  for (const client of projectEventClients) {
    const { response } = client;
    if (client.workspaceId !== WORKSPACE_ID) continue;
    if (response.destroyed || response.writableEnded) {
      projectEventClients.delete(client);
      continue;
    }
    try {
      response.write(frame);
    } catch {
      projectEventClients.delete(client);
    }
  }
}
const DOCUMENT_ID_PATTERN = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;

async function ensureFileIdentity(file) {
  const record = file instanceof File ? file : new File(file);
  if (!record.documentId) {
    record.documentId = crypto.randomUUID();
    if (!record.historyKey) record.historyKey = record.name;
    await record.save();
  } else if (!record.historyKey) {
    // A partially written identity cannot safely be guessed: it may already
    // point at a different history key. Keep the room unavailable instead.
    throw new Error('Document history identity is incomplete');
  }
  if (!DOCUMENT_ID_PATTERN.test(record.documentId) || typeof record.historyKey !== 'string' || !record.historyKey) {
    throw new Error('Document identity is invalid');
  }

  Object.assign(file, record);
  const tombstone = await FileTombstone.findOne({ path: record.name });
  if (tombstone && !tombstone.documentId) {
    const tombstoneRecord = new FileTombstone(tombstone);
    tombstoneRecord.documentId = record.documentId;
    await tombstoneRecord.save();
    Object.assign(tombstone, tombstoneRecord);
  } else if (tombstone && tombstone.documentId !== record.documentId) {
    throw new Error('Deleted document identity does not match its file');
  }
  yjsPersistence.registerRoom(record.documentId, record.historyKey);
  Object.assign(file, record);
  return file;
}

async function resolveFileIdentity(file) {
  return queueProjectMutation(async () => {
    const latest = file._id ? await File.findOne({ _id: file._id }) : await File.findOne({ name: file.name });
    const identified = await ensureFileIdentity(latest || file);
    Object.assign(file, identified);
    return file;
  });
}
const SUPPORTED_FILE_LANGUAGES = new Set([
  'javascript', 'typescript', 'python', 'java', 'c', 'cpp', 'html', 'css', 'json', 'markdown',
  'scss', 'less', 'csharp', 'go', 'rust', 'yaml', 'xml', 'sql', 'shell', 'plaintext',
  'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'py', 'sh', 'yml', 'md',
]);
const LANGUAGE_BY_EXTENSION = {
  java: 'java',
  c: 'c',
  py: 'python',
  html: 'html',
  htm: 'html',
  css: 'css',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  md: 'markdown',
};

function isSupportedFileLanguage(language) {
  return typeof language === 'string'
    && SUPPORTED_FILE_LANGUAGES.has(language.trim().toLowerCase());
}

function getFileLanguage(name, requestedLanguage) {
  if (isSupportedFileLanguage(requestedLanguage)) {
    return { language: requestedLanguage, languageSource: 'explicit' };
  }
  const extension = String(name).split('.').pop()?.toLowerCase() || '';
  return {
    language: LANGUAGE_BY_EXTENSION[extension] || 'javascript',
    languageSource: 'extension',
  };
}

function languageForExistingFile(file) {
  if (isSupportedFileLanguage(file.language)) {
    if (file.languageSource === 'explicit' || file.languageSource === 'extension') return file.language;
    // Before languageSource was recorded, the backend defaulted unknown extensions
    // to JavaScript. Infer those legacy defaults without rewriting stored records.
    if (file.language.trim().toLowerCase() !== 'javascript') return file.language;
  }
  return getFileLanguage(file.name).language;
}

// Browsers can call the API only from its configured exact-origin allowlist.
// Requests without Origin remain available for local command-line tools; this is
// why origin validation is not an authentication mechanism.
app.use((req, res, next) => {
  const origin = req.get('Origin');
  if (origin && !isAllowedFrontendOrigin(origin)) {
    return res.status(403).json({ error: 'Origin not allowed' });
  }
  next();
});
app.use(cors({
  origin: (origin, callback) => callback(null, isAllowedFrontendOrigin(origin) ? origin : false),
}));
app.use(express.json());

app.post('/api/auth/login', async (req, res) => {
  const now = Date.now();
  for (const [address, bucket] of loginFailureBuckets) {
    if (bucket.until <= now) loginFailureBuckets.delete(address);
  }
  const address = req.socket.remoteAddress || 'unknown';
  const bucket = loginFailureBuckets.get(address);
  if (bucket && bucket.count >= LOGIN_FAILURE_LIMIT && bucket.until > now) {
    return res.status(429).json({ error: 'Too many sign-in attempts. Try again later.' });
  }
  try {
    const result = await authentication.login(req.body?.username, req.body?.password);
    if (!result) {
      const current = loginFailureBuckets.get(address);
      loginFailureBuckets.set(address, {
        count: current && current.until > now ? current.count + 1 : 1,
        until: current && current.until > now ? current.until : now + LOGIN_FAILURE_WINDOW_MS,
      });
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    loginFailureBuckets.delete(address);
    return res.json(result);
  } catch {
    return res.status(503).json({ error: 'Authentication is temporarily unavailable' });
  }
});

app.use('/api', async (req, res, next) => {
  if (req.method === 'OPTIONS' || (req.method === 'POST' && req.path === '/auth/login')) return next();
  try {
    const authorization = req.get('Authorization') || '';
    const match = /^Bearer ([A-Za-z0-9_-]{40,100})$/.exec(authorization);
    const identity = await authentication.authenticate(match?.[1]);
    if (!identity) return res.status(401).json({ error: 'Authentication required' });
    req.auth = identity;
    if (!authentication.identityForRequest(req)) {
      return res.status(403).json({ error: 'Workspace access denied' });
    }
    return next();
  } catch {
    return res.status(503).json({ error: 'Authentication could not be verified' });
  }
});

app.get('/api/auth/me', (req, res) => {
  res.json({
    id: req.auth.userId,
    username: req.auth.username,
    color: req.auth.color || '#65a6ff',
    role: req.auth.role,
    workspaceId: req.auth.workspaceId,
  });
});

app.post('/api/auth/logout', async (req, res) => {
  const token = /^Bearer (.+)$/.exec(req.get('Authorization') || '')?.[1];
  await authentication.logout(token, () => {
    if (!token) return;
    const sessionTokenHash = crypto.createHash('sha256').update(token).digest('hex');
    revokeAuthenticatedConnections({ sessionTokenHash }, 'Signed out');
  });
  res.json({ message: 'Signed out' });
});

app.post('/api/auth/users', async (req, res) => {
  if (req.auth.role !== 'admin') return res.status(403).json({ error: 'Workspace administrator permission required' });
  try {
    const result = await authentication.createWorkspaceUser(req.body?.username, req.body?.password);
    if (!result.ok) return res.status(result.error === 'Username already exists.' ? 409 : 400).json({ error: result.error });
    return res.status(201).json({ user: result.user });
  } catch {
    return res.status(500).json({ error: 'Could not create workspace account' });
  }
});

app.delete('/api/auth/users/:userId', async (req, res) => {
  if (req.auth.role !== 'admin') return res.status(403).json({ error: 'Workspace administrator permission required' });
  if (req.params.userId === req.auth.userId) return res.status(409).json({ error: 'Administrators cannot disable their own account' });
  try {
    const disabled = await authentication.disableWorkspaceUser(req.params.userId, () => {
      revokeAuthenticatedConnections({ userId: req.params.userId }, 'Account disabled');
    });
    return disabled ? res.json({ message: 'Workspace account disabled' }) : res.status(404).json({ error: 'Workspace account not found' });
  } catch {
    return res.status(500).json({ error: 'Could not disable workspace account' });
  }
});

app.post('/api/auth/websocket-ticket', async (req, res) => {
  const { documentId } = req.body || {};
  if (typeof documentId !== 'string' || !DOCUMENT_ID_PATTERN.test(documentId)) {
    return res.status(400).json({ error: 'Invalid document identifier' });
  }
  try {
    const file = await File.findOne({ documentId });
    if (!file || await FileTombstone.findOne({ documentId }) || await FileTombstone.findOne({ path: file.name })) {
      return res.status(404).json({ error: 'Document not found' });
    }
    await resolveFileIdentity(file);
    const result = await authentication.issueWebSocketTicket(req.auth, documentId);
    if (!result.ok) {
      const status = result.reason === 'ticket_limit' ? 429 : 401;
      const error = result.reason === 'ticket_limit'
        ? 'Too many outstanding collaboration tickets. Close unused sessions and retry.'
        : 'Authentication required';
      return res.status(status).json({ error });
    }
    return res.json({ ticket: result.ticket });
  } catch {
    return res.status(503).json({ error: 'Document access could not be verified' });
  }
});

const yjsPersistence = createYjsPersistence({
  Y,
  dataDir: DATA_DIR,
  onRoomUnavailable: (docName, error, doc) => {
    console.error(`Yjs room ${encodeURIComponent(docName).slice(0, 120)} unavailable (${error.code})`);
    if (doc && doc.conns) {
      for (const conn of doc.conns.keys()) {
        try {
          conn.close(1011, 'Document history unavailable');
        } catch {
          // The connection may already be closing.
        }
      }
    }
  },
});
yUtils.setPersistence(yjsPersistence.persistence);

app.get('/api/files', async (req, res) => {
  try {
    const [files, tombstones] = await Promise.all([File.find({}), FileTombstone.find({})]);
    await queueProjectMutation(async () => {
      for (const file of files) await ensureFileIdentity(file);
    });
    const deletedPaths = new Set(tombstones.map(tombstone => tombstone.path));
    res.json(files.filter(file => !deletedPaths.has(file.name)).map(file => file.name));
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch files' });
  }
});

app.get('/api/folders', async (req, res) => {
  try {
    const folders = await Folder.find({});
    res.json(folders.map(folder => folder.path).sort((a, b) => a.localeCompare(b)));
  } catch {
    res.status(500).json({ error: 'Failed to fetch folders' });
  }
});

app.get('/api/project-events', (req, res) => {
  res.status(200);
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write(': connected\n\n');
  const client = { response: res, workspaceId: req.auth.workspaceId, userId: req.auth.userId };
  client.releaseAuth = registerAuthenticatedConnection(req.auth, () => res.end());
  projectEventClients.add(client);
  res.on('close', () => {
    projectEventClients.delete(client);
    client.releaseAuth();
  });
});

app.get('/api/execution-capability', (req, res) => {
  res.json({ available: false, reason: EXECUTION_UNAVAILABLE_REASON });
});

// Fail closed. Do not execute code in the collaboration server process.
app.post('/api/executions', (req, res) => {
  res.status(503).json({ error: EXECUTION_UNAVAILABLE_REASON });
});

app.get('/api/files/:filename/revisions/latest', async (req, res) => {
  try {
    if (!isValidProjectPath(req.params.filename)) {
      return res.status(400).json({ error: 'Invalid project-relative file path' });
    }
    const file = await File.findOne({ name: req.params.filename });
    if (!file) return res.status(404).json({ error: 'File not found' });
    await resolveFileIdentity(file);
    const revision = yjsPersistence.readDocumentRevision(file.documentId);
    if (!revision) return res.status(404).json({ error: 'No persisted document revision is available' });
    const { source, ...metadata } = revision;
    res.json({ ...metadata, sourceHash: crypto.createHash('sha256').update(source).digest('hex') });
  } catch (error) {
    const file = await File.findOne({ name: req.params.filename });
    const roomError = file ? yjsPersistence.getRoomError(file.documentId) : null;
    res.status(503).json({
      error: roomError ? 'Document history is unavailable' : 'Could not read persisted document revision',
      code: roomError?.code || 'revision_unavailable',
    });
  }
});

app.get('/api/files/:filename/revisions/:revisionId', async (req, res) => {
  try {
    if (!/^yrev1_[a-f0-9]{64}$/.test(req.params.revisionId)) {
      return res.status(400).json({ error: 'Invalid document revision identifier' });
    }
    if (!isValidProjectPath(req.params.filename)) {
      return res.status(400).json({ error: 'Invalid project-relative file path' });
    }
    const file = await File.findOne({ name: req.params.filename });
    if (!file) return res.status(404).json({ error: 'File not found' });
    await resolveFileIdentity(file);
    const revision = yjsPersistence.readDocumentRevision(file.documentId, req.params.revisionId);
    if (!revision) return res.status(404).json({ error: 'Persisted document revision not found' });
    const { source, ...metadata } = revision;
    res.json({ ...metadata, sourceHash: crypto.createHash('sha256').update(source).digest('hex') });
  } catch (error) {
    const file = await File.findOne({ name: req.params.filename });
    const roomError = file ? yjsPersistence.getRoomError(file.documentId) : null;
    res.status(503).json({
      error: roomError ? 'Document history is unavailable' : 'Could not read persisted document revision',
      code: roomError?.code || 'revision_unavailable',
    });
  }
});

app.get('/api/documents/:documentId/revisions/latest', async (req, res) => {
  try {
    if (!DOCUMENT_ID_PATTERN.test(req.params.documentId)) {
      return res.status(400).json({ error: 'Invalid document identifier' });
    }
    const file = await File.findOne({ documentId: req.params.documentId });
    if (!file) return res.status(404).json({ error: 'Document not found' });
    await resolveFileIdentity(file);
    const revision = yjsPersistence.readDocumentRevision(file.documentId);
    if (!revision) return res.status(404).json({ error: 'No persisted document revision is available' });
    const { source, ...metadata } = revision;
    res.json({ ...metadata, sourceHash: crypto.createHash('sha256').update(source).digest('hex') });
  } catch {
    res.status(503).json({ error: 'Could not read persisted document revision', code: 'revision_unavailable' });
  }
});

app.get('/api/documents/:documentId', async (req, res) => {
  try {
    const { documentId } = req.params;
    if (!DOCUMENT_ID_PATTERN.test(documentId)) {
      return res.status(400).json({ error: 'Invalid document identifier' });
    }
    const tombstone = await FileTombstone.findOne({ documentId });
    if (tombstone) return res.status(410).json({ error: 'Document has been deleted', code: 'file_deleted' });
    const file = await File.findOne({ documentId });
    if (!file) return res.status(404).json({ error: 'Document not found' });
    await resolveFileIdentity(file);
    return res.json({
      documentId: file.documentId,
      name: file.name,
      language: languageForExistingFile(file),
    });
  } catch {
    return res.status(503).json({ error: 'Document metadata is unavailable' });
  }
});

app.get('/api/documents/:documentId/revisions/:revisionId', async (req, res) => {
  try {
    if (!DOCUMENT_ID_PATTERN.test(req.params.documentId)) {
      return res.status(400).json({ error: 'Invalid document identifier' });
    }
    if (!/^yrev1_[a-f0-9]{64}$/.test(req.params.revisionId)) {
      return res.status(400).json({ error: 'Invalid document revision identifier' });
    }
    const file = await File.findOne({ documentId: req.params.documentId });
    if (!file) return res.status(404).json({ error: 'Document not found' });
    await resolveFileIdentity(file);
    const revision = yjsPersistence.readDocumentRevision(file.documentId, req.params.revisionId);
    if (!revision) return res.status(404).json({ error: 'Persisted document revision not found' });
    const { source, ...metadata } = revision;
    res.json({ ...metadata, sourceHash: crypto.createHash('sha256').update(source).digest('hex') });
  } catch {
    res.status(503).json({ error: 'Could not read persisted document revision', code: 'revision_unavailable' });
  }
});

app.get('/api/files/:filename', async (req, res) => {
  try {
    if (!isValidProjectPath(req.params.filename)) {
      return res.status(400).json({ error: 'Invalid project-relative file path' });
    }
    const tombstone = await FileTombstone.findOne({ path: req.params.filename });
    if (tombstone) return res.status(404).json({ error: 'File not found' });
    const file = await File.findOne({ name: req.params.filename });
    if (!file) {
      return res.status(404).json({ error: 'File not found' });
    }
    await resolveFileIdentity(file);
    res.json({ language: languageForExistingFile(file), documentId: file.documentId });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch file' });
  }
});

app.post('/api/search', async (req, res) => {
  const { query, caseSensitive = false, wholeWord = false, excludeFileName } = req.body || {};
  if (typeof query !== 'string' || !query.trim() || query.trim().length > 200
    || typeof caseSensitive !== 'boolean' || typeof wholeWord !== 'boolean'
    || (excludeFileName !== undefined
      && (!isValidProjectPath(excludeFileName) || excludeFileName.length > 255))) {
    return res.status(400).json({ error: 'Invalid project search request' });
  }

  try {
    const [allFiles, tombstones] = await Promise.all([File.find({}), FileTombstone.find({})]);
    const deletedPaths = new Set(tombstones.map(tombstone => tombstone.path));
    const files = allFiles.filter(file => !deletedPaths.has(file.name));
    const results = [];
    const unavailableFiles = [];
    let truncated = false;

    for (const file of files) {
      if (file.name === excludeFileName) continue;
      try {
        await resolveFileIdentity(file);
        const text = yjsPersistence.readDocumentText(file.documentId);
        const matches = searchProjectText(text, query, file.name, { caseSensitive, wholeWord }, DEFAULT_RESULT_LIMIT - results.length);
        results.push(...matches);
        if (results.length >= DEFAULT_RESULT_LIMIT) {
          truncated = true;
          break;
        }
      } catch {
        unavailableFiles.push(file.name);
      }
    }

    res.json({ results, unavailableFiles, truncated });
  } catch {
    res.status(500).json({ error: 'Failed to search project files' });
  }
});

app.post('/api/files', async (req, res) => {
  try {
    await queueProjectMutation(async () => {
      const { name, language } = req.body || {};
      if (!name) return res.status(400).json({ error: 'Name is required' });
      if (!isValidProjectPath(name)) {
        return res.status(400).json({ error: 'Invalid project-relative file path' });
      }

      const [files, folders, tombstones] = await Promise.all([File.find({}), Folder.find({}), FileTombstone.find({})]);
      const tombstoneCollision = tombstones.some(({ path: deletedPath }) => deletedPath === name);
      if (tombstoneCollision) {
        return res.status(409).json({ error: 'This file path is reserved by a deleted document', code: 'file_deleted' });
      }
      if (files.some(file => file.name === name)) return res.status(400).json({ error: 'File already exists' });
      if (folders.some(folder => folder.path === name || folder.path.startsWith(`${name}/`))) {
        return res.status(400).json({ error: 'A folder already exists at or below this path' });
      }

      const ancestors = projectPathAncestors(name);
      if (ancestors.some(ancestor => files.some(file => file.name === ancestor))) {
        return res.status(400).json({ error: 'A file blocks this project path' });
      }
      const parentPath = parentProjectPath(name);
      if (parentPath && !folders.some(folder => folder.path === parentPath)) {
        return res.status(400).json({ error: 'Parent folder does not exist' });
      }

      const languageMetadata = getFileLanguage(name, language);
      const documentId = crypto.randomUUID();
      const newFile = new File({ name, ...languageMetadata, documentId, historyKey: documentId });
      await newFile.save();
      const fileResponse = { ...newFile };
      delete fileResponse.historyKey;
      return res.json({ message: 'File created successfully', file: fileResponse });
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to create file' });
  }
});

app.post('/api/folders', async (req, res) => {
  try {
    await queueProjectMutation(async () => {
      const folderPath = req.body?.path;
      if (!isValidProjectPath(folderPath)) {
        return res.status(400).json({ error: 'Invalid project-relative folder path' });
      }

      const [files, folders, tombstones] = await Promise.all([File.find({}), Folder.find({}), FileTombstone.find({})]);
      if (tombstones.some(({ path: deletedPath }) => deletedPath === folderPath)) {
        return res.status(409).json({ error: 'This folder path conflicts with a deleted document reservation', code: 'file_deleted' });
      }
      if (folders.some(folder => folder.path === folderPath)) {
        return res.status(400).json({ error: 'Folder already exists' });
      }
      if (files.some(file => file.name === folderPath)) {
        return res.status(400).json({ error: 'A file already exists at this path' });
      }

      const ancestors = projectPathAncestors(folderPath);
      if (ancestors.some(ancestor => files.some(file => file.name === ancestor))) {
        return res.status(400).json({ error: 'A file blocks this project path' });
      }
      const parentPath = parentProjectPath(folderPath);
      if (parentPath && !folders.some(folder => folder.path === parentPath)) {
        return res.status(400).json({ error: 'Parent folder does not exist' });
      }

      const folder = new Folder({ path: folderPath });
      await folder.save();
      return res.json({ message: 'Folder created successfully', folder });
    });
  } catch {
    res.status(500).json({ error: 'Failed to create folder' });
  }
});

app.post('/api/files/rename', async (req, res) => {
  const { oldPath, newPath } = req.body || {};
  try {
    const result = await queueRoomCoordinatedTreeMutation(() => mockMongoose.mutateDBAtomically(db => {
      const outcome = renameFileMetadata(db, oldPath, newPath);
      if (!outcome.ok) return { commit: false, value: outcome };

      // A language inferred from its extension follows an extension-changing
      // rename. Explicitly selected language metadata remains untouched.
      const legacyDefaultLanguage = !outcome.file.languageSource
        && String(outcome.file.language || '').trim().toLowerCase() === 'javascript';
      if (outcome.file.languageSource === 'extension' || legacyDefaultLanguage || !outcome.file.language) {
        Object.assign(outcome.file, getFileLanguage(newPath));
      }
      return { value: outcome };
    }));
    if (!result.ok) return res.status(result.status).json({ error: result.error, code: result.code });
    const renamedFiles = result.renamedFiles.map(mapping => ({
      ...mapping,
      language: languageForExistingFile(result.file),
    }));
    const event = {
      type: 'rename',
      files: renamedFiles,
      folders: result.renamedFolders,
    };
    publishProjectEvent(event);
    return res.json({
      message: 'File renamed successfully',
      file: { name: result.file.name, documentId: result.file.documentId, language: languageForExistingFile(result.file) },
      renamedFiles,
    });
  } catch {
    return res.status(500).json({ error: 'Could not rename the file' });
  }
});

app.post('/api/folders/rename', async (req, res) => {
  const { oldPath, newPath } = req.body || {};
  try {
    const result = await queueRoomCoordinatedTreeMutation(() => mockMongoose.mutateDBAtomically(db => {
      const outcome = renameFolderMetadata(db, oldPath, newPath);
      return outcome.ok ? { value: outcome } : { commit: false, value: outcome };
    }));
    if (!result.ok) return res.status(result.status).json({ error: result.error, code: result.code });
    const event = {
      type: 'rename',
      files: result.renamedFiles,
      folders: result.renamedFolders,
    };
    publishProjectEvent(event);
    return res.json({
      message: 'Folder renamed successfully',
      folder: { path: result.folder.path },
      updatedFiles: result.updatedFiles,
      updatedFolders: result.updatedFolders,
      updatedTombstones: result.updatedTombstones,
      renamedFiles: result.renamedFiles,
      renamedFolders: result.renamedFolders,
    });
  } catch {
    return res.status(500).json({ error: 'Could not rename the folder' });
  }
});

app.delete('/api/folders/:folderPath', async (req, res) => {
  const folderPath = req.params.folderPath;
  try {
    const result = await queueRoomCoordinatedTreeMutation(() => mockMongoose.mutateDBAtomically(db => {
      const outcome = deleteEmptyFolderMetadata(db, folderPath);
      return outcome.ok ? { value: outcome } : { commit: false, value: outcome };
    }));
    if (!result.ok) return res.status(result.status).json({ error: result.error, code: result.code });

    publishProjectEvent({ type: 'folder-deleted', folder: { path: result.path } });
    return res.json({ message: 'Folder deleted successfully', folder: { path: result.path } });
  } catch {
    return res.status(500).json({ error: 'Could not delete the folder' });
  }
});

app.delete('/api/files/:filename', async (req, res) => {
  const filePath = req.params.filename;
  if (closingRooms.has(filePath)) {
    return res.status(409).json({ error: 'A deletion is already in progress for this file', code: 'file_deletion_in_progress' });
  }
  // This synchronous gate closes room admission before any asynchronous storage work.
  closingRooms.add(filePath);
  let closingDocumentId;
  try {
    if (!isValidProjectPath(filePath)) {
      return res.status(400).json({ error: 'Invalid project-relative file path' });
    }
    const clientId = typeof req.query.clientId === 'string' && /^[\da-f-]{36}$/i.test(req.query.clientId)
      ? req.query.clientId : null;
    await queueProjectMutation(async () => {
      if (await FileTombstone.findOne({ path: filePath })) {
        return res.status(409).json({ error: 'This file has already been deleted and its path is reserved', code: 'file_deleted' });
      }
      const file = await File.findOne({ name: filePath });
      if (!file) return res.status(404).json({ error: 'File not found' });
      await ensureFileIdentity(file);
      closingDocumentId = file.documentId;
      closingDocumentIds.add(closingDocumentId);

      const connections = [...(roomConnections.get(file.documentId) || [])];
      const requester = clientId
        ? connections.find(connection => connection.clientId === clientId && connection.userId === req.auth.userId)
        : connections.find(connection => connection.userId === req.auth.userId);
      const otherConnections = connections.filter(connection => connection !== requester);
      if (otherConnections.length > 0 || (connections.length > 0 && !requester)) {
        return res.status(409).json({
          error: 'This file is open in a collaboration session. Ask collaborators to close it, then retry.',
          code: 'file_in_use',
        });
      }

      // Persist the reservation before notifying/closing the requesting socket. The
      // file record and all Yjs history/revisions remain untouched.
      await new FileTombstone({ path: filePath, documentId: file.documentId, deletedAt: new Date().toISOString() }).save();
      if (requester && requester.socket.readyState === 1) {
        requester.socket.close(FILE_DELETED_CLOSE_CODE, FILE_DELETED_CLOSE_REASON);
      }
      return res.json({ message: 'File deleted successfully' });
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete file' });
  } finally {
    closingRooms.delete(filePath);
    if (closingDocumentId) closingDocumentIds.delete(closingDocumentId);
  }
});

// Member Routes
app.get('/api/members', async (req, res) => {
  try {
    const members = await Member.find({});
    res.json(members);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch members' });
  }
});

app.post('/api/members', async (req, res) => {
  if (req.auth.role !== 'admin') return res.status(403).json({ error: 'Workspace administrator permission required' });
  try {
    const { name, color } = req.body;
    if (!name || !color) return res.status(400).json({ error: 'Name and color are required' });
    const existing = await Member.findOne({ name });
    if (existing) return res.status(400).json({ error: 'Member already exists' });
    
    const newMember = new Member({ name, color });
    await newMember.save();
    res.json({ message: 'Member created successfully', member: newMember });
  } catch (error) {
    res.status(500).json({ error: 'Failed to create member' });
  }
});

app.delete('/api/members/:id', async (req, res) => {
  if (req.auth.role !== 'admin') return res.status(403).json({ error: 'Workspace administrator permission required' });
  try {
    const deleted = await Member.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Member not found' });
    res.json({ message: 'Member deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete member' });
  }
});

const server = http.createServer(app);
const wss = new Server({
  server,
  verifyClient: (info, callback) => {
    if (!isAllowedFrontendOrigin(info.origin)) return callback(false, 403, 'Origin not allowed');
    let documentId;
    let ticket;
    try {
      const requestUrl = new URL(info.req.url, 'http://127.0.0.1');
      documentId = requestUrl.pathname.slice(1);
      ticket = requestUrl.searchParams.get('ticket');
    } catch {
      return callback(false, 400, 'Invalid WebSocket request');
    }
    const identity = authentication.devBypass
      ? authentication.developmentPrincipal()
      : authentication.consumeWebSocketTicket(ticket, documentId);
    if (!identity || identity.workspaceId !== WORKSPACE_ID) {
      return callback(false, 401, 'WebSocket authentication required');
    }
    void authentication.isIdentityActive(identity).then(active => {
      if (!active) return callback(false, 401, 'WebSocket authentication required');
      info.req.auth = identity;
      return callback(true);
    }).catch(() => callback(false, 503, 'WebSocket authorization unavailable'));
  },
});

wss.on('connection', async (ws, req) => {
  let requestUrl;
  try {
    requestUrl = new URL(req.url, 'http://127.0.0.1');
  } catch {
    ws.close(1008, 'Invalid document request');
    return;
  }
  const documentId = requestUrl.pathname.slice(1);
  if (roomAdmissionPauseCount > 0) {
    ws.close(ROOM_CLOSING_CLOSE_CODE, 'Project metadata update in progress');
    return;
  }
  if (closingDocumentIds.has(documentId)) {
    ws.close(ROOM_CLOSING_CLOSE_CODE, ROOM_CLOSING_CLOSE_REASON);
    return;
  }

  if (!DOCUMENT_ID_PATTERN.test(documentId)) {
    ws.close(1008, 'Unknown document');
    return;
  }

  const clientId = requestUrl.searchParams.get('clientId');
  let file;

  try {
    file = await File.findOne({ documentId });
    if (!file) {
      ws.close(1008, 'Unknown document');
      return;
    }
    await resolveFileIdentity(file);
    if (!req.auth || req.auth.workspaceId !== WORKSPACE_ID) {
      ws.close(1008, 'Workspace access denied');
      return;
    }
    if (roomAdmissionPauseCount > 0 || closingRooms.has(file.name) || closingDocumentIds.has(documentId)) {
      ws.close(ROOM_CLOSING_CLOSE_CODE, ROOM_CLOSING_CLOSE_REASON);
      return;
    }
    if (await FileTombstone.findOne({ documentId }) || await FileTombstone.findOne({ path: file.name })) {
      ws.close(FILE_DELETED_CLOSE_CODE, FILE_DELETED_CLOSE_REASON);
      return;
    }
  } catch {
    ws.close(1011, 'Room state unavailable');
    return;
  }
  if (roomAdmissionPauseCount > 0 || closingRooms.has(file.name) || closingDocumentIds.has(documentId)) {
    ws.close(ROOM_CLOSING_CLOSE_CODE, ROOM_CLOSING_CLOSE_REASON);
    return;
  }

  const existingError = yjsPersistence.getRoomError(documentId);
  if (existingError) {
    ws.close(1011, 'Document history unavailable');
    return;
  }

  // getYDoc invokes bindState synchronously. Load the room before setupWSConnection
  // so an invalid history can be rejected before y-websocket sends sync traffic.
  try {
    yUtils.getYDoc(documentId);
  } catch (error) {
    const reason = yjsPersistence.getRoomError(documentId);
    console.error(`Yjs room ${encodeURIComponent(documentId).slice(0, 120)} unavailable (${reason?.code || 'history_load_failed'})`);
    ws.close(1011, 'Document history unavailable');
    return;
  }

  try {
    const admitted = await authentication.withActiveIdentity(req.auth, () => {
      // This callback is synchronous and runs under the same lifecycle queue as
      // logout and account disabling. Registration therefore happens wholly
      // before revocation (which will close it) or wholly after it (which fails).
      if (roomAdmissionPauseCount > 0 || closingRooms.has(file.name) || closingDocumentIds.has(documentId)) {
        ws.close(ROOM_CLOSING_CLOSE_CODE, ROOM_CLOSING_CLOSE_REASON);
        return false;
      }
      const connection = trackRoomConnection(documentId, ws, clientId, req.auth.userId);
      connection.releaseAuth = registerAuthenticatedConnection(req.auth, reason => ws.close(1008, reason));
      ws.once('close', () => connection.releaseAuth());
      try {
        setupWSConnection(ws, req);
        return true;
      } catch {
        ws.close(1011, 'Room setup failed');
        return false;
      }
    });
    if (!admitted && ws.readyState === ws.OPEN) ws.close(1008, 'WebSocket authentication required');
  } catch {
    ws.close(1011, 'WebSocket authorization unavailable');
  }
});

mongoose.connect(process.env.MONGODB_URI)
  .then(async () => {
    await authentication.initialize();
    const count = await File.countDocuments();
    if (count === 0) {
      await File.insertMany([
        { name: 'script.js', language: 'javascript', documentId: crypto.randomUUID(), historyKey: 'script.js' },
        { name: 'style.css', language: 'css', documentId: crypto.randomUUID(), historyKey: 'style.css' },
        { name: 'index.html', language: 'html', documentId: crypto.randomUUID(), historyKey: 'index.html' },
      ]);
      console.log('✅ Seeded default files');
    }
  })
  .then(() => {
    server.listen(PORT, BACKEND_BIND_HOST, () => {
      console.log(`🚀 API & WebSocket Server is running at http://${BACKEND_BIND_HOST}:${PORT}`);
    });
  })
  .catch(error => {
    // Report the bootstrap conflict without logging configured usernames,
    // passwords, database contents, or underlying storage errors.
    if (error?.code === 'BOOTSTRAP_ADMIN_CONFLICT') {
      console.error('Backend startup blocked: configured bootstrap administrator conflicts with an existing account.');
    } else {
      console.error('Backend startup blocked: storage or authentication configuration could not be initialized.');
    }
    process.exitCode = 1;
  });
