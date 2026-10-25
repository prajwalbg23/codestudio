import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProjectTree, filterProjectTree } from '../src/projectTree.js';

test('project tree groups nested files, preserves root files, and represents empty folders', () => {
  const tree = buildProjectTree(['main.js', 'src/app.py'], ['src', 'src/empty']);

  assert.deepEqual(tree.files, [{ name: 'main.js', path: 'main.js' }]);
  assert.equal(tree.folders.length, 1);
  assert.equal(tree.folders[0].path, 'src');
  assert.deepEqual(tree.folders[0].files, [{ name: 'app.py', path: 'src/app.py' }]);
  assert.deepEqual(tree.folders[0].folders.map(folder => folder.path), ['src/empty']);
});

test('project tree filtering retains matching files and their ancestor folders', () => {
  const tree = buildProjectTree(['src/app.py', 'src/readme.md', 'root.js'], ['src', 'src/empty']);
  const filtered = filterProjectTree(tree, 'app.py');

  assert.equal(filtered.folders.length, 1);
  assert.equal(filtered.folders[0].path, 'src');
  assert.deepEqual(filtered.folders[0].files, [{ name: 'app.py', path: 'src/app.py' }]);
  assert.deepEqual(filtered.files, []);
});
