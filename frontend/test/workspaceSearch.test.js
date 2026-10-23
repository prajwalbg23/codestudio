import test from 'node:test';
import assert from 'node:assert/strict';
import { searchText } from '../src/workspaceSearch.js';

test('searchText reports matching file, line, column, and context', () => {
  assert.deepEqual(searchText('const value = 1;\nfunction run() { value; }', 'VALUE', 'main.js'), [
    { fileName: 'main.js', lineNumber: 1, column: 7, snippet: 'const value = 1;' },
    { fileName: 'main.js', lineNumber: 2, column: 18, snippet: 'function run() { value; }' },
  ]);
});

test('searchText handles empty values and caps repeated matches', () => {
  assert.deepEqual(searchText('a a a', ' ', 'main.js'), []);
  assert.deepEqual(searchText('a a a', 'a', ''), []);
  assert.equal(searchText('x x x x', 'x', 'main.js', 2).length, 2);
});

test('searchText handles CRLF source and leaves the source unchanged', () => {
  const source = 'first\r\nsecond needle\r\nthird';
  assert.deepEqual(searchText(source, 'needle', 'test.txt'), [
    { fileName: 'test.txt', lineNumber: 2, column: 8, snippet: 'second needle' },
  ]);
  assert.equal(source, 'first\r\nsecond needle\r\nthird');
});

test('searchText supports case-sensitive and whole-word project query options', () => {
  const source = 'Alpha token\nalpha tokenized\nalpha token';
  assert.deepEqual(searchText(source, 'token', 'main.js', 300, { wholeWord: true }), [
    { fileName: 'main.js', lineNumber: 1, column: 7, snippet: 'Alpha token' },
    { fileName: 'main.js', lineNumber: 3, column: 7, snippet: 'alpha token' },
  ]);
  assert.deepEqual(searchText(source, 'Alpha', 'main.js', 300, { caseSensitive: true, wholeWord: true }), [
    { fileName: 'main.js', lineNumber: 1, column: 1, snippet: 'Alpha token' },
  ]);
});
