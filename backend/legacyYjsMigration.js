const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const decoding = require('lib0/dist/decoding.cjs');
const YJS_VERSION = require('yjs/package.json').version;
const LIB0_VERSION = require('lib0/package.json').version;
const {
  YJS_LOG_MAGIC,
  MIGRATION_MANIFEST_NAME,
  MIGRATABLE_LEGACY_ROOMS,
  decodeUpdateLog,
  encodeUpdateFrame,
  sha256,
} = require('./yjsPersistence');

const REPORT_NAME = 'recovery-report.json';
const MAX_LEGACY_BYTES = 64 * 1024 * 1024;

function migrationError(code) {
  const error = new Error(`Legacy Yjs migration stopped (${code})`);
  error.code = code;
  return error;
}

function syncFile(filePath) {
  const fd = fs.openSync(filePath, 'r+');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function roomPaths(yjsDir, room) {
  const encoded = encodeURIComponent(room);
  return {
    legacy: path.join(yjsDir, `${encoded}.bin`),
    current: path.join(yjsDir, `${encoded}.ylog`),
  };
}

function parseLegacyUpdates(Y, bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw migrationError('legacy_history_empty');
  if (bytes.length > MAX_LEGACY_BYTES) throw migrationError('legacy_history_too_large');
  const decoder = decoding.createDecoder(bytes);
  const doc = new Y.Doc();
  const updates = [];
  try {
    while (decoder.pos < bytes.length) {
      const start = decoder.pos;
      try {
        Y.readUpdate(decoder, doc);
      } catch {
        throw migrationError('legacy_update_invalid');
      }
      if (decoder.pos <= start || decoder.pos > bytes.length) {
        throw migrationError('legacy_update_boundary_invalid');
      }
      updates.push(Buffer.from(bytes.subarray(start, decoder.pos)));
    }
    if (decoder.pos !== bytes.length || updates.length === 0) {
      throw migrationError('legacy_history_not_fully_consumed');
    }
    return { doc, updates, bytesConsumed: decoder.pos };
  } catch (error) {
    doc.destroy();
    throw error;
  }
}

function makeYlog(updates) {
  return Buffer.concat([YJS_LOG_MAGIC, ...updates.map(encodeUpdateFrame)]);
}

function stateVectorHash(Y, doc) {
  return sha256(Buffer.from(Y.encodeStateVector(doc)));
}

function assertStagedMatches(Y, recoveredDoc, stagedBytes, expectedUpdateCount) {
  const stagedUpdates = decodeUpdateLog(Y, stagedBytes);
  if (stagedUpdates.length !== expectedUpdateCount) throw migrationError('staged_update_count_mismatch');
  const stagedDoc = new Y.Doc();
  try {
    for (const update of stagedUpdates) Y.applyUpdate(stagedDoc, update);
    const recoveredText = recoveredDoc.getText('monaco').toString();
    if (!Buffer.from(Y.encodeStateVector(recoveredDoc)).equals(Buffer.from(Y.encodeStateVector(stagedDoc)))
      || stagedDoc.getText('monaco').toString() !== recoveredText) {
      throw migrationError('staged_document_state_mismatch');
    }
    return {
      stateVectorSha256: stateVectorHash(Y, stagedDoc),
      recoveredText,
    };
  } finally {
    stagedDoc.destroy();
  }
}

function makeUniqueRecoveryDir(baseDir) {
  fs.mkdirSync(baseDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const candidate = path.join(baseDir, `${timestamp}-${crypto.randomBytes(4).toString('hex')}`);
    try {
      fs.mkdirSync(candidate);
      return candidate;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  throw migrationError('recovery_directory_collision');
}

function relativeArtifactPath(recoveryDir, artifactPath) {
  const relative = path.relative(recoveryDir, artifactPath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw migrationError('artifact_path_invalid');
  }
  return relative;
}

function resolveArtifactPath(recoveryDir, relative) {
  if (typeof relative !== 'string' || path.isAbsolute(relative)) throw migrationError('artifact_path_invalid');
  const resolved = path.resolve(recoveryDir, relative);
  const rel = path.relative(recoveryDir, resolved);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw migrationError('artifact_path_invalid');
  return resolved;
}

function prepareLegacyMigration({ Y, dataDir, recoveryBaseDir = path.join(dataDir, 'yjs_recovery') }) {
  const yjsDir = path.join(dataDir, 'yjs_db');
  const relativeToYjs = path.relative(yjsDir, path.resolve(recoveryBaseDir));
  if (!relativeToYjs.startsWith('..') || path.isAbsolute(relativeToYjs)) {
    throw migrationError('recovery_directory_must_be_outside_yjs_db');
  }
  const manifestPath = path.join(yjsDir, MIGRATION_MANIFEST_NAME);
  if (fs.existsSync(manifestPath)) throw migrationError('migration_manifest_already_exists');

  for (const room of MIGRATABLE_LEGACY_ROOMS) {
    const { legacy, current } = roomPaths(yjsDir, room);
    if (!fs.existsSync(legacy)) throw migrationError('legacy_room_file_missing');
    if (!fs.statSync(legacy).isFile()) throw migrationError('legacy_room_file_invalid');
    if (fs.existsSync(current)) throw migrationError('history_file_already_exists');
  }

  const recoveryDir = makeUniqueRecoveryDir(path.resolve(recoveryBaseDir));
  const backupDir = path.join(recoveryDir, 'backups');
  const stagedDir = path.join(recoveryDir, 'staged');
  fs.mkdirSync(backupDir);
  fs.mkdirSync(stagedDir);
  const report = {
    version: 1,
    decoder: { yjs: YJS_VERSION, lib0: LIB0_VERSION },
    preparedAt: new Date().toISOString(),
    activationStatus: 'not_activated',
    rooms: {},
  };

  for (const room of MIGRATABLE_LEGACY_ROOMS) {
    const { legacy, current } = roomPaths(yjsDir, room);
    const originalBytes = fs.readFileSync(legacy);
    const sourceSha256 = sha256(originalBytes);
    const backupPath = path.join(backupDir, path.basename(legacy));
    fs.copyFileSync(legacy, backupPath, fs.constants.COPYFILE_EXCL);
    syncFile(backupPath);
    const backupBytes = fs.readFileSync(backupPath);
    const backupSha256 = sha256(backupBytes);
    if (backupBytes.length !== originalBytes.length || backupSha256 !== sourceSha256) {
      throw migrationError('backup_verification_failed');
    }

    const recovered = parseLegacyUpdates(Y, backupBytes);
    try {
      const stagedBytes = makeYlog(recovered.updates);
      const stagedPath = path.join(stagedDir, path.basename(current));
      fs.writeFileSync(stagedPath, stagedBytes, { flag: 'wx' });
      syncFile(stagedPath);
      const verifiedBytes = fs.readFileSync(stagedPath);
      if (sha256(verifiedBytes) !== sha256(stagedBytes)) throw migrationError('staged_history_verification_failed');
      const validation = assertStagedMatches(Y, recovered.doc, verifiedBytes, recovered.updates.length);

      report.rooms[room] = {
        sourceBytes: originalBytes.length,
        sourceSha256,
        backupPath: relativeArtifactPath(recoveryDir, backupPath),
        backupBytes: backupBytes.length,
        backupSha256,
        stagedPath: relativeArtifactPath(recoveryDir, stagedPath),
        stagedHistoryBytes: verifiedBytes.length,
        stagedHistorySha256: sha256(verifiedBytes),
        parsedUpdateCount: recovered.updates.length,
        parsedBytesConsumed: recovered.bytesConsumed,
        validation: {
          passed: true,
          method: 'fresh Y.Doc load; matching state vector and monaco text',
          stateVectorSha256: validation.stateVectorSha256,
          recoveredText: validation.recoveredText,
        },
      };
    } finally {
      recovered.doc.destroy();
    }
  }

  const reportPath = path.join(recoveryDir, REPORT_NAME);
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  return { recoveryDir, reportPath, report };
}

function validatePreparedReport({ Y, dataDir, reportPath }) {
  let report;
  try {
    report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  } catch {
    throw migrationError('recovery_report_invalid');
  }
  const names = report?.rooms && typeof report.rooms === 'object' ? Object.keys(report.rooms).sort() : [];
    if (report?.version !== 1 || report?.decoder?.yjs !== YJS_VERSION || report?.decoder?.lib0 !== LIB0_VERSION
    || report.activationStatus !== 'not_activated'
    || names.join(',') !== [...MIGRATABLE_LEGACY_ROOMS].sort().join(',')) {
    throw migrationError('recovery_report_invalid');
  }

  const recoveryDir = path.dirname(path.resolve(reportPath));
  const yjsDir = path.join(dataDir, 'yjs_db');
  const verifiedRooms = {};
  for (const room of MIGRATABLE_LEGACY_ROOMS) {
    const record = report.rooms[room];
    const { legacy, current } = roomPaths(yjsDir, room);
    const backupPath = resolveArtifactPath(recoveryDir, record.backupPath);
    const stagedPath = resolveArtifactPath(recoveryDir, record.stagedPath);
    const original = fs.readFileSync(legacy);
    const backup = fs.readFileSync(backupPath);
    const staged = fs.readFileSync(stagedPath);
    if (original.length !== record.sourceBytes || sha256(original) !== record.sourceSha256) {
      throw migrationError('source_hash_mismatch');
    }
    if (backup.length !== record.backupBytes || backup.length !== original.length
      || sha256(backup) !== record.backupSha256 || sha256(backup) !== record.sourceSha256) {
      throw migrationError('backup_hash_mismatch');
    }
    if (staged.length !== record.stagedHistoryBytes || sha256(staged) !== record.stagedHistorySha256) {
      throw migrationError('staged_history_hash_mismatch');
    }

    const recovered = parseLegacyUpdates(Y, backup);
    try {
      if (recovered.updates.length !== record.parsedUpdateCount
        || recovered.bytesConsumed !== record.parsedBytesConsumed) {
        throw migrationError('source_parse_validation_mismatch');
      }
      const validation = assertStagedMatches(Y, recovered.doc, staged, recovered.updates.length);
      if (!record.validation?.passed
        || validation.stateVectorSha256 !== record.validation.stateVectorSha256
        || validation.recoveredText !== record.validation.recoveredText) {
        throw migrationError('recovered_state_validation_mismatch');
      }
    } finally {
      recovered.doc.destroy();
    }

    if (fs.existsSync(current) && sha256(fs.readFileSync(current)) !== record.stagedHistorySha256) {
      throw migrationError('active_history_conflict');
    }
    verifiedRooms[room] = { record, legacy, current, stagedPath, stagedSha256: record.stagedHistorySha256 };
  }
  if (fs.existsSync(path.join(yjsDir, MIGRATION_MANIFEST_NAME))) {
    throw migrationError('migration_manifest_already_exists');
  }
  return { report, recoveryDir, yjsDir, verifiedRooms };
}

function publishManifestAtomically(manifestPath, contents) {
  const tempPath = `${manifestPath}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  let fd;
  try {
    fd = fs.openSync(tempPath, 'wx');
    fs.writeFileSync(fd, `${JSON.stringify(contents, null, 2)}\n`);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.linkSync(tempPath, manifestPath);
  } catch (error) {
    throw migrationError(error.code === 'EEXIST' ? 'migration_manifest_already_exists' : 'manifest_publish_failed');
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(tempPath); } catch { /* A leftover temporary link is harmless and never activates a room. */ }
  }
}

function activateLegacyMigration({ Y, dataDir, reportPath }) {
  const prepared = validatePreparedReport({ Y, dataDir, reportPath });
  for (const room of MIGRATABLE_LEGACY_ROOMS) {
    const item = prepared.verifiedRooms[room];
    if (!fs.existsSync(item.current)) {
      fs.copyFileSync(item.stagedPath, item.current, fs.constants.COPYFILE_EXCL);
    }
    syncFile(item.current);
    const installed = fs.readFileSync(item.current);
    if (sha256(installed) !== item.stagedSha256) throw migrationError('installed_history_verification_failed');
  }

  for (const room of MIGRATABLE_LEGACY_ROOMS) {
    const item = prepared.verifiedRooms[room];
    const source = fs.readFileSync(item.legacy);
    const history = fs.readFileSync(item.current);
    if (sha256(source) !== item.record.sourceSha256 || sha256(history) !== item.stagedSha256) {
      throw migrationError('activation_final_verification_failed');
    }
  }

  const manifest = {
    version: 1,
    historyFormat: 1,
    activatedAt: new Date().toISOString(),
    rooms: Object.fromEntries(MIGRATABLE_LEGACY_ROOMS.map(room => {
      const { record } = prepared.verifiedRooms[room];
      return [room, {
        sourceSha256: record.sourceSha256,
        historySha256: record.stagedHistorySha256,
        historyBytes: record.stagedHistoryBytes,
      }];
    })),
  };
  publishManifestAtomically(path.join(prepared.yjsDir, MIGRATION_MANIFEST_NAME), manifest);
  return manifest;
}

module.exports = {
  REPORT_NAME,
  parseLegacyUpdates,
  prepareLegacyMigration,
  validatePreparedReport,
  activateLegacyMigration,
  publishManifestAtomically,
};
