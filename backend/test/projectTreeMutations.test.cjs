const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codestudio-atomic-rename-'));
const previousDataDir = process.env.CODESTUDIO_DATA_DIR;
process.env.CODESTUDIO_DATA_DIR = dataDir;
const { mutateDBAtomically } = require('../mockMongoose');
if (previousDataDir === undefined) delete process.env.CODESTUDIO_DATA_DIR;
else process.env.CODESTUDIO_DATA_DIR = previousDataDir;

const { renameFolderMetadata, deleteEmptyFolderMetadata } = require('../projectTreeMutations');
const dbPath = path.join(dataDir, 'db.json');

function fixture() {
  return {
    files: [
      { _id: 'file-1', name: 'src/old/main.js', documentId: 'doc-1', historyKey: 'src/old/main.js' },
      { _id: 'file-2', name: 'src/old/deleted.js', documentId: 'doc-2', historyKey: 'src/old/deleted.js' },
    ],
    folders: [{ _id: 'folder-1', path: 'src' }, { _id: 'folder-2', path: 'src/old' }],
    filetombstones: [{ _id: 'tombstone-1', path: 'src/old/deleted.js', documentId: 'doc-2', deletedAt: 'test' }],
    members: [],
  };
}

after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

test('folder rename preflight rejects collisions without mutating its metadata snapshot', () => {
  const db = fixture();
  db.folders.push({ _id: 'folder-existing', path: 'src/occupied' });
  db.files.push({ _id: 'file-existing', name: 'src/occupied/existing.js', documentId: 'doc-existing', historyKey: 'doc-existing' });
  const before = JSON.stringify(db);
  const result = renameFolderMetadata(db, 'src/old', 'src/occupied');
  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
  assert.equal(JSON.stringify(db), before);
});

test('injected persistence failure leaves the complete metadata file unchanged', () => {
  fs.writeFileSync(dbPath, JSON.stringify(fixture(), null, 2));
  const before = fs.readFileSync(dbPath);

  assert.throws(() => mutateDBAtomically(db => {
    const result = renameFolderMetadata(db, 'src/old', 'src/new');
    assert.equal(result.ok, true);
    return { value: result };
  }, {
    beforeCommit() { throw new Error('injected persistence failure'); },
  }), /injected persistence failure/);

  assert.deepEqual(fs.readFileSync(dbPath), before);
  assert.deepEqual(fs.readdirSync(dataDir), ['db.json']);
});

test('empty-folder deletion leaves tombstoned file records and reservations unchanged', () => {
  const db = fixture();
  db.files = db.files.filter(file => file.documentId === 'doc-2');
  db.folders = [{ _id: 'folder-tombstoned', path: 'src/old' }];
  const beforeFile = structuredClone(db.files[0]);
  const beforeTombstone = structuredClone(db.filetombstones[0]);
  const result = deleteEmptyFolderMetadata(db, 'src/old');

  assert.deepEqual(result, { ok: true, path: 'src/old' });
  assert.deepEqual(db.files, [beforeFile]);
  assert.deepEqual(db.filetombstones, [beforeTombstone]);
  assert.deepEqual(db.folders, []);
});

test('folder deletion rejects live files, child folders, invalid paths, and missing folders without mutation', () => {
  const db = fixture();
  const before = JSON.stringify(db);
  const live = deleteEmptyFolderMetadata(db, 'src/old');
  assert.equal(live.status, 409);
  assert.equal(live.code, 'folder_not_empty');
  assert.equal(JSON.stringify(db), before);

  db.files = db.files.filter(file => file.documentId === 'doc-2');
  const beforeChild = JSON.stringify(db);
  const child = deleteEmptyFolderMetadata(db, 'src');
  assert.equal(child.status, 409);
  assert.equal(JSON.stringify(db), beforeChild);

  assert.equal(deleteEmptyFolderMetadata(db, '../src').status, 400);
  assert.equal(deleteEmptyFolderMetadata(db, 'missing').status, 404);
  assert.equal(JSON.stringify(db), beforeChild);
});

test('injected folder-deletion persistence failure keeps the original metadata file intact', () => {
  const emptyFolderDb = {
    files: [], members: [], folders: [{ _id: 'folder-empty', path: 'empty' }], filetombstones: [],
  };
  fs.writeFileSync(dbPath, JSON.stringify(emptyFolderDb, null, 2));
  const before = fs.readFileSync(dbPath);

  assert.throws(() => mutateDBAtomically(db => {
    const result = deleteEmptyFolderMetadata(db, 'empty');
    assert.equal(result.ok, true);
    return { value: result };
  }, { beforeCommit() { throw new Error('injected delete persistence failure'); } }), /injected delete persistence failure/);

  assert.deepEqual(fs.readFileSync(dbPath), before);
  assert.deepEqual(fs.readdirSync(dataDir), ['db.json']);
});
