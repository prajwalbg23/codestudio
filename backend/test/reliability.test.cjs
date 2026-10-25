const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');
const { encodeUpdateFrame, YJS_LOG_MAGIC } = require('../yjsPersistence');

const backendDir = path.resolve(__dirname, '..');
const repoDir = path.resolve(backendDir, '..');
const serverPath = path.join(backendDir, 'server.js');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codestudio-reliability-'));
const frontendDir = path.join(repoDir, 'frontend');
const Y = require(require.resolve('yjs', { paths: [frontendDir] }));
const { WebsocketProvider } = require(require.resolve('y-websocket', { paths: [frontendDir] }));
const WebSocket = require(require.resolve('ws', { paths: [backendDir] }));

let port;
let serverProcess;
const providers = new Set();
const documentIdsByPath = new Map();
const historyKeysByPath = new Map();

function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { ...options, agent: false }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        let parsed;
        try { parsed = JSON.parse(body); } catch { parsed = undefined; }
        const requestUrl = new URL(url);
        if (parsed?.file?.documentId && parsed?.file?.name) {
          documentIdsByPath.set(parsed.file.name, parsed.file.documentId);
          historyKeysByPath.set(parsed.file.name, parsed.file.historyKey || parsed.file.documentId);
        } else if (parsed?.documentId && requestUrl.pathname.startsWith('/api/files/')) {
          const filePath = decodeURIComponent(requestUrl.pathname.slice('/api/files/'.length));
          if (!filePath.includes('/revisions/')) {
            documentIdsByPath.set(filePath, parsed.documentId);
            const dbPath = path.join(dataDir, 'db.json');
            if (fs.existsSync(dbPath)) {
              const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
              const file = db.files.find(record => record.name === filePath);
              if (file) historyKeysByPath.set(filePath, file.historyKey);
            }
            if (!historyKeysByPath.has(filePath)) historyKeysByPath.set(filePath, filePath);
          }
        }
        resolve({
          status: response.statusCode,
          ok: response.statusCode >= 200 && response.statusCode < 300,
          headers: response.headers,
          json: async () => parsed,
        });
      });
    });
    req.once('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

function openProjectEventStream() {
  let resolveEvent;
  let rejectEvent;
  let resolveConnected;
  const event = new Promise((resolve, reject) => { resolveEvent = resolve; rejectEvent = reject; });
  const connected = new Promise(resolve => { resolveConnected = resolve; });
  const req = http.request(`http://127.0.0.1:${port}/api/project-events`, { agent: false }, response => {
    resolveConnected();
    let buffer = '';
    response.on('data', chunk => {
      buffer += chunk.toString();
      const match = buffer.match(/event: project-change\ndata: ([^\n]+)\n\n/);
      if (match) {
        try { resolveEvent(JSON.parse(match[1])); } catch (error) { rejectEvent(error); }
      }
    });
    response.on('error', rejectEvent);
  });
  req.once('error', rejectEvent);
  req.end();
  return { connected, event, close: () => req.destroy() };
}

async function findFreePort() {
  const socket = net.createServer();
  await new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', resolve);
  });
  const { port: availablePort } = socket.address();
  await new Promise((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
  return availablePort;
}

function waitForExit(child, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Backend did not exit before timeout')), timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

async function stopServer() {
  if (!serverProcess || serverProcess.exitCode !== null) return serverProcess?.exitCode;
  const child = serverProcess;
  const exited = waitForExit(child);
  child.kill();
  const result = await exited;
  serverProcess = undefined;
  return result.code;
}

async function startServer() {
  serverProcess = spawn(process.execPath, [serverPath], {
    cwd: dataDir,
    env: {
      ...process.env,
      PORT: String(port),
      CODESTUDIO_DATA_DIR: dataDir,
      MONGODB_URI: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let startupOutput = '';
  serverProcess.stdout.on('data', chunk => { startupOutput += chunk.toString(); });
  serverProcess.stderr.on('data', chunk => { startupOutput += chunk.toString(); });

  const deadline = Date.now() + 10000;
  let lastError;
  while (Date.now() < deadline) {
    if (serverProcess.exitCode !== null) {
      throw new Error(`Backend exited during startup with code ${serverProcess.exitCode}: ${startupOutput}`);
    }
    try {
      const response = await request(`http://127.0.0.1:${port}/api/files`);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Backend did not become ready: ${lastError?.cause?.code || lastError?.message || 'timeout'}. ${startupOutput}`);
}

function createProvider(room, doc = new Y.Doc(), clientId = crypto.randomUUID()) {
  class LocalOriginWebSocket extends WebSocket {
    constructor(url, protocols) {
      super(url, protocols, { origin: 'http://localhost:5173' });
    }
  }
  const documentId = documentIdsByPath.get(room) || room;
  const provider = new WebsocketProvider(`ws://127.0.0.1:${port}`, documentId, doc, {
    WebSocketPolyfill: LocalOriginWebSocket,
    params: { clientId },
    disableBc: true,
    maxBackoffTime: 500,
  });
  providers.add(provider);
  return { doc, provider, clientId };
}

function createRawSocket(room) {
  const documentId = documentIdsByPath.get(room) || room;
  return new WebSocket(`ws://127.0.0.1:${port}/${documentId}`, { origin: 'http://localhost:5173' });
}

function waitForSocketClose(socket, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    if (socket.readyState === WebSocket.CLOSED) return resolve({ code: 1006, reason: '' });
    const timer = setTimeout(() => {
      socket.off('close', onClose);
      reject(new Error('WebSocket did not close before timeout'));
    }, timeoutMs);
    const onClose = (code, reason) => {
      clearTimeout(timer);
      resolve({ code, reason: reason.toString() });
    };
    socket.once('close', onClose);
  });
}

async function deleteWhenDisconnected(room, clientId) {
  const url = `http://127.0.0.1:${port}/api/files/${encodeURIComponent(room)}${clientId ? `?clientId=${clientId}` : ''}`;
  const deadline = Date.now() + 3000;
  let response;
  while (Date.now() < deadline) {
    response = await request(url, { method: 'DELETE' });
    if (response.status !== 409 || (await response.json()).code !== 'file_in_use') return response;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return response;
}

function waitForSync(provider, timeoutMs = 5000) {
  if (provider.synced) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      provider.off('sync', onSync);
      reject(new Error('Yjs provider did not sync before timeout'));
    }, timeoutMs);
    const onSync = synced => {
      if (synced) {
        clearTimeout(timer);
        provider.off('sync', onSync);
        resolve();
      }
    };
    provider.on('sync', onSync);
  });
}

function waitForCloseCode(provider, expectedCode = 1011, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      provider.off('connection-close', onClose);
      reject(new Error(`WebSocket did not close with code ${expectedCode}`));
    }, timeoutMs);
    const onClose = event => {
      if (event && event.code === expectedCode) {
        clearTimeout(timer);
        provider.off('connection-close', onClose);
        resolve(event);
      }
    };
    provider.on('connection-close', onClose);
  });
}

function makeUpdates(text) {
  const doc = new Y.Doc();
  const updates = [];
  doc.on('update', update => updates.push(Buffer.from(update)));
  const ytext = doc.getText('monaco');
  ytext.insert(0, text);
  ytext.insert(ytext.length, '-next');
  doc.destroy();
  return updates;
}

function historyPath(room, extension) {
  const historyKey = historyKeysByPath.get(room) || room;
  return path.join(dataDir, 'yjs_db', `${encodeURIComponent(historyKey)}.${extension}`);
}

async function ensureTestFile(name) {
  if (documentIdsByPath.has(name)) return documentIdsByPath.get(name);
  const response = await request(`http://127.0.0.1:${port}/api/files`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }),
  });
  if (response.status !== 200) throw new Error(`Could not create isolated test file ${name}: ${response.status}`);
  return documentIdsByPath.get(name);
}

async function assertRoomUnavailable(room) {
  await ensureTestFile(room);
  const { provider } = createProvider(room);
  const closed = await waitForCloseCode(provider);
  assert.equal(closed.code, 1011);
  assert.equal(provider.synced, false);
  provider.destroy();
  providers.delete(provider);

  const health = await request(`http://127.0.0.1:${port}/api/files`);
  assert.equal(health.status, 200, 'HTTP API remains available after room load failure');
}

