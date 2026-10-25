import assert from 'node:assert/strict';
import { test } from 'node:test';
import { authenticatedFetch, clearAccessToken, setAccessToken } from '../src/apiClient.js';

test('API client sends only the in-memory bearer token and clears it on request', async () => {
  const originalFetch = globalThis.fetch;
  let received;
  globalThis.fetch = async (input, options) => {
    received = { input, options };
    return new Response('{}', { status: 200 });
  };
  try {
    setAccessToken('a'.repeat(48));
    await authenticatedFetch('http://localhost/api/files', { headers: { Accept: 'application/json' } });
    assert.equal(received.options.headers.get('Authorization'), `Bearer ${'a'.repeat(48)}`);
    assert.equal(received.options.headers.get('Accept'), 'application/json');
    clearAccessToken();
    await authenticatedFetch('http://localhost/api/files');
    assert.equal(received.options.headers.has('Authorization'), false);
  } finally {
    clearAccessToken();
    globalThis.fetch = originalFetch;
  }
});
