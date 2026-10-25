const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const YJS_LOG_MAGIC = Buffer.from('CSYJ\x01\r\n', 'binary');
const CHECKSUM_BYTES = 32;
const FRAME_HEADER_BYTES = 4 + CHECKSUM_BYTES;
const MAX_UPDATE_BYTES = 64 * 1024 * 1024;
const MIGRATION_MANIFEST_NAME = 'codestudio-legacy-yjs-v1.json';
const MIGRATABLE_LEGACY_ROOMS = ['script.js', 'test.js'];

class YjsHistoryError extends Error {
  constructor(code) {
    super(`Yjs history unavailable (${code})`);
    this.name = 'YjsHistoryError';
    this.code = code;
  }
}

function historyError(code) {
  return new YjsHistoryError(code);
}

function checksum(update) {
  return crypto.createHash('sha256').update(update).digest();
}

function encodeUpdateFrame(update) {
  const bytes = Buffer.from(update);
  if (bytes.length === 0 || bytes.length > MAX_UPDATE_BYTES) {
    throw historyError('invalid_update_length');
  }

  const header = Buffer.alloc(FRAME_HEADER_BYTES);
  header.writeUInt32BE(bytes.length, 0);
  checksum(bytes).copy(header, 4);
  return Buffer.concat([header, bytes]);
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function writeAllSync(fd, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const written = fs.writeSync(fd, bytes, offset, bytes.length - offset);
    if (written <= 0) throw new Error('Could not persist complete Yjs update');
    offset += written;
  }
}

function decodeUpdateLog(Y, bytes) {
  if (bytes.length < YJS_LOG_MAGIC.length
    || !bytes.subarray(0, YJS_LOG_MAGIC.length).equals(YJS_LOG_MAGIC)) {
    throw historyError('invalid_log_header');
  }

  const updates = [];
  const validator = new Y.Doc();
  let offset = YJS_LOG_MAGIC.length;
  try {
    if (offset === bytes.length) throw historyError('truncated_first_frame');
    while (offset < bytes.length) {
      if (bytes.length - offset < FRAME_HEADER_BYTES) throw historyError('truncated_frame_header');
      const updateLength = bytes.readUInt32BE(offset);
      if (updateLength === 0 || updateLength > MAX_UPDATE_BYTES) throw historyError('invalid_update_length');
      const updateStart = offset + FRAME_HEADER_BYTES;
      const updateEnd = updateStart + updateLength;
      if (updateEnd > bytes.length) throw historyError('truncated_update');
      const expectedChecksum = bytes.subarray(offset + 4, updateStart);
      const update = bytes.subarray(updateStart, updateEnd);
      if (!checksum(update).equals(expectedChecksum)) throw historyError('checksum_mismatch');
      try {
        Y.applyUpdate(validator, update);
      } catch {
        throw historyError('invalid_update_data');
      }
      updates.push(Buffer.from(update));
      offset = updateEnd;
    }
  } finally {
    validator.destroy();
  }
  return updates;
}

function validateMigrationManifest({ docName, legacyPath, currentPath, manifestPath }) {
  if (!MIGRATABLE_LEGACY_ROOMS.includes(docName)) return { ok: false, code: 'legacy_history_requires_migration' };
  if (!fs.existsSync(manifestPath)) return { ok: false, code: 'legacy_history_requires_migration' };

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return { ok: false, code: 'migration_manifest_invalid' };
  }
  const roomNames = manifest?.rooms && typeof manifest.rooms === 'object'
    ? Object.keys(manifest.rooms).sort()
    : [];
  if (manifest?.version !== 1
    || roomNames.join(',') !== [...MIGRATABLE_LEGACY_ROOMS].sort().join(',')
    || manifest?.historyFormat !== 1) {
    return { ok: false, code: 'migration_manifest_invalid' };
  }

  const record = manifest.rooms[docName];
  if (!record || !/^[a-f0-9]{64}$/.test(record.sourceSha256 || '')
    || !/^[a-f0-9]{64}$/.test(record.historySha256 || '')) {
    return { ok: false, code: 'migration_manifest_invalid' };
  }

  try {
    if (sha256(fs.readFileSync(legacyPath)) !== record.sourceSha256) {
      return { ok: false, code: 'migration_source_hash_mismatch' };
    }
    if (!Number.isSafeInteger(record.historyBytes) || record.historyBytes <= 0 || !fs.existsSync(currentPath)) {
      return { ok: false, code: 'migration_history_hash_mismatch' };
    }
    const history = fs.readFileSync(currentPath);
    if (history.length < record.historyBytes
      || sha256(history.subarray(0, record.historyBytes)) !== record.historySha256) {
      return { ok: false, code: 'migration_history_hash_mismatch' };
    }
  } catch {
    return { ok: false, code: 'migration_history_unreadable' };
  }
  return { ok: true, record };
}

