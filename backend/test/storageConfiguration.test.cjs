const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const {
  resolveDataDirectory,
  validateProductionDataDirectory,
} = require('../storageConfiguration');

test('production storage requires an explicit non-blank absolute path', () => {
  for (const value of [undefined, '', '   ']) {
    assert.throws(
      () => resolveDataDirectory({ NODE_ENV: 'production', CODESTUDIO_DATA_DIR: value }),
      /requires CODESTUDIO_DATA_DIR to be explicitly configured/,
    );
  }
  assert.throws(
    () => resolveDataDirectory({ NODE_ENV: 'production', CODESTUDIO_DATA_DIR: 'relative/project-data' }),
    /must be an absolute path/,
  );
});

test('production storage accepts an absolute usable directory and preserves existing data', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codestudio-storage-valid-'));
  try {
    const metadataBytes = Buffer.from('{"files":[]}');
    fs.writeFileSync(path.join(temporaryRoot, 'db.json'), metadataBytes);
    const yjsDirectory = path.join(temporaryRoot, 'yjs_db');
    fs.mkdirSync(yjsDirectory);
    const historyBytes = Buffer.from('existing-history-placeholder');
    fs.writeFileSync(path.join(yjsDirectory, 'kept.ylog'), historyBytes);

    const resolved = resolveDataDirectory({
      NODE_ENV: 'production',
      CODESTUDIO_DATA_DIR: temporaryRoot,
    });
    assert.equal(resolved, path.normalize(temporaryRoot));
    assert.equal(validateProductionDataDirectory(resolved), resolved);
    assert.deepEqual(fs.readFileSync(path.join(temporaryRoot, 'db.json')), metadataBytes);
    assert.deepEqual(fs.readFileSync(path.join(yjsDirectory, 'kept.ylog')), historyBytes);
    assert.deepEqual(fs.readdirSync(temporaryRoot).sort(), ['db.json', 'yjs_db']);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test('production validation creates the Yjs directory but rejects an unusable root', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codestudio-storage-yjs-'));
  const filePath = path.join(temporaryRoot, 'not-a-directory');
  try {
    assert.equal(validateProductionDataDirectory(temporaryRoot), temporaryRoot);
    assert.equal(fs.statSync(path.join(temporaryRoot, 'yjs_db')).isDirectory(), true);

    fs.writeFileSync(filePath, 'safe test fixture');
    assert.throws(() => validateProductionDataDirectory(filePath), /existing readable and writable directory/);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test('production validation rejects a metadata path that is not a writable file', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codestudio-storage-metadata-'));
  try {
    fs.mkdirSync(path.join(temporaryRoot, 'db.json'));
    assert.throws(() => validateProductionDataDirectory(temporaryRoot), /JSON metadata store/);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test('production validation rejects a Yjs history path that is not a directory', () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codestudio-storage-history-'));
  try {
    fs.writeFileSync(path.join(temporaryRoot, 'yjs_db'), 'safe test fixture');
    assert.throws(() => validateProductionDataDirectory(temporaryRoot), /Yjs history files/);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test('development storage defaults and relative-path behavior remain compatible', () => {
  const backendDirectory = path.resolve('backend');
  assert.equal(resolveDataDirectory({ NODE_ENV: 'development' }, backendDirectory), backendDirectory);
  assert.equal(resolveDataDirectory({ NODE_ENV: 'development', CODESTUDIO_DATA_DIR: 'test-data' }, backendDirectory), path.resolve('test-data'));
});
