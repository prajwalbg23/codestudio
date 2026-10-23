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

function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { ...options, agent: false }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        resolve({
          status: response.statusCode,
          ok: response.statusCode >= 200 && response.statusCode < 300,
          headers: response.headers,
          json: async () => JSON.parse(body),
        });
      });
    });
    req.once('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
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

function createProvider(room, doc = new Y.Doc()) {
  class LocalOriginWebSocket extends WebSocket {
    constructor(url, protocols) {
      super(url, protocols, { origin: 'http://localhost:5173' });
    }
  }
  const provider = new WebsocketProvider(`ws://127.0.0.1:${port}`, room, doc, {
    WebSocketPolyfill: LocalOriginWebSocket,
    disableBc: true,
    maxBackoffTime: 500,
  });
  providers.add(provider);
  return { doc, provider };
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
  return path.join(dataDir, 'yjs_db', `${encodeURIComponent(room)}.${extension}`);
}

async function assertRoomUnavailable(room) {
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
  assert.deepEqual(await fileMetadata.json(), { language: 'json' });

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
  const metadataBeforeRestart = await request(`http://localhost:${port}/api/files/${encodeURIComponent(room)}`);
  assert.equal(metadataBeforeRestart.status, 200);
  assert.deepEqual(await metadataBeforeRestart.json(), { language: 'javascript' });
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
  assert.deepEqual(await fileMetadataAfterRestart.json(), { language: 'javascript' });
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

test('deleting a file record retains multi-update Yjs history across restart', async () => {
  const room = 'deleted-file-history';
  const created = await request(`http://localhost:${port}/api/files`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: room }),
  });
  assert.equal(created.status, 200);

  const { doc, provider } = createProvider(room);
  const { doc: observer, provider: observerProvider } = createProvider(room);
  await Promise.all([waitForSync(provider), waitForSync(observerProvider)]);
  doc.getText('monaco').insert(0, 'recoverable');
  await waitForText(observer, 'recoverable');
  doc.getText('monaco').insert(11, ' code');
  await waitForText(observer, 'recoverable code');
  await closeProviders();

  const deletion = await request(`http://localhost:${port}/api/files/${room}`, { method: 'DELETE' });
  assert.equal(deletion.status, 200);
  await stopServer();
  await startServer();

  const { doc: recovered, provider: recoveredProvider } = createProvider(room);
  await waitForSync(recoveredProvider);
  assert.equal(recovered.getText('monaco').toString(), 'recoverable code');
});

test('corrupt and truncated framed history reject only the affected rooms and remain unchanged', async () => {
  const validUpdate = makeUpdates('valid-prefix')[0];

  const checksumRoom = 'corrupt-checksum-session';
  const checksumFrame = encodeUpdateFrame(validUpdate);
  checksumFrame[4] ^= 0xff;
  const corruptBytes = Buffer.concat([YJS_LOG_MAGIC, checksumFrame]);
  fs.writeFileSync(historyPath(checksumRoom, 'ylog'), corruptBytes);
  const corruptBefore = fs.readFileSync(historyPath(checksumRoom, 'ylog'));
  await assertRoomUnavailable(checksumRoom);
  assert.deepEqual(fs.readFileSync(historyPath(checksumRoom, 'ylog')), corruptBefore);
  await assertHealthyRoomCanCollaborate('healthy-after-corrupt-history');

  const truncatedRoom = 'truncated-frame-session';
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
  const legacyBytes = Buffer.concat(makeUpdates('legacy-history'));
  fs.writeFileSync(historyPath(room, 'bin'), legacyBytes);
  const legacyBefore = fs.readFileSync(historyPath(room, 'bin'));

  await assertRoomUnavailable(room);
  assert.deepEqual(fs.readFileSync(historyPath(room, 'bin')), legacyBefore);
  assert.equal(fs.existsSync(historyPath(room, 'ylog')), false);
  await assertHealthyRoomCanCollaborate('healthy-after-legacy-history');
});
