import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_BACKEND_HTTP_URL,
  resolveBackendUrls,
} from '../src/backendConfig.js';

test('backend configuration keeps the local HTTP and WebSocket defaults', () => {
  assert.equal(DEFAULT_BACKEND_HTTP_URL, 'http://127.0.0.1:3001');
  assert.deepEqual(resolveBackendUrls(undefined), {
    backendHttpUrl: 'http://127.0.0.1:3001',
    backendWebSocketUrl: 'ws://127.0.0.1:3001',
  });
  assert.deepEqual(resolveBackendUrls('  '), resolveBackendUrls(undefined));
});

test('explicit local HTTP endpoint preserves local development behavior', () => {
  assert.deepEqual(resolveBackendUrls('http://localhost:3010/'), {
    backendHttpUrl: 'http://localhost:3010',
    backendWebSocketUrl: 'ws://localhost:3010',
  });
});

test('HTTPS backend configuration derives a secure WebSocket endpoint', () => {
  assert.deepEqual(resolveBackendUrls('https://api.example.test'), {
    backendHttpUrl: 'https://api.example.test',
    backendWebSocketUrl: 'wss://api.example.test',
  });
});

test('invalid or unsafe backend endpoints fail closed', () => {
  for (const value of [
    'not a URL',
    'http://api.example.test',
    'ws://127.0.0.1:3001',
    'https://user:pass@api.example.test',
    'https://api.example.test/api',
    'https://api.example.test/?query=1',
  ]) {
    assert.throws(() => resolveBackendUrls(value), /VITE_BACKEND_URL/);
  }
});