async function assertHealthyRoomCanCollaborate(room) {
  await ensureTestFile(room);
  const { doc: writer, provider: writerProvider } = createProvider(room);
  const { doc: observer, provider: observerProvider } = createProvider(room);
  await Promise.all([waitForSync(writerProvider), waitForSync(observerProvider)]);
  writer.getText('monaco').insert(0, 'healthy-room');
  await waitForText(observer, 'healthy-room');
}

async function waitForText(doc, expected, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (doc.getText('monaco').toString() === expected) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(doc.getText('monaco').toString(), expected);
}

async function waitForConvergence(docA, docB, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const textA = docA.getText('monaco').toString();
    const textB = docB.getText('monaco').toString();
    if (textA === textB && textA.includes('-A') && textA.includes('-B')) return textA;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(docA.getText('monaco').toString(), docB.getText('monaco').toString());
  assert.match(docA.getText('monaco').toString(), /^shared-(AB|BA)$/);
}

async function closeProviders() {
  for (const provider of providers) provider.destroy();
  providers.clear();
}

before(async () => {
  port = await findFreePort();
  await startServer();
});

after(async () => {
  await closeProviders();
  await stopServer();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('file and member APIs list, create, retrieve, reject invalid/duplicate data, and delete', async () => {
  const base = `http://127.0.0.1:${port}/api`;

  const initialFiles = await request(`${base}/files`);
  assert.equal(initialFiles.status, 200);
  assert.deepEqual(await initialFiles.json(), ['script.js', 'style.css', 'index.html']);

  const invalidFile = await request(`${base}/files`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
  });
  assert.equal(invalidFile.status, 400);
  assert.deepEqual(await invalidFile.json(), { error: 'Name is required' });

  const createFile = await request(`${base}/files`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'baseline.json' }),
  });
  assert.equal(createFile.status, 200);
  const createdFile = await createFile.json();
  assert.equal(createdFile.file.name, 'baseline.json');
  assert.equal(createdFile.file.language, 'json');

  const duplicateFile = await request(`${base}/files`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'baseline.json' }),
  });
  assert.equal(duplicateFile.status, 400);
  assert.deepEqual(await duplicateFile.json(), { error: 'File already exists' });

  const fileMetadata = await request(`${base}/files/baseline.json`);
  assert.equal(fileMetadata.status, 200);
  assert.equal((await fileMetadata.json()).language, 'json');

  const invalidMember = await request(`${base}/members`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'baseline' }),
  });
  assert.equal(invalidMember.status, 400);

  const createMember = await request(`${base}/members`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'baseline-member', color: '#123456' }),
  });
  assert.equal(createMember.status, 200);
  const createdMember = await createMember.json();
  assert.equal(createdMember.member.name, 'baseline-member');

  const listMembers = await request(`${base}/members`);
  assert.equal(listMembers.status, 200);
  assert.ok((await listMembers.json()).some(member => member._id === createdMember.member._id));

  const duplicateMember = await request(`${base}/members`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'baseline-member', color: '#abcdef' }),
  });
  assert.equal(duplicateMember.status, 400);
  assert.deepEqual(await duplicateMember.json(), { error: 'Member already exists' });

  const deleteFile = await request(`${base}/files/baseline.json`, { method: 'DELETE' });
  assert.equal(deleteFile.status, 200);
  assert.deepEqual(await deleteFile.json(), { message: 'File deleted successfully' });
  const missingFile = await request(`${base}/files/baseline.json`);
  assert.equal(missingFile.status, 404);

  const deleteMember = await request(`${base}/members/${createdMember.member._id}`, { method: 'DELETE' });
  assert.equal(deleteMember.status, 200);
  assert.deepEqual(await deleteMember.json(), { message: 'Member deleted successfully' });
});

test('file creation detects the six supported languages, case-insensitively, and honors valid metadata', async () => {
  const cases = [
    ['LanguageJava.java', 'java'],
    ['LanguageC.c', 'c'],
    ['LanguagePython.py', 'python'],
    ['LanguageHtml.html', 'html'],
    ['LanguageHtmlAlias.htm', 'html'],
    ['LanguageCss.css', 'css'],
    ['LanguageJs.js', 'javascript'],
    ['LanguageJsx.jsx', 'javascript'],
    ['LanguageMjs.mjs', 'javascript'],
    ['LanguageCjs.cjs', 'javascript'],
    ['LanguageUpper.JAVA', 'java'],
    ['LanguageUpper.C', 'c'],
    ['LanguageUpper.PY', 'python'],
    ['LanguageUpper.HTM', 'html'],
    ['LanguageUpper.CSS', 'css'],
    ['LanguageUpper.JSX', 'javascript'],
  ];

  for (const [name, expectedLanguage] of cases) {
    const response = await request(`http://127.0.0.1:${port}/api/files`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }),
    });
    assert.equal(response.status, 200, name);
    assert.equal((await response.json()).file.language, expectedLanguage, name);
  }

  const explicit = await request(`http://127.0.0.1:${port}/api/files`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'ExplicitLanguage.java', language: 'python' }),
  });
  const explicitFile = (await explicit.json()).file;
  assert.equal(explicitFile.language, 'python');
  assert.equal(explicitFile.languageSource, 'explicit');

  const invalid = await request(`http://127.0.0.1:${port}/api/files`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'InvalidMetadata.PY', language: 'not-a-language' }),
  });
  assert.equal((await invalid.json()).file.language, 'python');

  const uppercaseMetadata = await request(`http://127.0.0.1:${port}/api/files`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'ExplicitMetadata.py', language: 'Java' }),
  });
  assert.equal((await uppercaseMetadata.json()).file.language, 'Java');

  const explicitJavaScript = await request(`http://127.0.0.1:${port}/api/files`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'ExplicitJavaScript.py', language: 'javascript' }),
  });
  assert.equal((await explicitJavaScript.json()).file.language, 'javascript');
});

test('legacy default JavaScript metadata is inferred while adopting document identity', async () => {
  const dbPath = path.join(dataDir, 'db.json');
  const originalBytes = fs.readFileSync(dbPath);
  const db = JSON.parse(originalBytes.toString('utf8'));
  db.files.push({ _id: 'legacy-language-record', name: 'legacy-language.py', language: 'javascript' });
  const seededBytes = Buffer.from(JSON.stringify(db, null, 2));
  fs.writeFileSync(dbPath, seededBytes);

  const response = await request(`http://127.0.0.1:${port}/api/files/legacy-language.py`);
  assert.equal(response.status, 200);
  const metadata = await response.json();
  assert.equal(metadata.language, 'python');
  assert.match(metadata.documentId, /^[\da-f-]{36}$/i);
  const adoptedDb = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
  const adopted = adoptedDb.files.find(file => file.name === 'legacy-language.py');
  assert.equal(adopted.documentId, metadata.documentId);
  assert.equal(adopted.historyKey, 'legacy-language.py');
  assert.notDeepEqual(fs.readFileSync(dbPath), seededBytes, 'metadata adoption persists document identity');
  assert.equal(fs.existsSync(historyPath('legacy-language.py', 'ylog')), false, 'adoption does not create or rewrite history');
});

test('legacy file adoption keeps its path-keyed history bytes and revision identifier unchanged', async () => {
  const name = 'legacy-identity.py';
  const created = await request(`http://127.0.0.1:${port}/api/files`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }),
  });
  assert.equal(created.status, 200);

  const dbPath = path.join(dataDir, 'db.json');
  const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
  const record = db.files.find(file => file.name === name);
  delete record.documentId;
  delete record.historyKey;
  fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
  documentIdsByPath.delete(name);
  historyKeysByPath.delete(name);

  const update = makeUpdates('legacy contents')[0];
  const originalHistory = Buffer.concat([YJS_LOG_MAGIC, encodeUpdateFrame(update)]);
  const originalHistoryPath = path.join(dataDir, 'yjs_db', `${encodeURIComponent(name)}.ylog`);
  fs.writeFileSync(originalHistoryPath, originalHistory);
  const expectedHasher = crypto.createHash('sha256').update(name).update(Buffer.from([0])).update(YJS_LOG_MAGIC);
  expectedHasher.update(encodeUpdateFrame(update));
  const expectedRevisionId = `yrev1_${expectedHasher.digest('hex')}`;

  const metadataResponse = await request(`http://127.0.0.1:${port}/api/files/${encodeURIComponent(name)}`);
  assert.equal(metadataResponse.status, 200);
  const metadata = await metadataResponse.json();
  assert.equal(metadata.documentId, documentIdsByPath.get(name));
  assert.deepEqual(fs.readFileSync(originalHistoryPath), originalHistory);

  const revisionResponse = await request(`http://127.0.0.1:${port}/api/files/${encodeURIComponent(name)}/revisions/latest`);
  assert.equal(revisionResponse.status, 200);
  const revision = await revisionResponse.json();
  assert.equal(revision.revisionId, expectedRevisionId);
  assert.equal(revision.sourceHash, crypto.createHash('sha256').update('legacy contents').digest('hex'));
  assert.deepEqual(fs.readFileSync(originalHistoryPath), originalHistory);
});

