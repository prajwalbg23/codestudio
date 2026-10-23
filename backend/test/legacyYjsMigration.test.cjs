const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const Y = require('yjs');
const {
  MIGRATION_MANIFEST_NAME,
  MIGRATABLE_LEGACY_ROOMS,
  YJS_LOG_MAGIC,
  encodeUpdateFrame,
  createYjsPersistence,
} = require('../yjsPersistence');
const {
  REPORT_NAME,
  parseLegacyUpdates,
  prepareLegacyMigration,
  validatePreparedReport,
  activateLegacyMigration,
} = require('../legacyYjsMigration');

function withTemporaryStore(run) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codestudio-yjs-migration-'));
  fs.mkdirSync(path.join(dataDir, 'yjs_db'));
  try {
    return run(dataDir);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

function roomPath(dataDir, room, extension) {
  return path.join(dataDir, 'yjs_db', `${encodeURIComponent(room)}.${extension}`);
}

function makeLegacyStream(text) {
  const doc = new Y.Doc();
  const updates = [];
  doc.on('update', update => updates.push(Buffer.from(update)));
  const ytext = doc.getText('monaco');
  for (const character of text) ytext.insert(ytext.length, character);
  doc.destroy();
  return Buffer.concat(updates);
}

function makeCurrentLog(updates) {
  return Buffer.concat([YJS_LOG_MAGIC, ...updates.map(encodeUpdateFrame)]);
}

function makeCurrentLogFromText(text) {
  const parsed = parseLegacyUpdates(Y, makeLegacyStream(text));
  try { return makeCurrentLog(parsed.updates); } finally { parsed.doc.destroy(); }
}

function hash(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function makeManifest(dataDir, overrides = {}) {
  const rooms = {};
  for (const room of MIGRATABLE_LEGACY_ROOMS) {
    const legacy = fs.readFileSync(roomPath(dataDir, room, 'bin'));
    const history = fs.readFileSync(roomPath(dataDir, room, 'ylog'));
    rooms[room] = {
      sourceSha256: hash(legacy),
      historySha256: hash(history),
      historyBytes: history.length,
    };
  }
  return {
    version: 1,
    historyFormat: 1,
    activatedAt: new Date(0).toISOString(),
    rooms: { ...rooms, ...overrides },
  };
}

function assertRoomRejected(dataDir, room, expectedCode) {
  const persistence = createYjsPersistence({ Y, dataDir });
  const doc = new Y.Doc();
  assert.throws(() => persistence.persistence.bindState(room, doc), error => {
    assert.equal(error.code, expectedCode);
    return true;
  });
  assert.equal(persistence.getRoomError(room).code, expectedCode);
}

test('preparation verifies backups and staged Yjs state, then explicit activation preserves originals', () => {
  withTemporaryStore(dataDir => {
    const expected = {
      'script.js': 'first change',
      'test.js': 'second test document',
    };
    const originals = {};
    for (const room of MIGRATABLE_LEGACY_ROOMS) {
      originals[room] = makeLegacyStream(expected[room]);
      fs.writeFileSync(roomPath(dataDir, room, 'bin'), originals[room]);
    }

    const prepared = prepareLegacyMigration({ Y, dataDir });
    assert.equal(path.basename(prepared.reportPath), REPORT_NAME);
    assert.equal(fs.existsSync(path.join(dataDir, 'yjs_db', MIGRATION_MANIFEST_NAME)), false);
    for (const room of MIGRATABLE_LEGACY_ROOMS) {
      const record = prepared.report.rooms[room];
      const backup = fs.readFileSync(path.join(prepared.recoveryDir, record.backupPath));
      const staged = fs.readFileSync(path.join(prepared.recoveryDir, record.stagedPath));
      assert.deepEqual(backup, originals[room]);
      assert.equal(record.backupSha256, record.sourceSha256);
      assert.equal(record.parsedBytesConsumed, originals[room].length);
      assert.ok(record.parsedUpdateCount > 1);
      assert.equal(record.validation.passed, true);
      assert.equal(record.validation.recoveredText, expected[room]);
      assert.equal(fs.existsSync(roomPath(dataDir, room, 'ylog')), false);
      assert.ok(staged.length > 0);
    }
    for (const room of MIGRATABLE_LEGACY_ROOMS) {
      assert.deepEqual(fs.readFileSync(roomPath(dataDir, room, 'bin')), originals[room]);
    }

    activateLegacyMigration({ Y, dataDir, reportPath: prepared.reportPath });
    const manifestPath = path.join(dataDir, 'yjs_db', MIGRATION_MANIFEST_NAME);
    assert.ok(fs.existsSync(manifestPath));
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.deepEqual(Object.keys(manifest.rooms).sort(), [...MIGRATABLE_LEGACY_ROOMS].sort());

    for (const room of MIGRATABLE_LEGACY_ROOMS) {
      const persistence = createYjsPersistence({ Y, dataDir });
      const recovered = new Y.Doc();
      persistence.persistence.bindState(room, recovered);
      assert.equal(recovered.getText('monaco').toString(), expected[room]);
      recovered.getText('monaco').insert(recovered.getText('monaco').length, '!');
      const reloaded = new Y.Doc();
      createYjsPersistence({ Y, dataDir }).persistence.bindState(room, reloaded);
      assert.equal(reloaded.getText('monaco').toString(), `${expected[room]}!`);
      recovered.destroy();
      reloaded.destroy();
      assert.deepEqual(fs.readFileSync(roomPath(dataDir, room, 'bin')), originals[room]);
    }
  });
});

test('truncated and corrupt legacy streams fail closed without changing original bytes', () => {
  const valid = makeLegacyStream('truncated legacy sequence');
  const invalidInputs = [valid.subarray(0, valid.length - 1), Buffer.from([0xff, 0xff, 0xff])];
  for (const bytes of invalidInputs) {
    assert.throws(() => parseLegacyUpdates(Y, bytes));
  }

  withTemporaryStore(dataDir => {
    const validOther = makeLegacyStream('untouched second room');
    fs.writeFileSync(roomPath(dataDir, 'script.js', 'bin'), invalidInputs[0]);
    fs.writeFileSync(roomPath(dataDir, 'test.js', 'bin'), validOther);
    const before = fs.readFileSync(roomPath(dataDir, 'script.js', 'bin'));
    assert.throws(() => prepareLegacyMigration({ Y, dataDir }));
    assert.deepEqual(fs.readFileSync(roomPath(dataDir, 'script.js', 'bin')), before);
    assert.equal(fs.existsSync(roomPath(dataDir, 'script.js', 'ylog')), false);
  });
});

test('preparation rejects changed backup or source hashes before activation', () => {
  withTemporaryStore(dataDir => {
    for (const room of MIGRATABLE_LEGACY_ROOMS) {
      fs.writeFileSync(roomPath(dataDir, room, 'bin'), makeLegacyStream(`valid ${room}`));
    }
    const prepared = prepareLegacyMigration({ Y, dataDir });
    const record = prepared.report.rooms['script.js'];
    const backupPath = path.join(prepared.recoveryDir, record.backupPath);
    fs.appendFileSync(backupPath, Buffer.from([0]));
    assert.throws(() => validatePreparedReport({ Y, dataDir, reportPath: prepared.reportPath }), { code: 'backup_hash_mismatch' });

    fs.writeFileSync(backupPath, fs.readFileSync(roomPath(dataDir, 'script.js', 'bin')));
    fs.appendFileSync(roomPath(dataDir, 'script.js', 'bin'), Buffer.from([0]));
    assert.throws(() => validatePreparedReport({ Y, dataDir, reportPath: prepared.reportPath }), { code: 'source_hash_mismatch' });
  });
});

test('activation rejects a staged history file changed after the recovery report was created', () => {
  withTemporaryStore(dataDir => {
    for (const room of MIGRATABLE_LEGACY_ROOMS) {
      fs.writeFileSync(roomPath(dataDir, room, 'bin'), makeLegacyStream(`staged ${room}`));
    }
    const prepared = prepareLegacyMigration({ Y, dataDir });
    const stagedPath = path.join(prepared.recoveryDir, prepared.report.rooms['script.js'].stagedPath);
    const altered = fs.readFileSync(stagedPath);
    altered[altered.length - 1] ^= 0x01;
    fs.writeFileSync(stagedPath, altered);
    assert.throws(() => validatePreparedReport({ Y, dataDir, reportPath: prepared.reportPath }), { code: 'staged_history_hash_mismatch' });
    assert.equal(fs.existsSync(roomPath(dataDir, 'script.js', 'ylog')), false);
  });
});

test('a .ylog without a manifest does not bypass the legacy guard', () => {
  withTemporaryStore(dataDir => {
    fs.writeFileSync(roomPath(dataDir, 'script.js', 'bin'), makeLegacyStream('preserved source'));
    fs.writeFileSync(roomPath(dataDir, 'test.js', 'bin'), makeLegacyStream('other room'));
    fs.writeFileSync(roomPath(dataDir, 'script.js', 'ylog'), makeCurrentLogFromText('incorrect shortcut'));
    assertRoomRejected(dataDir, 'script.js', 'legacy_history_requires_migration');
  });
});

test('manifest with an incorrect source hash keeps legacy room unavailable', () => {
  withTemporaryStore(dataDir => {
    for (const room of MIGRATABLE_LEGACY_ROOMS) {
      fs.writeFileSync(roomPath(dataDir, room, 'bin'), makeLegacyStream(`source ${room}`));
      fs.writeFileSync(roomPath(dataDir, room, 'ylog'), makeCurrentLogFromText(`history ${room}`));
    }
    const manifest = makeManifest(dataDir);
    manifest.rooms['script.js'].sourceSha256 = '0'.repeat(64);
    fs.writeFileSync(path.join(dataDir, 'yjs_db', MIGRATION_MANIFEST_NAME), JSON.stringify(manifest));
    assertRoomRejected(dataDir, 'script.js', 'migration_source_hash_mismatch');
  });
});

test('manifest with a staged-history hash mismatch keeps legacy room unavailable', () => {
  withTemporaryStore(dataDir => {
    for (const room of MIGRATABLE_LEGACY_ROOMS) {
      fs.writeFileSync(roomPath(dataDir, room, 'bin'), makeLegacyStream(`source ${room}`));
      fs.writeFileSync(roomPath(dataDir, room, 'ylog'), makeCurrentLogFromText(`history ${room}`));
    }
    const manifest = makeManifest(dataDir);
    manifest.rooms['script.js'].historySha256 = '0'.repeat(64);
    fs.writeFileSync(path.join(dataDir, 'yjs_db', MIGRATION_MANIFEST_NAME), JSON.stringify(manifest));
    assertRoomRejected(dataDir, 'script.js', 'migration_history_hash_mismatch');
  });
});

test('installed history without the final manifest models interrupted activation and remains unavailable', () => {
  withTemporaryStore(dataDir => {
    const originals = {};
    for (const room of MIGRATABLE_LEGACY_ROOMS) {
      originals[room] = makeLegacyStream(`recover ${room}`);
      fs.writeFileSync(roomPath(dataDir, room, 'bin'), originals[room]);
    }
    const prepared = prepareLegacyMigration({ Y, dataDir });
    for (const room of MIGRATABLE_LEGACY_ROOMS) {
      const stagedPath = path.join(prepared.recoveryDir, prepared.report.rooms[room].stagedPath);
      fs.copyFileSync(stagedPath, roomPath(dataDir, room, 'ylog'), fs.constants.COPYFILE_EXCL);
    }
    assertRoomRejected(dataDir, 'script.js', 'legacy_history_requires_migration');
    assertRoomRejected(dataDir, 'test.js', 'legacy_history_requires_migration');
    for (const room of MIGRATABLE_LEGACY_ROOMS) {
      assert.deepEqual(fs.readFileSync(roomPath(dataDir, room, 'bin')), originals[room]);
    }
    assert.equal(fs.existsSync(path.join(dataDir, 'yjs_db', MIGRATION_MANIFEST_NAME)), false);
  });
});
