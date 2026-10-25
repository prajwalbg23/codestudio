const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function resolveDataDirectory(env = process.env, backendDirectory = __dirname) {
  const configured = typeof env.CODESTUDIO_DATA_DIR === 'string'
    ? env.CODESTUDIO_DATA_DIR.trim()
    : '';

  if (env.NODE_ENV === 'production') {
    if (!configured) {
      throw new Error('Production requires CODESTUDIO_DATA_DIR to be explicitly configured.');
    }
    if (!path.isAbsolute(configured)) {
      throw new Error('Production CODESTUDIO_DATA_DIR must be an absolute path.');
    }
    return path.normalize(configured);
  }

  return path.resolve(configured || backendDirectory);
}

function probeWritableDirectory(directory) {
  const probePath = path.join(directory, `.codestudio-storage-check-${crypto.randomUUID()}.tmp`);
  let descriptor;
  try {
    descriptor = fs.openSync(probePath, 'wx', 0o600);
    fs.writeSync(descriptor, Buffer.from('ok'));
    fs.fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (fs.existsSync(probePath)) fs.unlinkSync(probePath);
  }
}

function validateProductionDataDirectory(dataDirectory) {
  let rootStat;
  try {
    rootStat = fs.statSync(dataDirectory);
    if (!rootStat.isDirectory()) throw new Error('not a directory');
    fs.accessSync(dataDirectory, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
  } catch {
    throw new Error('Production CODESTUDIO_DATA_DIR must be an existing readable and writable directory.');
  }

  const metadataPath = path.join(dataDirectory, 'db.json');
  try {
    if (fs.existsSync(metadataPath)) {
      if (!fs.statSync(metadataPath).isFile()) throw new Error('metadata path is not a file');
      fs.accessSync(metadataPath, fs.constants.R_OK | fs.constants.W_OK);
    }
    probeWritableDirectory(dataDirectory);
  } catch {
    throw new Error('Production CODESTUDIO_DATA_DIR cannot safely host the JSON metadata store.');
  }

  const yjsDirectory = path.join(dataDirectory, 'yjs_db');
  try {
    if (fs.existsSync(yjsDirectory) && !fs.statSync(yjsDirectory).isDirectory()) {
      throw new Error('Yjs path is not a directory');
    }
    fs.mkdirSync(yjsDirectory, { recursive: true });
    fs.accessSync(yjsDirectory, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
    probeWritableDirectory(yjsDirectory);
  } catch {
    throw new Error('Production CODESTUDIO_DATA_DIR cannot safely host Yjs history files.');
  }

  return dataDirectory;
}

module.exports = { resolveDataDirectory, validateProductionDataDirectory };
