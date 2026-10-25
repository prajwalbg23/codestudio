const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');
const { after, before, test } = require('node:test');

const backendDir = path.resolve(__dirname, '..');
const serverPath = path.join(backendDir, 'server.js');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codestudio-auth-'));
const ORIGIN = 'https://studio.example.test';
const ADMIN_USERNAME = 'checkpoint-admin';
const ADMIN_PASSWORD = 'isolated-test-password-2046';
const WORKSPACE_ID = 'checkpoint-workspace';
let port;
let child;
let adminToken;
let scriptDocumentId;

function request(url, { token, headers = {}, ...options } = {}) {
  return new Promise((resolve, reject) => {
    const requestHeaders = { Origin: ORIGIN, ...headers };
    if (token) requestHeaders.Authorization = `Bearer ${token}`;
    if (options.body && !requestHeaders['Content-Type']) requestHeaders['Content-Type'] = 'application/json';
    const req = http.request(url, { ...options, headers: requestHeaders, agent: false }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let json;
        try { json = JSON.parse(text); } catch { json = undefined; }
        resolve({ status: response.statusCode, headers: response.headers, json, text });
      });
    });
    req.once('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

function jsonBody(value) {
  return JSON.stringify(value);
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const value = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return value;
}

function startBackend({ production = true, bootstrap = true, devBypass = '', isolatedDir = dataDir, storageDir = isolatedDir, portValue = port } = {}) {
  const processEnv = {
    ...process.env,
    NODE_ENV: production ? 'production' : 'development',
    CODESTUDIO_DEV_AUTH_BYPASS: devBypass,
    CODESTUDIO_BIND_HOST: '127.0.0.1',
    CODESTUDIO_FRONTEND_ORIGINS: ORIGIN,
    CODESTUDIO_WORKSPACE_ID: WORKSPACE_ID,
    CODESTUDIO_DATA_DIR: storageDir,
    PORT: String(portValue),
    MONGODB_URI: '',
    CODESTUDIO_BOOTSTRAP_ADMIN_USERNAME: bootstrap ? ADMIN_USERNAME : '',
    CODESTUDIO_BOOTSTRAP_ADMIN_PASSWORD: bootstrap ? ADMIN_PASSWORD : '',
  };
  return spawn(process.execPath, [serverPath], {
    cwd: backendDir,
    env: processEnv,
    stdio: ['ignore', 'ignore', 'ignore'],
  });
}

function waitForExit(process, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    if (process.exitCode !== null) return resolve(process.exitCode);
    const timer = setTimeout(() => reject(new Error('Test backend did not exit')), timeoutMs);
    process.once('exit', code => { clearTimeout(timer); resolve(code); });
  });
}

async function waitForReady() {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Test backend exited with ${child.exitCode}`);
    try {
      const response = await request(`http://127.0.0.1:${port}/api/auth/me`);
      if (response.status === 401) return;
    } catch { /* wait for listener */ }
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error('Test backend did not become ready');
}

function openSse(token) {
  let responseRef;
  let resolveEvent;
  let resolveClosed;
  const event = new Promise(resolve => { resolveEvent = resolve; });
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  const connected = new Promise((resolve, reject) => {
    const req = http.request(`http://127.0.0.1:${port}/api/project-events`, {
      headers: { Origin: ORIGIN, Authorization: `Bearer ${token}` }, agent: false,
    }, response => {
      responseRef = response;
      if (response.statusCode !== 200) return reject(new Error(`SSE status ${response.statusCode}`));
      resolve();
      response.on('close', () => resolveClosed());
      let buffer = '';
      response.on('data', chunk => {
        buffer += chunk.toString();
        const frame = buffer.match(/event: project-change\ndata: ([^\n]+)\n\n/);
        if (frame) {
          try { resolveEvent(JSON.parse(frame[1])); } catch { /* Invalid test event is ignored. */ }
        }
      });
    });
    req.once('error', reject);
    req.end();
  });
  return { connected, event, closed, close: () => responseRef?.destroy() };
}

