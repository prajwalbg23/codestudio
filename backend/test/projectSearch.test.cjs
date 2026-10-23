const assert = require('node:assert/strict');
const { test } = require('node:test');
const { searchText } = require('../projectSearch');

test('project matching reports file context and honors case-sensitive whole-word options', () => {
  const source = 'Alpha token\r\nalpha tokenized\nalpha token';
  assert.deepEqual(searchText(source, 'token', 'src/main.js', { wholeWord: true }), [
    { fileName: 'src/main.js', lineNumber: 1, column: 7, snippet: 'Alpha token' },
    { fileName: 'src/main.js', lineNumber: 3, column: 7, snippet: 'alpha token' },
  ]);
  assert.deepEqual(searchText(source, 'Alpha', 'src/main.js', { caseSensitive: true, wholeWord: true }), [
    { fileName: 'src/main.js', lineNumber: 1, column: 1, snippet: 'Alpha token' },
  ]);
  assert.deepEqual(searchText(source, 'alpha', 'src/main.js', { caseSensitive: true }), [
    { fileName: 'src/main.js', lineNumber: 2, column: 1, snippet: 'alpha tokenized' },
    { fileName: 'src/main.js', lineNumber: 3, column: 1, snippet: 'alpha token' },
  ]);
});

test('project matching supports Unicode word boundaries and a result limit', () => {
  assert.deepEqual(searchText('café cafe cafe2', 'cafe', 'notes.txt', { wholeWord: true }), [
    { fileName: 'notes.txt', lineNumber: 1, column: 6, snippet: 'café cafe cafe2' },
  ]);
  assert.equal(searchText('x x x', 'x', 'a.js', {}, 2).length, 2);
});