test('folders and nested files validate paths, reject collisions, and keep room revisions stable after restart', async () => {
  const api = `http://127.0.0.1:${port}/api`;
  const createFolder = path => request(`${api}/folders`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }),
  });
  const createFile = name => request(`${api}/files`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }),
  });

  for (const invalidPath of ['', '/absolute', '../escape.js', 'src/../escape.js', 'src//empty.py', './file.js', 'C:/outside.js', 'src\\file.py', 'trailing.']) {
    const invalidFile = await createFile(invalidPath);
    assert.equal(invalidFile.status, 400, `reject file path ${JSON.stringify(invalidPath)}`);
    if (invalidPath === '') assert.deepEqual(await invalidFile.json(), { error: 'Name is required' });
    const invalidFolder = await createFolder(invalidPath);
    assert.equal(invalidFolder.status, 400, `reject folder path ${JSON.stringify(invalidPath)}`);
  }

  const topFolder = await createFolder('milestone-3b');
  assert.equal(topFolder.status, 200);
  const nestedFolder = await createFolder('milestone-3b/src');
  assert.equal(nestedFolder.status, 200);
  assert.equal((await createFolder('milestone-3b/empty')).status, 200);
  assert.equal((await createFolder('milestone-3b/src')).status, 400);
  assert.equal((await createFolder('milestone-3b/missing/child')).status, 400);

  const room = 'milestone-3b/src/Main.JAVA';
  const nestedFile = await createFile(room);
  assert.equal(nestedFile.status, 200);
  const nestedFileRecord = (await nestedFile.json()).file;
  assert.equal(nestedFileRecord.language, 'java');
  assert.match(nestedFileRecord.documentId, /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i);
  const nestedFileStore = JSON.parse(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8'));
  assert.equal(nestedFileStore.files.find(file => file.name === room).historyKey, nestedFileRecord.documentId);
  assert.equal((await createFile(room)).status, 400);
  assert.equal((await createFile('milestone-3b/missing/file.js')).status, 400);
  assert.equal((await createFile('milestone-3b/src')).status, 400, 'a file cannot replace a folder');
  assert.equal((await createFolder(room)).status, 400, 'a folder cannot replace a file');

  const blockedParent = await createFile('blocked-parent');
  assert.equal(blockedParent.status, 200);
  assert.equal((await createFolder('blocked-parent/child')).status, 400);
  assert.equal((await createFile('blocked-parent/child.js')).status, 400);

  const concurrentPath = 'milestone-3b/src/single-create.c';
  const concurrentCreates = await Promise.all([createFile(concurrentPath), createFile(concurrentPath)]);
  assert.deepEqual(concurrentCreates.map(response => response.status).sort(), [200, 400]);

  const foldersBeforeRestart = await request(`${api}/folders`);
  assert.deepEqual(await foldersBeforeRestart.json(), ['milestone-3b', 'milestone-3b/empty', 'milestone-3b/src']);
  const filesBeforeRestart = await request(`${api}/files`);
  assert.ok((await filesBeforeRestart.json()).includes(room));

  const { doc, provider } = createProvider(room);
  const { doc: observer, provider: observerProvider } = createProvider(room);
  await Promise.all([waitForSync(provider), waitForSync(observerProvider)]);
  doc.getText('monaco').insert(0, 'nested room survives');
  await waitForText(observer, 'nested room survives');

  const encodedRoom = encodeURIComponent(room);
  const latestBeforeRestart = await request(`${api}/files/${encodedRoom}/revisions/latest`);
  assert.equal(latestBeforeRestart.status, 200);
  const revision = await latestBeforeRestart.json();
  assert.equal(revision.sourceHash, crypto.createHash('sha256').update('nested room survives').digest('hex'));

  await closeProviders();
  await stopServer();
  await startServer();

  const foldersAfterRestart = await request(`${api}/folders`);
  assert.deepEqual(await foldersAfterRestart.json(), ['milestone-3b', 'milestone-3b/empty', 'milestone-3b/src']);
  const filesAfterRestart = await request(`${api}/files`);
  assert.ok((await filesAfterRestart.json()).includes(room));
  const metadataAfterRestart = await request(`${api}/files/${encodedRoom}`);
  assert.equal(metadataAfterRestart.status, 200);
  assert.equal((await metadataAfterRestart.json()).language, 'java');
  const latestAfterRestart = await request(`${api}/files/${encodedRoom}/revisions/latest`);
  assert.equal(latestAfterRestart.status, 200);
  assert.deepEqual(await latestAfterRestart.json(), revision);
  const specificRevision = await request(`${api}/files/${encodedRoom}/revisions/${revision.revisionId}`);
  assert.equal(specificRevision.status, 200);
  assert.deepEqual(await specificRevision.json(), revision);
});