async function connectWebSocket(url, origin = ORIGIN) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { origin });
    const closed = new Promise(resolveClose => socket.once('close', (code, reason) => resolveClose({ code, reason: reason.toString() })));
    socket.once('open', () => resolve({ accepted: true, socket, closed }));
    socket.once('unexpected-response', (_request, response) => {
      response.resume();
      resolve({ accepted: false, status: response.statusCode, socket });
    });
    socket.once('error', error => {
      if (socket.readyState === WebSocket.CLOSED) return reject(error);
    });
  });
}

before(async () => {
  port = await freePort();
  child = startBackend();
  await waitForReady();
  const login = await request(`http://127.0.0.1:${port}/api/auth/login`, {
    method: 'POST', body: jsonBody({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD }),
  });
  assert.equal(login.status, 200);
  adminToken = login.json.token;
  const document = await request(`http://127.0.0.1:${port}/api/files/script.js`, { token: adminToken });
  assert.equal(document.status, 200);
  scriptDocumentId = document.json.documentId;
});

after(async () => {
  if (child && child.exitCode === null) {
    const exited = waitForExit(child);
    child.kill();
    await exited;
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('credentials are required; invalid, expired, and revoked sessions fail closed', async () => {
  const protectedResponse = await request(`http://127.0.0.1:${port}/api/files`);
  assert.equal(protectedResponse.status, 401);
  const invalid = await request(`http://127.0.0.1:${port}/api/files`, { token: 'invalid-token' });
  assert.equal(invalid.status, 401);

  const login = await request(`http://127.0.0.1:${port}/api/auth/login`, {
    method: 'POST', body: jsonBody({ username: ADMIN_USERNAME, password: 'incorrect-password-2046' }),
  });
  assert.equal(login.status, 401);

  const expiredLogin = await request(`http://127.0.0.1:${port}/api/auth/login`, {
    method: 'POST', body: jsonBody({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD }),
  });
  const expiredToken = expiredLogin.json.token;
  const dbPath = path.join(dataDir, 'db.json');
  const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
  const tokenHash = crypto.createHash('sha256').update(expiredToken).digest('hex');
  db.authsessions.find(session => session.tokenHash === tokenHash).expiresAt = Date.now() - 1;
  fs.writeFileSync(dbPath, JSON.stringify(db));
  const expired = await request(`http://127.0.0.1:${port}/api/files`, { token: expiredToken });
  assert.equal(expired.status, 401);

  const logout = await request(`http://127.0.0.1:${port}/api/auth/logout`, { method: 'POST', token: adminToken });
  assert.equal(logout.status, 200);
  const revoked = await request(`http://127.0.0.1:${port}/api/files`, { token: adminToken });
  assert.equal(revoked.status, 401);

  const relogin = await request(`http://127.0.0.1:${port}/api/auth/login`, {
    method: 'POST', body: jsonBody({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD }),
  });
  adminToken = relogin.json.token;
});

test('authorized workspace requests succeed and other workspace selectors are rejected', async () => {
  const files = await request(`http://127.0.0.1:${port}/api/files`, { token: adminToken });
  assert.equal(files.status, 200);
  assert.equal(files.headers['access-control-allow-origin'], ORIGIN);
  const otherWorkspace = await request(`http://127.0.0.1:${port}/api/files`, {
    token: adminToken,
    headers: { 'X-CodeStudio-Workspace-Id': 'unrelated-workspace' },
  });
  assert.equal(otherWorkspace.status, 403);
  const me = await request(`http://127.0.0.1:${port}/api/auth/me`, { token: adminToken });
  assert.equal(me.json.workspaceId, WORKSPACE_ID);
  assert.equal(me.json.username, ADMIN_USERNAME);
  const deniedOrigin = await request(`http://127.0.0.1:${port}/api/files`, {
    token: adminToken, headers: { Origin: 'https://unapproved.example.test' },
  });
  assert.equal(deniedOrigin.status, 403);
  const preflight = await request(`http://127.0.0.1:${port}/api/files`, {
    method: 'OPTIONS',
    headers: {
      Origin: ORIGIN,
      'Access-Control-Request-Method': 'GET',
      'Access-Control-Request-Headers': 'authorization,content-type',
    },
  });
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers['access-control-allow-headers'], /authorization/i);
});

test('protected file, folder, member, search, revision, and execution routes reject missing credentials', async () => {
  const cases = [
    ['GET', '/api/files'], ['GET', '/api/folders'], ['GET', '/api/members'],
    ['POST', '/api/files'], ['POST', '/api/folders'], ['POST', '/api/files/rename'],
    ['POST', '/api/folders/rename'], ['DELETE', '/api/files/anything.js'],
    ['DELETE', '/api/folders/anything'], ['POST', '/api/members'], ['DELETE', '/api/members/unknown'],
    ['POST', '/api/search'], ['GET', '/api/files/script.js/revisions/latest'],
    ['GET', `/api/documents/${scriptDocumentId}/revisions/latest`], ['GET', '/api/execution-capability'],
  ];
  for (const [method, pathname] of cases) {
    const response = await request(`http://127.0.0.1:${port}${pathname}`, { method });
    assert.equal(response.status, 401, `${method} ${pathname}`);
  }
});

test('request payload identity fields cannot impersonate an administrator or change workspace membership', async () => {
  const created = await request(`http://127.0.0.1:${port}/api/auth/users`, {
    method: 'POST', token: adminToken,
    body: jsonBody({ username: 'ordinary-member', password: 'another-test-password-2046', userId: 'admin', role: 'admin', workspaceId: 'unrelated-workspace' }),
  });
  assert.equal(created.status, 201);
  assert.equal(created.json.user.role, 'member');
  assert.equal(created.json.user.workspaceId, WORKSPACE_ID);
  const memberLogin = await request(`http://127.0.0.1:${port}/api/auth/login`, {
    method: 'POST', body: jsonBody({ username: 'ordinary-member', password: 'another-test-password-2046' }),
  });
  assert.equal(memberLogin.status, 200);
  const memberIdentity = await request(`http://127.0.0.1:${port}/api/auth/me`, { token: memberLogin.json.token });
  assert.equal(memberIdentity.json.id, created.json.user.id);
  assert.equal(memberIdentity.json.role, 'member');
  const deniedManagement = await request(`http://127.0.0.1:${port}/api/members`, {
    method: 'POST', token: memberLogin.json.token, body: jsonBody({ name: 'spoof', color: '#ffffff', role: 'admin' }),
  });
  assert.equal(deniedManagement.status, 403);
  const ticketResponse = await request(`http://127.0.0.1:${port}/api/auth/websocket-ticket`, {
    method: 'POST', token: memberLogin.json.token, body: jsonBody({ documentId: scriptDocumentId }),
  });
  assert.equal(ticketResponse.status, 200);
  const memberSocket = await connectWebSocket(`ws://127.0.0.1:${port}/${scriptDocumentId}?ticket=${encodeURIComponent(ticketResponse.json.ticket)}`);
  assert.equal(memberSocket.accepted, true);
  const memberEvents = openSse(memberLogin.json.token);
  await memberEvents.connected;
  const disabled = await request(`http://127.0.0.1:${port}/api/auth/users/${encodeURIComponent(created.json.user.id)}`, {
    method: 'DELETE', token: adminToken,
  });
  assert.equal(disabled.status, 200);
  const [closedSocket] = await Promise.all([memberSocket.closed, memberEvents.closed]);
  assert.equal(closedSocket.code, 1008);
  const revoked = await request(`http://127.0.0.1:${port}/api/members`, { token: memberLogin.json.token });
  assert.equal(revoked.status, 401);
});

test('SSE requires membership and delivers only events scoped to the authenticated workspace', async () => {
  const unauthorized = await request(`http://127.0.0.1:${port}/api/project-events`);
  assert.equal(unauthorized.status, 401);
  const wrongWorkspace = await request(`http://127.0.0.1:${port}/api/project-events`, {
    token: adminToken, headers: { 'X-CodeStudio-Workspace-Id': 'unrelated-workspace' },
  });
  assert.equal(wrongWorkspace.status, 403);

  const stream = openSse(adminToken);
  await stream.connected;
  const file = await request(`http://127.0.0.1:${port}/api/files`, {
    method: 'POST', token: adminToken, body: jsonBody({ name: 'auth-event.js' }),
  });
  assert.equal(file.status, 200);
  const rename = await request(`http://127.0.0.1:${port}/api/files/rename`, {
    method: 'POST', token: adminToken,
    body: jsonBody({ oldPath: 'auth-event.js', newPath: 'auth-event-renamed.js' }),
  });
  assert.equal(rename.status, 200);
  const event = await Promise.race([
    stream.event,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Timed out waiting for workspace event')), 3000)),
  ]);
  assert.equal(event.workspaceId, WORKSPACE_ID);
  assert.equal(event.type, 'rename');
  stream.close();
});

test('WebSocket admission requires a one-use document-scoped ticket', async () => {
  const deniedOrigin = await connectWebSocket(`ws://127.0.0.1:${port}/${scriptDocumentId}`, 'https://unapproved.example.test');
  assert.equal(deniedOrigin.accepted, false);
  assert.equal(deniedOrigin.status, 403);
  const noTicket = await connectWebSocket(`ws://127.0.0.1:${port}/${scriptDocumentId}`);
  assert.equal(noTicket.accepted, false);
  assert.equal(noTicket.status, 401);

  const ticketResponse = await request(`http://127.0.0.1:${port}/api/auth/websocket-ticket`, {
    method: 'POST', token: adminToken, body: jsonBody({ documentId: scriptDocumentId }),
  });
  assert.equal(ticketResponse.status, 200);
  const ticket = ticketResponse.json.ticket;
  const mismatched = await connectWebSocket(`ws://127.0.0.1:${port}/other-document?ticket=${encodeURIComponent(ticket)}`);
  assert.equal(mismatched.accepted, false);
  assert.equal(mismatched.status, 401);

  const allowedTicket = await request(`http://127.0.0.1:${port}/api/auth/websocket-ticket`, {
    method: 'POST', token: adminToken, body: jsonBody({ documentId: scriptDocumentId }),
  });
  assert.equal(allowedTicket.status, 200);
  const accepted = await connectWebSocket(`ws://127.0.0.1:${port}/${scriptDocumentId}?ticket=${encodeURIComponent(allowedTicket.json.ticket)}`);
  assert.equal(accepted.accepted, true);
  accepted.socket.close();
  const reused = await connectWebSocket(`ws://127.0.0.1:${port}/${scriptDocumentId}?ticket=${encodeURIComponent(allowedTicket.json.ticket)}`);
  assert.equal(reused.accepted, false);
  assert.equal(reused.status, 401);
});

test('production backend refuses to start without bootstrap account configuration', async () => {
  const isolatedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codestudio-auth-missing-'));
  const missingConfigPort = await freePort();
  const failed = startBackend({ bootstrap: false, isolatedDir, portValue: missingConfigPort });
  try {
    const code = await waitForExit(failed);
    assert.equal(code, 1);
  } finally {
    if (failed.exitCode === null) failed.kill();
    fs.rmSync(isolatedDir, { recursive: true, force: true });
  }
});

test('production backend rejects the development authentication bypass before listening', async () => {
  const isolatedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codestudio-auth-bypass-'));
  const bypassPort = await freePort();
  const rejected = startBackend({ devBypass: 'true', isolatedDir, portValue: bypassPort });
  try {
    const code = await waitForExit(rejected);
    assert.equal(code, 1);
    await assert.rejects(new Promise((resolve, reject) => {
      const probe = net.connect(bypassPort, '127.0.0.1', () => {
        probe.destroy();
        resolve();
      });
      probe.once('error', reject);
    }));
  } finally {
    if (rejected.exitCode === null) rejected.kill();
    fs.rmSync(isolatedDir, { recursive: true, force: true });
  }
});

test('production backend rejects missing or relative storage paths before listening', async () => {
  for (const storageDir of ['', 'relative/storage']) {
    const isolatedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codestudio-storage-startup-'));
    const storagePort = await freePort();
    const rejected = startBackend({ isolatedDir, storageDir, portValue: storagePort });
    try {
      assert.equal(await waitForExit(rejected), 1);
      await assert.rejects(new Promise((resolve, reject) => {
        const probe = net.connect(storagePort, '127.0.0.1', () => {
          probe.destroy();
          resolve();
        });
        probe.once('error', reject);
      }));
    } finally {
      if (rejected.exitCode === null) rejected.kill();
      fs.rmSync(isolatedDir, { recursive: true, force: true });
    }
  }
});
