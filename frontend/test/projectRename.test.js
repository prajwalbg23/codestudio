import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRenamePath, getDocumentRename, getFolderDeletionTransition, remapExpandedFolders, remapProjectPath, requestProjectRename } from '../src/projectRename.js';

test('rename input builds a sibling project path and rejects unsafe or unchanged names', () => {
  assert.equal(buildRenamePath('src/old.js', 'new.js', 'file'), 'src/new.js');
  assert.equal(buildRenamePath('src/old', 'new', 'folder'), 'src/new');
  for (const value of ['', '.', '..', '../escape.js', 'a/b', 'a\\b', 'bad?.js', 'trail.']) {
    assert.throws(() => buildRenamePath('old.js', value, 'file'), /valid name/);
  }
  assert.throws(() => buildRenamePath('old.js', 'old.js', 'file'), /different file/);
});

test('folder path remapping updates subtree paths and expanded folders using the longest match', () => {
  const mappings = [{ oldPath: 'src', newPath: 'source' }, { oldPath: 'src/app', newPath: 'source/application' }];
  assert.equal(remapProjectPath('src/app/main.js', mappings), 'source/application/main.js');
  assert.equal(remapProjectPath('src-other/main.js', mappings), 'src-other/main.js');
  assert.deepEqual([...remapExpandedFolders(new Set(['src', 'src/app']), mappings)], ['source', 'source/application']);
});

test('cross-client rename events identify the same document without changing its room identity', () => {
  const event = { type: 'rename', files: [{ documentId: 'doc-1', oldPath: 'old.js', newPath: 'new.js' }] };
  assert.deepEqual(getDocumentRename(event, 'doc-1'), event.files[0]);
  assert.equal(getDocumentRename(event, 'another-doc'), null);
});

test('folder-deletion project events clear a deleted selection and expansion', () => {
  const transition = getFolderDeletionTransition({ type: 'folder-deleted', folder: { path: 'src/empty' } }, {
    selectedFolder: 'src/empty',
    expandedFolders: new Set(['src', 'src/empty']),
  });
  assert.equal(transition.folderPath, 'src/empty');
  assert.equal(transition.selectedFolder, '');
  assert.deepEqual([...transition.expandedFolders], ['src']);
  assert.equal(getFolderDeletionTransition({ type: 'rename' }, {
    selectedFolder: '', expandedFolders: new Set(),
  }), null);
});

test('file and folder rename requests use the existing API and surface safe conflict messages', async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    return {
      ok: false,
      status: 409,
      json: async () => ({ error: 'The destination conflicts with an existing file' }),
    };
  };
  await assert.rejects(requestProjectRename({ backendHttpUrl: 'http://127.0.0.1:3001', kind: 'file',
    oldPath: 'a.js', newPath: 'b.js', fetchImpl }), /destination conflicts/);
  await assert.rejects(requestProjectRename({ backendHttpUrl: 'http://127.0.0.1:3001', kind: 'folder',
    oldPath: 'src', newPath: 'source', fetchImpl }), /destination conflicts/);
  assert.deepEqual(requests.map(({ url }) => url), [
    'http://127.0.0.1:3001/api/files/rename',
    'http://127.0.0.1:3001/api/folders/rename',
  ]);
  assert.ok(requests.every(({ options }) => options.method === 'POST'));

  await assert.rejects(requestProjectRename({ backendHttpUrl: 'http://127.0.0.1:3001', kind: 'file',
    oldPath: 'a.js', newPath: 'b.js', fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({ error: 'internal path leaked' }) }) }),
  error => error.message === 'Could not rename the file.' && error.isServerResponse);
});