test('file rename preserves identity, history, revisions, and keeps the renamed room live', async () => {
  const oldPath = 'phase2-rename-source.js';
  const newPath = 'phase2-rename-target.js';
  const created = await request(`http://127.0.0.1:${port}/api/files`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: oldPath }),
  });
  assert.equal(created.status, 200);
  const { documentId } = (await created.json()).file;
  const { doc, provider } = createProvider(oldPath);
  await waitForSync(provider);
  doc.getText('monaco').insert(0, 'rename keeps this Yjs document');
  const revisionResponse = await request(`http://127.0.0.1:${port}/api/files/${encodeURIComponent(oldPath)}/revisions/latest`);
  assert.equal(revisionResponse.status, 200);
  const revisionBefore = await revisionResponse.json();
  const dbBefore = JSON.parse(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8'));
  const originalFile = dbBefore.files.find(file => file.name === oldPath);
  const oldHistoryPath = historyPath(oldPath, 'ylog');
  const originalHistory = fs.readFileSync(oldHistoryPath);
  const tombstoneCount = dbBefore.filetombstones.length;
  const projectEvents = openProjectEventStream();
  await projectEvents.connected;

  const renamed = await request(`http://127.0.0.1:${port}/api/files/rename`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ oldPath, newPath }),
  });
  assert.equal(renamed.status, 200);
  const renameBody = await renamed.json();
  assert.deepEqual(renameBody.file, { name: newPath, documentId, language: 'javascript' });
  assert.deepEqual(await projectEvents.event, {
    type: 'rename',
    files: [{ documentId, oldPath, newPath, language: 'javascript' }],
    folders: [],
  });
  projectEvents.close();
  const resolvedDocument = await request(`http://127.0.0.1:${port}/api/documents/${documentId}`);
  assert.equal(resolvedDocument.status, 200);
  assert.deepEqual(await resolvedDocument.json(), { documentId, name: newPath, language: 'javascript' });
  const reconnectingClient = createRawSocket(documentId);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Document-ID room did not accept reconnect after rename')), 3000);
    reconnectingClient.once('open', () => { clearTimeout(timer); resolve(); });
    reconnectingClient.once('error', error => { clearTimeout(timer); reject(error); });
  });
  reconnectingClient.close();
  assert.equal(doc.getText('monaco').toString(), 'rename keeps this Yjs document');

  const dbAfter = JSON.parse(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8'));
  const renamedFile = dbAfter.files.find(file => file.name === newPath);
  assert.equal(renamedFile.documentId, originalFile.documentId);
  assert.equal(renamedFile.historyKey, originalFile.historyKey);
  assert.equal(dbAfter.filetombstones.length, tombstoneCount, 'a live rename does not create a tombstone');
  assert.deepEqual(fs.readFileSync(oldHistoryPath), originalHistory);

  const currentRevisionResponse = await request(`http://127.0.0.1:${port}/api/files/${encodeURIComponent(newPath)}/revisions/latest`);
  assert.equal(currentRevisionResponse.status, 200);
  assert.deepEqual(await currentRevisionResponse.json(), revisionBefore);
  const idRevisionResponse = await request(`http://127.0.0.1:${port}/api/documents/${documentId}/revisions/${revisionBefore.revisionId}`);
  assert.equal(idRevisionResponse.status, 200);
  assert.deepEqual(await idRevisionResponse.json(), revisionBefore);

  const reuseOldPath = await request(`http://127.0.0.1:${port}/api/files`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: oldPath }),
  });
  assert.equal(reuseOldPath.status, 200);
  const replacementId = (await reuseOldPath.json()).file.documentId;
  assert.notEqual(replacementId, documentId);
  const { doc: replacementDoc, provider: replacementProvider } = createProvider(oldPath);
  await waitForSync(replacementProvider);
  assert.equal(replacementDoc.getText('monaco').toString(), '', 'the reused path opens a new empty document');
  assert.equal(doc.getText('monaco').toString(), 'rename keeps this Yjs document');
  await closeProviders();

  const legacyPath = 'phase2-legacy-rename.py';
  const legacyTarget = 'phase2-legacy-renamed.py';
  const legacyCreated = await request(`http://127.0.0.1:${port}/api/files`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: legacyPath }),
  });
  assert.equal(legacyCreated.status, 200);
  const legacyDbPath = path.join(dataDir, 'db.json');
  const legacyDb = JSON.parse(fs.readFileSync(legacyDbPath, 'utf8'));
  const legacyRecord = legacyDb.files.find(file => file.name === legacyPath);
  delete legacyRecord.documentId;
  delete legacyRecord.historyKey;
  fs.writeFileSync(legacyDbPath, JSON.stringify(legacyDb, null, 2));
  documentIdsByPath.delete(legacyPath);
  historyKeysByPath.delete(legacyPath);
  const legacyUpdate = makeUpdates('legacy revision continuity')[0];
  const legacyHistoryPath = path.join(dataDir, 'yjs_db', `${encodeURIComponent(legacyPath)}.ylog`);
  const legacyBytes = Buffer.concat([YJS_LOG_MAGIC, encodeUpdateFrame(legacyUpdate)]);
  fs.writeFileSync(legacyHistoryPath, legacyBytes);
  const adoptedMetadata = await request(`http://127.0.0.1:${port}/api/files/${encodeURIComponent(legacyPath)}`);
  assert.equal(adoptedMetadata.status, 200);
  const adoptedDocumentId = (await adoptedMetadata.json()).documentId;
  const legacyRevisionResponse = await request(`http://127.0.0.1:${port}/api/files/${encodeURIComponent(legacyPath)}/revisions/latest`);
  assert.equal(legacyRevisionResponse.status, 200);
  const legacyRevision = await legacyRevisionResponse.json();
  const legacyRename = await request(`http://127.0.0.1:${port}/api/files/rename`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ oldPath: legacyPath, newPath: legacyTarget }),
  });
  assert.equal(legacyRename.status, 200);
  const legacyRevisionAfterRename = await request(`http://127.0.0.1:${port}/api/files/${encodeURIComponent(legacyTarget)}/revisions/latest`);
  assert.equal(legacyRevisionAfterRename.status, 200);
  assert.deepEqual(await legacyRevisionAfterRename.json(), legacyRevision);
  assert.deepEqual(fs.readFileSync(legacyHistoryPath), legacyBytes);
  const legacyIdentityAfterRename = JSON.parse(fs.readFileSync(legacyDbPath, 'utf8')).files.find(file => file.name === legacyTarget);
  assert.equal(legacyIdentityAfterRename.documentId, adoptedDocumentId);
  assert.equal(legacyIdentityAfterRename.historyKey, legacyPath);
});

test('nested folder rename updates all descendant paths and remaps tombstone reservations without changing identities', async () => {
  const oldRoot = 'phase2-tree-old';
  const newRoot = 'phase2-tree-new';
  for (const folderPath of [oldRoot, `${oldRoot}/nested`]) {
    const response = await request(`http://127.0.0.1:${port}/api/folders`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: folderPath }),
    });
    assert.equal(response.status, 200);
  }
  const paths = [`${oldRoot}/main.py`, `${oldRoot}/nested/lib.js`, `${oldRoot}/nested/deleted.js`];
  for (const name of paths) {
    const response = await request(`http://127.0.0.1:${port}/api/files`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }),
    });
    assert.equal(response.status, 200);
  }
  const deletedPath = paths[2];
  const { doc: deletedDoc, provider: deletedProvider } = createProvider(deletedPath);
  await waitForSync(deletedProvider);
  deletedDoc.getText('monaco').insert(0, 'history follows tombstone');
  const deletedRevisionResponse = await request(`http://127.0.0.1:${port}/api/files/${encodeURIComponent(deletedPath)}/revisions/latest`);
  assert.equal(deletedRevisionResponse.status, 200);
  const deletedRevision = await deletedRevisionResponse.json();
  await closeProviders();
  assert.equal((await deleteWhenDisconnected(deletedPath)).status, 200);

  const before = JSON.parse(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8'));
  const filesBefore = new Map(before.files.filter(file => file.name.startsWith(`${oldRoot}/`))
    .map(file => [file.name, { documentId: file.documentId, historyKey: file.historyKey }]));
  const tombstoneBefore = before.filetombstones.find(record => record.path === deletedPath);
  const rename = await request(`http://127.0.0.1:${port}/api/folders/rename`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ oldPath: oldRoot, newPath: newRoot }),
  });
  assert.equal(rename.status, 200);
  assert.deepEqual(await rename.json(), {
    message: 'Folder renamed successfully', folder: { path: newRoot },
    updatedFiles: 3, updatedFolders: 2, updatedTombstones: 1,
    renamedFiles: paths.map(oldPath => ({
      documentId: before.files.find(file => file.name === oldPath).documentId,
      oldPath,
      newPath: oldPath.replace(oldRoot, newRoot),
      language: before.files.find(file => file.name === oldPath).language,
    })),
    renamedFolders: [oldRoot, `${oldRoot}/nested`].map(oldPath => ({
      oldPath,
      newPath: oldPath.replace(oldRoot, newRoot),
    })),
  });

  const files = await (await request(`http://127.0.0.1:${port}/api/files`)).json();
  assert.ok(files.includes(`${newRoot}/main.py`));
  assert.ok(files.includes(`${newRoot}/nested/lib.js`));
  assert.equal(files.includes(deletedPath), false);
  const folders = await (await request(`http://127.0.0.1:${port}/api/folders`)).json();
  assert.ok(folders.includes(newRoot));
  assert.ok(folders.includes(`${newRoot}/nested`));
  assert.equal(folders.some(folder => folder.startsWith(`${oldRoot}/`) || folder === oldRoot), false);

  const after = JSON.parse(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8'));
  for (const [oldPath, identity] of filesBefore) {
    const newPath = oldPath.replace(oldRoot, newRoot);
    const record = after.files.find(file => file.name === newPath);
    assert.ok(record, `renamed file record ${newPath} exists`);
    assert.deepEqual({ documentId: record.documentId, historyKey: record.historyKey }, identity);
  }
  const movedTombstone = after.filetombstones.find(record => record.path === deletedPath.replace(oldRoot, newRoot));
  assert.equal(movedTombstone.documentId, tombstoneBefore.documentId);
  const reservedCreate = await request(`http://127.0.0.1:${port}/api/files`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: deletedPath.replace(oldRoot, newRoot) }),
  });
  assert.equal(reservedCreate.status, 409);

  const revisionByDocument = await request(`http://127.0.0.1:${port}/api/documents/${tombstoneBefore.documentId}/revisions/${deletedRevision.revisionId}`);
  assert.equal(revisionByDocument.status, 200);
  assert.deepEqual(await revisionByDocument.json(), deletedRevision);
});

