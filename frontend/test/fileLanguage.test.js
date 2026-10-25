import test from 'node:test';
import assert from 'node:assert/strict';
import { getSelectedFileLanguage, resolveFileLanguage } from '../src/fileLanguage.js';

test('supported language extensions resolve to Monaco language IDs', () => {
  const cases = [
    ['Main.java', 'java'],
    ['main.c', 'c'],
    ['script.py', 'python'],
    ['index.html', 'html'],
    ['index.htm', 'html'],
    ['styles.css', 'css'],
    ['app.js', 'javascript'],
    ['app.jsx', 'javascript'],
    ['app.mjs', 'javascript'],
    ['app.cjs', 'javascript'],
  ];

  for (const [fileName, id] of cases) {
    assert.equal(resolveFileLanguage(fileName).id, id, fileName);
  }
});

test('extension detection is case-insensitive and invalid metadata falls back to extension', () => {
  assert.equal(resolveFileLanguage('MAIN.JAVA').id, 'java');
  assert.equal(resolveFileLanguage('MAIN.C').id, 'c');
  assert.equal(resolveFileLanguage('SCRIPT.PY').id, 'python');
  assert.equal(resolveFileLanguage('INDEX.HTM').id, 'html');
  assert.equal(resolveFileLanguage('STYLES.CSS').id, 'css');
  assert.equal(resolveFileLanguage('APP.JSX').id, 'javascript');
  assert.equal(resolveFileLanguage('script.py', 'not-a-language').id, 'python');
});

test('valid stored language metadata is preserved over the filename extension', () => {
  assert.deepEqual(resolveFileLanguage('source.java', 'python'), { id: 'python', label: 'Python' });
  assert.deepEqual(resolveFileLanguage('source.py', 'java'), { id: 'java', label: 'Java' });
});

test('switching files ignores stale language state from the previously selected file', () => {
  const selected = getSelectedFileLanguage('second.java', {
    file: 'first.py', id: 'python', label: 'Python',
  });
  assert.deepEqual(selected, { id: 'java', label: 'Java' });
  assert.deepEqual(getSelectedFileLanguage('first.py', {
    file: 'first.py', id: 'python', label: 'Python',
  }), { file: 'first.py', id: 'python', label: 'Python' });
});

test('existing non-target extension mappings remain available', () => {
  assert.equal(resolveFileLanguage('data.json').id, 'json');
  assert.equal(resolveFileLanguage('notes.md').id, 'markdown');
  assert.equal(resolveFileLanguage('component.tsx').id, 'typescript');
  assert.equal(resolveFileLanguage('server.go').id, 'go');
});
