import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { hashEditorText, isConfirmedPersistedRevision } from '../src/durableRevision.js';

test('editor source hash uses UTF-8 SHA-256 and distinguishes exact revisions', async () => {
  const first = await hashEditorText('console.log("hello");', webcrypto);
  const second = await hashEditorText('console.log("hello");\n', webcrypto);
  assert.equal(first, createHash('sha256').update('console.log("hello");').digest('hex'));
  assert.notEqual(first, second);
});

test('editor source hashing fails closed when secure browser hashing is unavailable', async () => {
  await assert.rejects(hashEditorText('source', {}), /Secure text hashing is unavailable/);
});

test('only a well-formed backend revision for the exact active editor text is confirmed', () => {
  const revision = { fileName: 'main.js', revisionId: `yrev1_${'a'.repeat(64)}`, sourceHash: 'b'.repeat(64) };
  const editorText = { source: 'persisted source', sourceHash: 'b'.repeat(64) };
  assert.equal(isConfirmedPersistedRevision(revision, 'main.js', editorText), true);
  assert.equal(isConfirmedPersistedRevision(revision, 'other.js', editorText), false);
  assert.equal(isConfirmedPersistedRevision(revision, 'main.js', { ...editorText, sourceHash: 'c'.repeat(64) }), false);
  assert.equal(isConfirmedPersistedRevision({ ...revision, revisionId: 'fabricated' }, 'main.js', editorText), false);
  assert.equal(isConfirmedPersistedRevision(null, 'main.js', editorText), false);
});