test('empty-folder deletion publishes a project event and persists across backend restart', async () => {
  const folderPath = 'phase4-empty-folder';
  const created = await request(`http://127.0.0.1:${port}/api/folders`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: folderPath }),
  });
  assert.equal(created.status, 200);

  const projectEvents = openProjectEventStream();
  await projectEvents.connected;
  const deleted = await request(`http://127.0.0.1:${port}/api/folders/${encodeURIComponent(folderPath)}`, { method: 'DELETE' });
  assert.equal(deleted.status, 200);
  assert.deepEqual(await deleted.json(), { message: 'Folder deleted successfully', folder: { path: folderPath } });
  assert.deepEqual(await projectEvents.event, {
    type: 'folder-deleted', folder: { path: folderPath },
  });
  projectEvents.close();

  const folderList = await request(`http://127.0.0.1:${port}/api/folders`);
  assert.equal((await folderList.json()).includes(folderPath), false);
  await stopServer();
  await startServer();
  const foldersAfterRestart = await request(`http://127.0.0.1:${port}/api/folders`);
  assert.equal((await foldersAfterRestart.json()).includes(folderPath), false);
});

test('non-empty and invalid folder deletion are rejected without changing project metadata', async () => {
  const folderPath = 'phase4-nonempty';
  for (const path of [folderPath, `${folderPath}/child`]) {
    const created = await request(`http://127.0.0.1:${port}/api/folders`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }),
    });
    assert.equal(created.status, 200);
  }
  const fileCreated = await request(`http://127.0.0.1:${port}/api/files`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: `${folderPath}/live.js` }),
  });
  assert.equal(fileCreated.status, 200);
  const dbPath = path.join(dataDir, 'db.json');
  const before = fs.readFileSync(dbPath);
  const deleted = await request(`http://127.0.0.1:${port}/api/folders/${encodeURIComponent(folderPath)}`, { method: 'DELETE' });
  assert.equal(deleted.status, 409);
  assert.equal((await deleted.json()).code, 'folder_not_empty');
  assert.deepEqual(fs.readFileSync(dbPath), before);

  const invalid = await request(`http://127.0.0.1:${port}/api/folders/${encodeURIComponent('../escape')}`, { method: 'DELETE' });
  assert.equal(invalid.status, 400);
  assert.deepEqual(fs.readFileSync(dbPath), before);
});

test('renamed folder with only tombstoned files can be removed without losing reservations or revisions', async () => {
  const parent = 'phase4-tombstone-parent';
  const originalLeaf = `${parent}/old-leaf`;
  const renamedLeaf = `${parent}/renamed-leaf`;
  for (const folderPath of [parent, originalLeaf]) {
    const response = await request(`http://127.0.0.1:${port}/api/folders`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: folderPath }),
    });
    assert.equal(response.status, 200);
  }
  const filePath = `${originalLeaf}/deleted.js`;
  const fileCreated = await request(`http://127.0.0.1:${port}/api/files`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: filePath }),
  });
  assert.equal(fileCreated.status, 200);
  const documentId = (await fileCreated.json()).file.documentId;
  const { doc, provider } = createProvider(filePath);
  await waitForSync(provider);
  const source = 'retained tombstoned history';
  doc.getText('monaco').insert(0, source);
  const revisionResponse = await request(`http://127.0.0.1:${port}/api/documents/${documentId}/revisions/latest`);
  assert.equal(revisionResponse.status, 200);
  const revision = await revisionResponse.json();
  const historyFile = historyPath(filePath, 'ylog');
  const originalHistoryBytes = fs.readFileSync(historyFile);
  await closeProviders();
  assert.equal((await deleteWhenDisconnected(filePath)).status, 200);

  const rename = await request(`http://127.0.0.1:${port}/api/folders/rename`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ oldPath: originalLeaf, newPath: renamedLeaf }),
  });
  assert.equal(rename.status, 200);
  const tombstonedPath = `${renamedLeaf}/deleted.js`;
  const dbBeforeFolderDelete = JSON.parse(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8'));
  const retainedFile = dbBeforeFolderDelete.files.find(file => file.documentId === documentId);
  const retainedTombstone = dbBeforeFolderDelete.filetombstones.find(record => record.documentId === documentId);
  const projectEvents = openProjectEventStream();
  await projectEvents.connected;

  const deletedLeaf = await request(`http://127.0.0.1:${port}/api/folders/${encodeURIComponent(renamedLeaf)}`, { method: 'DELETE' });
  assert.equal(deletedLeaf.status, 200);
  assert.deepEqual(await projectEvents.event, { type: 'folder-deleted', folder: { path: renamedLeaf } });
  projectEvents.close();
  const deletedParent = await request(`http://127.0.0.1:${port}/api/folders/${encodeURIComponent(parent)}`, { method: 'DELETE' });
  assert.equal(deletedParent.status, 200, 'tombstones beneath the folder do not make it non-empty');

  const recreateParent = await request(`http://127.0.0.1:${port}/api/folders`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: parent }),
  });
  assert.equal(recreateParent.status, 200, 'a tombstone does not reserve its ancestor folder path');
  const recreateLeaf = await request(`http://127.0.0.1:${port}/api/folders`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: renamedLeaf }),
  });
  assert.equal(recreateLeaf.status, 200, 'a tombstone does not reserve the deleted folder path');
  const sibling = await request(`http://127.0.0.1:${port}/api/folders`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: `${parent}/sibling` }),
  });
  assert.equal(sibling.status, 200);
  const reservedFile = await request(`http://127.0.0.1:${port}/api/files`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: tombstonedPath }),
  });
  assert.equal(reservedFile.status, 409, 'the exact tombstoned file path remains reserved');

  const dbAfter = JSON.parse(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8'));
  assert.deepEqual(dbAfter.files.find(file => file.documentId === documentId), { ...retainedFile, name: tombstonedPath });
  assert.deepEqual(dbAfter.filetombstones.find(record => record.documentId === documentId), retainedTombstone);
  assert.deepEqual(fs.readFileSync(historyFile), originalHistoryBytes);
  await stopServer();
  await startServer();
  assert.deepEqual(fs.readFileSync(historyFile), originalHistoryBytes);
  const afterRestartRevision = await request(`http://127.0.0.1:${port}/api/documents/${documentId}/revisions/${revision.revisionId}`);
  assert.equal(afterRestartRevision.status, 200);
  assert.deepEqual(await afterRestartRevision.json(), revision);
});

test('concurrent file creation and folder rename are serialized with empty-folder deletion', async () => {
  const createFolder = async folderPath => request(`http://127.0.0.1:${port}/api/folders`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: folderPath }),
  });
  const createRaceFolder = 'phase4-create-race';
  assert.equal((await createFolder(createRaceFolder)).status, 200);
  const [deleteOutcome, createOutcome] = await Promise.all([
    request(`http://127.0.0.1:${port}/api/folders/${encodeURIComponent(createRaceFolder)}`, { method: 'DELETE' }),
    request(`http://127.0.0.1:${port}/api/files`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: `${createRaceFolder}/late.js` }),
    }),
  ]);
  if (deleteOutcome.status === 200) {
    assert.equal(createOutcome.status, 400, 'creation after deletion sees the missing parent folder');
  } else {
    assert.equal(deleteOutcome.status, 409, 'deletion sees the file created first');
    assert.equal(createOutcome.status, 200);
  }

  const renameRaceParent = 'phase4-rename-race';
  const renameRaceChild = `${renameRaceParent}/child`;
  assert.equal((await createFolder(renameRaceParent)).status, 200);
  assert.equal((await createFolder(renameRaceChild)).status, 200);
  const [parentDelete, childRename] = await Promise.all([
    request(`http://127.0.0.1:${port}/api/folders/${encodeURIComponent(renameRaceParent)}`, { method: 'DELETE' }),
    request(`http://127.0.0.1:${port}/api/folders/rename`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ oldPath: renameRaceChild, newPath: 'phase4-renamed-child' }),
    }),
  ]);
  if (parentDelete.status === 200) {
    assert.equal(childRename.status, 400, 'rename after deletion cannot recreate a child under the missing parent');
  } else {
    assert.equal(parentDelete.status, 409, 'deletion sees the child folder if it is still present');
    assert.equal(childRename.status, 200);
  }
});

