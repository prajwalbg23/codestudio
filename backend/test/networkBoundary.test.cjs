const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  ALLOWED_FRONTEND_ORIGINS,
  BACKEND_BIND_HOST,
  isAllowedFrontendOrigin,
} = require('../networkBoundary');

test('backend binds to IPv4 loopback', () => {
  assert.equal(BACKEND_BIND_HOST, '127.0.0.1');
});

test('frontend origin allowlist contains only Vite default dev and preview origins', () => {
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
