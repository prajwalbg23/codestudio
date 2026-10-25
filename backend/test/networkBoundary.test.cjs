const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const {
  ALLOWED_FRONTEND_ORIGINS,
  BACKEND_BIND_HOST,
  isAllowedFrontendOrigin,
  assertBackendBindAllowed,
  assertPublicBindDisabled,
  resolveAllowedFrontendOrigins,
  resolveBackendBindHost,
  resolveBackendPort,
} = require('../networkBoundary');

test('backend binds to IPv4 loopback', () => {
  assert.equal(BACKEND_BIND_HOST, '127.0.0.1');
});

test('local defaults preserve the loopback host, port, and explicit Vite origins', () => {
  assert.equal(resolveBackendBindHost({}), '127.0.0.1');
  assert.equal(resolveBackendPort({}), 3001);
  assert.deepEqual([...ALLOWED_FRONTEND_ORIGINS].sort(), [
    'http://127.0.0.1:4173',
    'http://127.0.0.1:5173',
    'http://localhost:4173',
    'http://localhost:5173',
  ]);
  assert.equal(isAllowedFrontendOrigin('http://localhost:5173'), true);
  assert.equal(isAllowedFrontendOrigin('http://localhost:5174'), false);
  assert.equal(isAllowedFrontendOrigin('https://localhost:5173'), false);
  assert.equal(isAllowedFrontendOrigin(undefined), false);
});

test('hosting bind and port values parse, but public binding remains disabled', () => {
  assert.equal(resolveBackendBindHost({ CODESTUDIO_BIND_HOST: '0.0.0.0' }), '0.0.0.0');
  assert.equal(resolveBackendPort({ PORT: '8080' }), 8080);
  assert.doesNotThrow(() => assertPublicBindDisabled('127.0.0.1', {}));
  assert.throws(() => assertPublicBindDisabled('0.0.0.0', {}), /Public backend binding remains disabled/);
  assert.throws(() => resolveBackendPort({ PORT: '70000' }), /PORT must be an integer/);
  assert.throws(() => resolveBackendBindHost({ CODESTUDIO_BIND_HOST: 'not a host' }), /must be localhost or an IP/);
});

function withTemporaryDataDirectory(callback) {
  const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'codestudio-hosted-ingress-'));
  try {
    return callback(dataDirectory);
  } finally {
    fs.rmSync(dataDirectory, { recursive: true, force: true });
  }
}

function productionIngressEnvironment(dataDirectory) {
  return {
    NODE_ENV: 'production',
    CODESTUDIO_ENABLE_HOSTED_INGRESS: 'true',
    CODESTUDIO_BIND_HOST: '0.0.0.0',
    CODESTUDIO_DATA_DIR: dataDirectory,
    CODESTUDIO_FRONTEND_ORIGINS: 'https://studio.example.test',
    CODESTUDIO_BOOTSTRAP_ADMIN_USERNAME: 'studio-admin',
    CODESTUDIO_BOOTSTRAP_ADMIN_PASSWORD: 'test-only-password-123',
  };
}

test('hosted ingress stays closed unless explicitly enabled for production on 0.0.0.0', () => {
  assert.equal(assertBackendBindAllowed('127.0.0.1', {}), false);
  assert.throws(() => assertBackendBindAllowed('0.0.0.0', {
    NODE_ENV: 'production',
    CODESTUDIO_BIND_HOST: '0.0.0.0',
  }), /explicitly enabled/);
  assert.throws(() => assertBackendBindAllowed('127.0.0.1', {
    NODE_ENV: 'development',
    CODESTUDIO_ENABLE_HOSTED_INGRESS: 'true',
  }), /requires NODE_ENV=production/);
  assert.throws(() => assertBackendBindAllowed('192.0.2.10', {
    NODE_ENV: 'production',
    CODESTUDIO_ENABLE_HOSTED_INGRESS: 'true',
  }), /CODESTUDIO_BIND_HOST=0.0.0.0/);
  assert.throws(() => assertBackendBindAllowed('127.0.0.1', {
    CODESTUDIO_ENABLE_HOSTED_INGRESS: 'yes',
  }), /must be either true or false/);
});

test('explicit hosted ingress accepts only fully validated production configuration', () => {
  withTemporaryDataDirectory(dataDirectory => {
    const env = productionIngressEnvironment(dataDirectory);
    assert.equal(assertBackendBindAllowed('0.0.0.0', env), true);
    assert.equal(fs.statSync(path.join(dataDirectory, 'yjs_db')).isDirectory(), true);
  });
});

test('hosted ingress rejects missing security settings, invalid origins, and unsafe storage', () => {
  withTemporaryDataDirectory(dataDirectory => {
    const base = productionIngressEnvironment(dataDirectory);
    const invalidEnvironments = [
      { ...base, CODESTUDIO_BOOTSTRAP_ADMIN_USERNAME: undefined },
      { ...base, CODESTUDIO_BOOTSTRAP_ADMIN_PASSWORD: undefined },
      { ...base, CODESTUDIO_BIND_HOST: undefined },
      { ...base, CODESTUDIO_FRONTEND_ORIGINS: 'https://studio.example.test/path' },
      { ...base, CODESTUDIO_FRONTEND_ORIGINS: '*' },
      { ...base, CODESTUDIO_DATA_DIR: undefined },
      { ...base, CODESTUDIO_DATA_DIR: 'relative/data' },
      { ...base, CODESTUDIO_DEV_AUTH_BYPASS: 'true' },
    ];
    for (const env of invalidEnvironments) {
      assert.throws(() => assertBackendBindAllowed('0.0.0.0', env));
    }

    const unusableDirectory = path.join(dataDirectory, 'unusable');
    fs.mkdirSync(unusableDirectory);
    fs.writeFileSync(path.join(unusableDirectory, 'yjs_db'), 'not a directory');
    assert.throws(() => assertBackendBindAllowed('0.0.0.0', {
      ...base,
      CODESTUDIO_DATA_DIR: unusableDirectory,
    }), /Yjs history files/);
  });
});

test('production origins are exact HTTPS origins and reject unapproved origins', () => {
  const origins = resolveAllowedFrontendOrigins({
    NODE_ENV: 'production',
    CODESTUDIO_FRONTEND_ORIGINS: 'https://studio.example.test,https://preview.example.test',
  });
  assert.deepEqual([...origins].sort(), [
    'https://preview.example.test',
    'https://studio.example.test',
  ]);
  assert.equal(isAllowedFrontendOrigin('https://studio.example.test', origins), true);
  assert.equal(isAllowedFrontendOrigin('https://other.example.test', origins), false);
  assert.equal(isAllowedFrontendOrigin('http://localhost:5173', origins), false);
});

test('missing or invalid production origin configuration fails safely', () => {
  for (const value of [undefined, '', '*', 'http://studio.example.test', 'https://studio.example.test/path', 42]) {
    assert.throws(() => resolveAllowedFrontendOrigins({
      NODE_ENV: 'production',
      CODESTUDIO_FRONTEND_ORIGINS: value,
    }));
  }
});