test('rename collisions and invalid paths leave every project metadata record unchanged', async () => {
  for (const name of ['phase2-collision-a.js', 'phase2-collision-b.js']) {
    const response = await request(`http://127.0.0.1:${port}/api/files`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }),
    });
    assert.equal(response.status, 200);
  }
  const folder = await request(`http://127.0.0.1:${port}/api/folders`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: 'phase2-collision-folder' }),
  });
  assert.equal(folder.status, 200);
  const snapshot = () => fs.readFileSync(path.join(dataDir, 'db.json'));
  const before = snapshot();

  const fileCollision = await request(`http://127.0.0.1:${port}/api/files/rename`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ oldPath: 'phase2-collision-a.js', newPath: 'phase2-collision-b.js' }),
  });
  assert.equal(fileCollision.status, 409);
  assert.deepEqual(snapshot(), before);

  const invalidFile = await request(`http://127.0.0.1:${port}/api/files/rename`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ oldPath: 'phase2-collision-a.js', newPath: '../escape.js' }),
  });
  assert.equal(invalidFile.status, 400);
  assert.deepEqual(snapshot(), before);

  const folderCollision = await request(`http://127.0.0.1:${port}/api/folders/rename`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ oldPath: 'phase2-collision-folder', newPath: 'phase2-collision-b.js' }),
  });
  assert.equal(folderCollision.status, 409);
  assert.deepEqual(snapshot(), before);

  const descendantMove = await request(`http://127.0.0.1:${port}/api/folders/rename`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ oldPath: 'phase2-collision-folder', newPath: 'phase2-collision-folder/child' }),
  });
  assert.equal(descendantMove.status, 400);
  assert.deepEqual(snapshot(), before);
});

test('a concurrent room join during folder rename retains the same document identity', async () => {
  const oldRoot = 'phase2-race-old';
  const filePath = `${oldRoot}/member.js`;
  for (const folderPath of [oldRoot]) {
    const response = await request(`http://127.0.0.1:${port}/api/folders`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: folderPath }),
    });
    assert.equal(response.status, 200);
  }
  const created = await request(`http://127.0.0.1:${port}/api/files`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: filePath }),
  });
  assert.equal(created.status, 200);
  const { documentId } = (await created.json()).file;
  const { doc, provider } = createProvider(filePath);
  await waitForSync(provider);
  doc.getText('monaco').insert(0, 'same ID across join race');

  const renamePromise = request(`http://127.0.0.1:${port}/api/folders/rename`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ oldPath: oldRoot, newPath: 'phase2-race-new' }),
  });
  const joiningSocket = createRawSocket(documentId);
  const outcomePromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Concurrent WebSocket join did not resolve')), 3000);
    joiningSocket.once('open', () => { clearTimeout(timer); resolve({ type: 'open' }); });
    joiningSocket.once('close', (code, reason) => { clearTimeout(timer); resolve({ type: 'close', code, reason: reason.toString() }); });
    joiningSocket.once('error', error => { clearTimeout(timer); reject(error); });
  });
  const renamed = await renamePromise;
  assert.equal(renamed.status, 200);
  const joinOutcome = await outcomePromise;
  if (joinOutcome.type === 'close') {
    assert.equal(joinOutcome.code, 1013);
    assert.equal(joinOutcome.reason, 'Project metadata update in progress');
    const retry = createRawSocket(documentId);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Room retry after rename did not open')), 3000);
      retry.once('open', () => { clearTimeout(timer); resolve(); });
      retry.once('error', reject);
    });
    retry.close();
  } else {
    joiningSocket.close();
  }
  assert.equal(doc.getText('monaco').toString(), 'same ID across join race');
  const metadata = await request(`http://127.0.0.1:${port}/api/files/${encodeURIComponent('phase2-race-new/member.js')}`);
  assert.equal((await metadata.json()).documentId, documentId);
  await closeProviders();
});

test('HTTP API accepts only configured browser origins', async () => {
  const url = `http://127.0.0.1:${port}/api/files`;
  const allowed = await request(url, { headers: { Origin: 'http://localhost:5173' } });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers['access-control-allow-origin'], 'http://localhost:5173');

  const previewAllowed = await request(url, { headers: { Origin: 'http://127.0.0.1:4173' } });
  assert.equal(previewAllowed.status, 200);
  assert.equal(previewAllowed.headers['access-control-allow-origin'], 'http://127.0.0.1:4173');

  const disallowed = await request(url, { headers: { Origin: 'http://localhost:9000' } });
  assert.equal(disallowed.status, 403);
  assert.deepEqual(await disallowed.json(), { error: 'Origin not allowed' });
  assert.equal(disallowed.headers['access-control-allow-origin'], undefined);
});

test('WebSocket upgrades accept configured dev and preview origins and reject others', async () => {
  const connect = origin => new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/origin-check`, { origin });
    socket.once('open', () => {
      socket.close();
      resolve({ status: 101 });
    });
    socket.once('unexpected-response', (requestObject, response) => {
      response.resume();
      resolve({ status: response.statusCode });
    });
    socket.once('error', error => reject(error));
  });

  assert.equal((await connect('http://127.0.0.1:5173')).status, 101);
  assert.equal((await connect('http://localhost:4173')).status, 101);
  assert.equal((await connect('http://example.invalid')).status, 401);
  assert.equal((await connect(undefined)).status, 401);
});

test('WebSocket room admission rejects unknown document IDs', async () => {
  const socket = createRawSocket(crypto.randomUUID());
  const closed = await waitForSocketClose(socket);
  assert.equal(closed.code, 1008);
  assert.equal(closed.reason, 'Unknown document');
});

test('project search scans Yjs text without changing persisted update history', async () => {
  const fileName = 'project-search.js';
  const created = await request(`http://localhost:${port}/api/files`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: fileName }),
  });
  assert.equal(created.status, 200);

  const { doc: writer, provider: writerProvider } = createProvider(fileName);
  const { doc: observer, provider: observerProvider } = createProvider(fileName);
  await Promise.all([waitForSync(writerProvider), waitForSync(observerProvider)]);
  const source = 'Needle one\nneedle-ish\nneedle two';
  writer.getText('monaco').insert(0, source);
  await waitForText(observer, source);
  const historyBefore = fs.readFileSync(historyPath(fileName, 'ylog'));

  const response = await request(`http://localhost:${port}/api/search`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'needle', wholeWord: true }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(result.results, [
    { fileName, lineNumber: 1, column: 1, snippet: 'Needle one' },
    { fileName, lineNumber: 2, column: 1, snippet: 'needle-ish' },
    { fileName, lineNumber: 3, column: 1, snippet: 'needle two' },
  ]);
  assert.deepEqual(result.unavailableFiles, []);
  assert.equal(result.truncated, false);
  assert.deepEqual(fs.readFileSync(historyPath(fileName, 'ylog')), historyBefore);

  const empty = await request(`http://localhost:${port}/api/search`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'no-such-code' }),
  });
  assert.deepEqual((await empty.json()).results, []);
});

test('project search reports unavailable rooms while returning healthy-file matches', async () => {
  const unavailableName = 'project-search-unavailable.js';
  const healthyName = 'project-search-healthy.js';
  for (const name of [unavailableName, healthyName]) {
    const created = await request(`http://localhost:${port}/api/files`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    assert.equal(created.status, 200);
  }

  const corruptBytes = Buffer.from('invalid-search-history');
  fs.writeFileSync(historyPath(unavailableName, 'ylog'), corruptBytes);
  const { doc: writer, provider: writerProvider } = createProvider(healthyName);
  const { doc: observer, provider: observerProvider } = createProvider(healthyName);
  await Promise.all([waitForSync(writerProvider), waitForSync(observerProvider)]);
  writer.getText('monaco').insert(0, 'needle remains searchable');
  await waitForText(observer, 'needle remains searchable');

  const response = await request(`http://localhost:${port}/api/search`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'needle' }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.ok(result.results.some(match => match.fileName === healthyName && match.lineNumber === 1));
  assert.ok(result.unavailableFiles.includes(unavailableName));
  assert.deepEqual(fs.readFileSync(historyPath(unavailableName, 'ylog')), corruptBytes);
  await assertHealthyRoomCanCollaborate('project-search-still-healthy');
});

test('two Yjs clients converge after concurrent offline edits and reconnect', async () => {
  const room = 'converge-session.js';
  const created = await request(`http://localhost:${port}/api/files`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: room }),
  });
  assert.equal(created.status, 200);
  const { doc: docA, provider: providerA } = createProvider(room);
  const { doc: docB, provider: providerB } = createProvider(room);
  await Promise.all([waitForSync(providerA), waitForSync(providerB)]);

  docA.getText('monaco').insert(0, 'shared');
  await waitForText(docB, 'shared');

  providerB.disconnect();
  docA.getText('monaco').insert(6, '-A');
  docB.getText('monaco').insert(6, '-B');
  providerB.connect();
  await waitForSync(providerB);

  const converged = await waitForConvergence(docA, docB);
  assert.match(converged, /^shared-(A-B|B-A)$/);
  const revisionResponse = await request(`http://localhost:${port}/api/files/${encodeURIComponent(room)}/revisions/latest`);
  assert.equal(revisionResponse.status, 200);
  const revision = await revisionResponse.json();
  assert.equal(revision.sourceHash, crypto.createHash('sha256').update(converged).digest('hex'));
  assert.match(revision.revisionId, /^yrev1_[a-f0-9]{64}$/);
});