function createYjsPersistence({ Y, dataDir, onRoomUnavailable = () => {} }) {
  const yjsDir = path.join(dataDir, 'yjs_db');
  fs.mkdirSync(yjsDir, { recursive: true });
  const unavailableRooms = new Map();
  const historyKeysByRoom = new Map();

  function registerRoom(documentId, historyKey) {
    if (typeof documentId !== 'string' || !documentId || typeof historyKey !== 'string' || !historyKey) {
      throw historyError('document_identity_unavailable');
    }
    const existing = historyKeysByRoom.get(documentId);
    if (existing !== undefined && existing !== historyKey) {
      throw historyError('document_identity_conflict');
    }
    historyKeysByRoom.set(documentId, historyKey);
  }

  function historyKeyFor(documentId) {
    const historyKey = historyKeysByRoom.get(documentId);
    if (!historyKey) throw historyError('document_identity_unavailable');
    return historyKey;
  }

  function getPaths(docName) {
    const encodedName = encodeURIComponent(docName);
    return {
      legacy: path.join(yjsDir, `${encodedName}.bin`),
      current: path.join(yjsDir, `${encodedName}.ylog`),
      manifest: path.join(yjsDir, MIGRATION_MANIFEST_NAME),
    };
  }

  function markUnavailable(docName, error, doc) {
    const reason = error instanceof YjsHistoryError
      ? error
      : historyError('storage_error');
    unavailableRooms.set(docName, reason);
    onRoomUnavailable(docName, reason, doc);
    return reason;
  }

  function readUpdates(docName) {
    const { legacy, current, manifest } = getPaths(docName);
    if (fs.existsSync(legacy)) {
      const activation = validateMigrationManifest({
        docName,
        legacyPath: legacy,
        currentPath: current,
        manifestPath: manifest,
      });
      if (!activation.ok) throw historyError(activation.code);
      if (!fs.existsSync(current)) throw historyError('migration_history_missing');
    }
    if (!fs.existsSync(current)) return [];

    let bytes;
    try {
      bytes = fs.readFileSync(current);
    } catch {
      throw historyError('history_read_failed');
    }

    try {
      return decodeUpdateLog(Y, bytes);
    } catch (error) {
      throw error instanceof YjsHistoryError ? error : historyError('invalid_update_data');
    }
  }

  function appendUpdate(docName, update) {
    const { legacy, current, manifest } = getPaths(docName);
    if (fs.existsSync(legacy)) {
      const activation = validateMigrationManifest({
        docName,
        legacyPath: legacy,
        currentPath: current,
        manifestPath: manifest,
      });
      if (!activation.ok) throw historyError(activation.code);
    }
    const frame = encodeUpdateFrame(update);
    let fd;
    try {
      if (fs.existsSync(current)) {
        fd = fs.openSync(current, 'a');
        writeAllSync(fd, frame);
      } else {
        fd = fs.openSync(current, 'wx');
        writeAllSync(fd, Buffer.concat([YJS_LOG_MAGIC, frame]));
      }
      // A revision is exposed only after the update log has been flushed.
      fs.fsyncSync(fd);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }

  function bindState(docName, doc) {
    if (unavailableRooms.has(docName)) {
      throw unavailableRooms.get(docName);
    }

    let updates;
    try {
      const historyKey = historyKeyFor(docName);
      updates = readUpdates(historyKey);
      for (const update of updates) Y.applyUpdate(doc, update);
    } catch (error) {
      const reason = markUnavailable(docName, error, doc);
      if (doc.awareness && typeof doc.awareness.destroy === 'function') doc.awareness.destroy();
      doc.destroy();
      throw reason;
    }

    doc.on('update', update => {
      if (unavailableRooms.has(docName)) return;
      try {
        appendUpdate(historyKeyFor(docName), update);
      } catch (error) {
        markUnavailable(docName, error, doc);
      }
    });
  }

  // Search snapshots replay validated history into a temporary document only.
  // They do not attach update listeners, create WebSocket providers, or write history.
  function readDocumentText(docName) {
    const doc = new Y.Doc();
    try {
      const updates = readUpdates(historyKeyFor(docName));
      for (const update of updates) Y.applyUpdate(doc, update);
      return doc.getText('monaco').toString();
    } finally {
      doc.destroy();
    }
  }

  // Revision IDs identify an exact prefix of the append-only, validated log.
  // IDs are recomputed from disk, so restart recovery produces the same values.
  function readDocumentRevision(docName, requestedRevisionId) {
    const historyKey = historyKeyFor(docName);
    const updates = readUpdates(historyKey);
    const doc = new Y.Doc();
    const revisionHasher = crypto.createHash('sha256').update(historyKey).update(Buffer.from([0])).update(YJS_LOG_MAGIC);
    let revision = null;

    try {
      for (const update of updates) {
        Y.applyUpdate(doc, update);
        revisionHasher.update(encodeUpdateFrame(update));
        const revisionId = `yrev1_${revisionHasher.copy().digest('hex')}`;
        if (!requestedRevisionId || requestedRevisionId === revisionId) {
          revision = {
            revisionId,
            source: doc.getText('monaco').toString(),
            stateVector: Buffer.from(Y.encodeStateVector(doc)).toString('base64'),
          };
        }
      }
      return revision;
    } finally {
      doc.destroy();
    }
  }

  return {
    persistence: {
      bindState,
      writeState: async () => {},
    },
    registerRoom,
    getRoomError: docName => unavailableRooms.get(docName),
    readDocumentText,
    readDocumentRevision,
  };
}

module.exports = {
  YJS_LOG_MAGIC,
  MIGRATION_MANIFEST_NAME,
  MIGRATABLE_LEGACY_ROOMS,
  decodeUpdateLog,
  encodeUpdateFrame,
  sha256,
  validateMigrationManifest,
  createYjsPersistence,
};
