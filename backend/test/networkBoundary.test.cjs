const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  ALLOWED_FRONTEND_ORIGINS,
  BACKEND_BIND_HOST,
  isAllowedFrontendOrigin,
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
  assert.doesNotThrow(() => assertPublicBindDisabled('127.0.0.1'));
  assert.throws(() => assertPublicBindDisabled('0.0.0.0'), /Public backend binding remains disabled/);
  assert.throws(() => resolveBackendPort({ PORT: '70000' }), /PORT must be an integer/);
  assert.throws(() => resolveBackendBindHost({ CODESTUDIO_BIND_HOST: 'not a host' }), /must be localhost or an IP/);
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