test('multiple Yjs updates survive backend restart and document reload', async () => {
  await ensureTestFile('restart-session');
  const { doc: writer, provider: writerProvider } = createProvider('restart-session');
  const { doc: observer, provider: observerProvider } = createProvider('restart-session');
  await Promise.all([waitForSync(writerProvider), waitForSync(observerProvider)]);

  writer.getText('monaco').insert(0, 'first');
  await waitForText(observer, 'first');
  writer.getText('monaco').insert(5, '-second');
  await waitForText(observer, 'first-second');

  await closeProviders();
  await stopServer();
  await startServer();

  const { doc: recovered, provider: recoveredProvider } = createProvider('restart-session');
  await waitForSync(recoveredProvider);
  assert.equal(recovered.getText('monaco').toString(), 'first-second');
});

test('document revisions are exposed only from durable history and remain retrievable after restart', async () => {
  const room = 'durable-revision.js';
  const created = await request(`http://localhost:${port}/api/files`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: room }),
  });
  assert.equal(created.status, 200);
  const createdFile = await created.json();
  assert.equal(createdFile.file.name, room);
  assert.match(createdFile.file.documentId, /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i);
  const createdFileStore = JSON.parse(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8'));
  assert.equal(createdFileStore.files.find(file => file.name === room).historyKey, createdFile.file.documentId);
  const metadataBeforeRestart = await request(`http://localhost:${port}/api/files/${encodeURIComponent(room)}`);
  assert.equal(metadataBeforeRestart.status, 200);
  assert.equal((await metadataBeforeRestart.json()).language, 'javascript');
  const internalIdAsFilename = await request(`http://localhost:${port}/api/files/${encodeURIComponent(createdFile.file._id)}/revisions/latest`);
  assert.equal(internalIdAsFilename.status, 404);
  assert.deepEqual(await internalIdAsFilename.json(), { error: 'File not found' });

  const latestUrl = `http://localhost:${port}/api/files/${encodeURIComponent(room)}/revisions/latest`;
  const missingRevision = await request(latestUrl);
  assert.equal(missingRevision.status, 404);

  const { doc, provider } = createProvider(room);
  const { doc: observer, provider: observerProvider } = createProvider(room);
  await Promise.all([waitForSync(provider), waitForSync(observerProvider)]);
  const firstText = 'const value = 1;';
  doc.getText('monaco').insert(0, firstText);
  await waitForText(observer, firstText);

  const firstResponse = await request(latestUrl);
  assert.equal(firstResponse.status, 200);
  const firstRevision = await firstResponse.json();
  assert.match(firstRevision.revisionId, /^yrev1_[a-f0-9]{64}$/);
  assert.equal(firstRevision.sourceHash, crypto.createHash('sha256').update(firstText).digest('hex'));
  assert.equal(Object.hasOwn(firstRevision, 'source'), false);

  const secondText = `${firstText}\nconsole.log('later');`;
  doc.getText('monaco').insert(firstText.length, "\nconsole.log('later');");
  await waitForText(observer, secondText);
  const secondResponse = await request(latestUrl);
  assert.equal(secondResponse.status, 200);
  const secondRevision = await secondResponse.json();
  assert.notEqual(secondRevision.revisionId, firstRevision.revisionId);
  assert.equal(secondRevision.sourceHash, crypto.createHash('sha256').update(secondText).digest('hex'));
  const latestByDocumentId = await request(`http://localhost:${port}/api/documents/${createdFile.file.documentId}/revisions/latest`);
  assert.equal(latestByDocumentId.status, 200);
  assert.deepEqual(await latestByDocumentId.json(), secondRevision);

  const firstAgainResponse = await request(`http://localhost:${port}/api/files/${encodeURIComponent(room)}/revisions/${firstRevision.revisionId}`);
  assert.equal(firstAgainResponse.status, 200);
  assert.equal((await firstAgainResponse.json()).sourceHash, firstRevision.sourceHash);
  const fabricatedResponse = await request(`http://localhost:${port}/api/files/${encodeURIComponent(room)}/revisions/yrev1_${'0'.repeat(64)}`);
  assert.equal(fabricatedResponse.status, 404);
  const malformedRevision = await request(`http://localhost:${port}/api/files/${encodeURIComponent(room)}/revisions/not-a-revision`);
  assert.equal(malformedRevision.status, 400);
  assert.deepEqual(await malformedRevision.json(), { error: 'Invalid document revision identifier' });

  await closeProviders();
  await stopServer();
  await startServer();
  const fileMetadataAfterRestart = await request(`http://localhost:${port}/api/files/${encodeURIComponent(room)}`);
  assert.equal(fileMetadataAfterRestart.status, 200);
  assert.equal((await fileMetadataAfterRestart.json()).language, 'javascript');
  const filesAfterRestart = await request(`http://localhost:${port}/api/files`);
  assert.ok((await filesAfterRestart.json()).includes(room));
  const latestAfterRestart = await request(latestUrl);
  assert.equal(latestAfterRestart.status, 200);
  const recoveredLatestRevision = await latestAfterRestart.json();
  assert.deepEqual(recoveredLatestRevision, secondRevision);
  assert.equal(recoveredLatestRevision.revisionId, secondRevision.revisionId);
  const latestByIdAfterRestart = await request(`http://localhost:${port}/api/files/${encodeURIComponent(room)}/revisions/${secondRevision.revisionId}`);
  assert.equal(latestByIdAfterRestart.status, 200);
  assert.deepEqual(await latestByIdAfterRestart.json(), secondRevision);
  const firstAfterRestart = await request(`http://localhost:${port}/api/files/${encodeURIComponent(room)}/revisions/${firstRevision.revisionId}`);
  assert.equal(firstAfterRestart.status, 200);
  assert.equal((await firstAfterRestart.json()).sourceHash, firstRevision.sourceHash);
  const revisionAfterRestartByDocumentId = await request(`http://localhost:${port}/api/documents/${createdFile.file.documentId}/revisions/${secondRevision.revisionId}`);
  assert.equal(revisionAfterRestartByDocumentId.status, 200);
  assert.deepEqual(await revisionAfterRestartByDocumentId.json(), secondRevision);
});

test('execution capability fails closed without starting a child process', async () => {
  const capability = await request(`http://localhost:${port}/api/execution-capability`);
  assert.equal(capability.status, 200);
  assert.equal((await capability.json()).available, false);

  const rejected = await request(`http://localhost:${port}/api/executions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source: 'throw new Error("must not run")', command: 'cmd.exe' }),
  });
  assert.equal(rejected.status, 503);
  assert.match((await rejected.json()).error, /isolation runtime is unavailable/i);
});

test('deletion is rejected while collaborators are connected and preserves metadata and history', async () => {
  const room = 'active-delete-conflict';
  const created = await request(`http://127.0.0.1:${port}/api/files`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: room }),
  });
  assert.equal(created.status, 200);

  const { doc, provider, clientId } = createProvider(room);
  const { doc: observer, provider: observerProvider } = createProvider(room);
  await Promise.all([waitForSync(provider), waitForSync(observerProvider)]);
  doc.getText('monaco').insert(0, 'recoverable');
  await waitForText(observer, 'recoverable');
  doc.getText('monaco').insert(11, ' code');
  await waitForText(observer, 'recoverable code');
  const historyBefore = fs.readFileSync(historyPath(room, 'ylog'));
  const revisionBeforeResponse = await request(`http://127.0.0.1:${port}/api/files/${room}/revisions/latest`);
  assert.equal(revisionBeforeResponse.status, 200);
  const revisionBefore = await revisionBeforeResponse.json();

  const deletion = await request(`http://127.0.0.1:${port}/api/files/${room}?clientId=${clientId}`, { method: 'DELETE' });
  assert.equal(deletion.status, 409);
  assert.equal((await deletion.json()).code, 'file_in_use');
  assert.ok((await (await request(`http://127.0.0.1:${port}/api/files`)).json()).includes(room));
  assert.deepEqual(fs.readFileSync(historyPath(room, 'ylog')), historyBefore);
  const revisionAfter = await request(`http://127.0.0.1:${port}/api/files/${room}/revisions/${revisionBefore.revisionId}`);
  assert.equal(revisionAfter.status, 200);
  assert.deepEqual(await revisionAfter.json(), revisionBefore);
  assert.equal(doc.getText('monaco').toString(), 'recoverable code');
  assert.equal(observer.getText('monaco').toString(), 'recoverable code');
  await closeProviders();
});

test('a requesting client can delete its own active room without allowing a second client', async () => {
  const room = 'active-delete-requester';
  const created = await request(`http://127.0.0.1:${port}/api/files`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: room }),
  });
  assert.equal(created.status, 200);

  const { doc, provider, clientId } = createProvider(room);
  await waitForSync(provider);
  doc.getText('monaco').insert(0, 'keep-history');
  const closePromise = waitForCloseCode(provider, 1008);
  const deletion = await request(`http://127.0.0.1:${port}/api/files/${room}?clientId=${clientId}`, { method: 'DELETE' });
  assert.equal(deletion.status, 200);
  const close = await closePromise;
  assert.equal(close.reason, 'File deleted');
  provider.destroy();
  assert.equal((await request(`http://127.0.0.1:${port}/api/files/${room}/revisions/latest`)).status, 200);
});

test('room join and deletion races remain serialized by the shared admission gate', async () => {
  for (const suffix of ['a', 'b', 'c']) {
    const room = `delete-join-race-${suffix}`;
    const created = await request(`http://127.0.0.1:${port}/api/files`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: room }),
    });
    assert.equal(created.status, 200);

    const socket = createRawSocket(room);
    const closed = waitForSocketClose(socket);
    const deletion = await request(`http://127.0.0.1:${port}/api/files/${room}`, { method: 'DELETE' });
    if (deletion.status === 409) {
      assert.equal((await deletion.json()).code, 'file_in_use');
      if (socket.readyState !== WebSocket.CLOSED) socket.close();
      await closed;
      assert.equal((await deleteWhenDisconnected(room)).status, 200);
    } else {
      assert.equal(deletion.status, 200);
      const close = await closed;
      assert.ok([1008, 1013].includes(close.code), `unexpected concurrent join close code ${close.code}`);
    }

    const retry = createRawSocket(room);
    const retryClosed = waitForSocketClose(retry);
    const close = await retryClosed;
    assert.equal(close.code, 1008);
    assert.equal(close.reason, 'File deleted');
  }
});

test('disconnected deletion tombstones the path and retains Yjs history and revisions after restart', async () => {
  const room = 'deleted-file-history';
  const created = await request(`http://127.0.0.1:${port}/api/files`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: room }),
  });
  assert.equal(created.status, 200);

  const { doc, provider } = createProvider(room);
  await waitForSync(provider);
  doc.getText('monaco').insert(0, 'recoverable');
  doc.getText('monaco').insert(11, ' code');
  const revisionResponse = await request(`http://127.0.0.1:${port}/api/files/${room}/revisions/latest`);
  assert.equal(revisionResponse.status, 200);
  const revision = await revisionResponse.json();
  const originalHistory = fs.readFileSync(historyPath(room, 'ylog'));
  await closeProviders();

  const deletion = await deleteWhenDisconnected(room);
  assert.equal(deletion.status, 200);
  assert.deepEqual(fs.readFileSync(historyPath(room, 'ylog')), originalHistory);
  assert.equal((await request(`http://127.0.0.1:${port}/api/files/${room}`)).status, 404);
  assert.equal((await request(`http://127.0.0.1:${port}/api/files/${room}/revisions/latest`)).status, 200);
  assert.equal((await request(`http://127.0.0.1:${port}/api/files`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: room }),
  })).status, 409);

  await stopServer();
  await startServer();

  const listAfterRestart = await request(`http://127.0.0.1:${port}/api/files`);
  assert.equal((await listAfterRestart.json()).includes(room), false);
  const latestAfterRestart = await request(`http://127.0.0.1:${port}/api/files/${room}/revisions/latest`);
  assert.equal(latestAfterRestart.status, 200);
  assert.deepEqual(await latestAfterRestart.json(), revision);
  const specificAfterRestart = await request(`http://127.0.0.1:${port}/api/files/${room}/revisions/${revision.revisionId}`);
  assert.equal(specificAfterRestart.status, 200);
  assert.deepEqual(await specificAfterRestart.json(), revision);
  assert.deepEqual(fs.readFileSync(historyPath(room, 'ylog')), originalHistory);
  const reconnect = createRawSocket(room);
  const rejected = await waitForSocketClose(reconnect);
  assert.equal(rejected.code, 1008);
  assert.equal(rejected.reason, 'File deleted');
  const recreate = await request(`http://127.0.0.1:${port}/api/files`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: room }),
  });
  assert.equal(recreate.status, 409);
  assert.equal((await recreate.json()).code, 'file_deleted');
});

test('corrupt and truncated framed history reject only the affected rooms and remain unchanged', async () => {
  const validUpdate = makeUpdates('valid-prefix')[0];

  const checksumRoom = 'corrupt-checksum-session';
  await ensureTestFile(checksumRoom);
  const checksumFrame = encodeUpdateFrame(validUpdate);
  checksumFrame[4] ^= 0xff;
  const corruptBytes = Buffer.concat([YJS_LOG_MAGIC, checksumFrame]);
  fs.writeFileSync(historyPath(checksumRoom, 'ylog'), corruptBytes);
  const corruptBefore = fs.readFileSync(historyPath(checksumRoom, 'ylog'));
  await assertRoomUnavailable(checksumRoom);
  assert.deepEqual(fs.readFileSync(historyPath(checksumRoom, 'ylog')), corruptBefore);
  await assertHealthyRoomCanCollaborate('healthy-after-corrupt-history');

  const truncatedRoom = 'truncated-frame-session';
  await ensureTestFile(truncatedRoom);
  const secondUpdate = makeUpdates('truncated-tail')[0];
  const completeTail = encodeUpdateFrame(secondUpdate);
  const truncatedBytes = Buffer.concat([
    YJS_LOG_MAGIC,
    encodeUpdateFrame(validUpdate),
    completeTail.subarray(0, 4 + 32 + 2),
  ]);
  fs.writeFileSync(historyPath(truncatedRoom, 'ylog'), truncatedBytes);
  const truncatedBefore = fs.readFileSync(historyPath(truncatedRoom, 'ylog'));
  await assertRoomUnavailable(truncatedRoom);
  assert.deepEqual(fs.readFileSync(historyPath(truncatedRoom, 'ylog')), truncatedBefore);
  await assertHealthyRoomCanCollaborate('healthy-after-truncated-history');

  const invalidUpdateRoom = 'invalid-update-session';
  await ensureTestFile(invalidUpdateRoom);
  const invalidUpdateBytes = Buffer.concat([
    YJS_LOG_MAGIC,
    encodeUpdateFrame(validUpdate),
    encodeUpdateFrame(Buffer.from([0xff, 0xff, 0xff])),
  ]);
  fs.writeFileSync(historyPath(invalidUpdateRoom, 'ylog'), invalidUpdateBytes);
  const invalidBefore = fs.readFileSync(historyPath(invalidUpdateRoom, 'ylog'));
  await assertRoomUnavailable(invalidUpdateRoom);
  assert.deepEqual(fs.readFileSync(historyPath(invalidUpdateRoom, 'ylog')), invalidBefore);
  await assertHealthyRoomCanCollaborate('healthy-after-invalid-update');
});

test('legacy .bin history stays unchanged and is rejected until an explicit migration', async () => {
  const room = 'legacy-session';
  await ensureTestFile(room);
  const legacyBytes = Buffer.concat(makeUpdates('legacy-history'));
  fs.writeFileSync(historyPath(room, 'bin'), legacyBytes);
  const legacyBefore = fs.readFileSync(historyPath(room, 'bin'));

  await assertRoomUnavailable(room);
  assert.deepEqual(fs.readFileSync(historyPath(room, 'bin')), legacyBefore);
  assert.equal(fs.existsSync(historyPath(room, 'ylog')), false);
  await assertHealthyRoomCanCollaborate('healthy-after-legacy-history');
});
