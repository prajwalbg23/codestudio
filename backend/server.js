// backend/server.js
require('dotenv').config();

// Intercept mongoose imports to use mockMongoose instead
const mockMongoose = require('./mockMongoose');
require.cache[require.resolve('mongoose')] = {
  exports: mockMongoose
};

const express = require('express');
const cors = require('cors');
const http = require('http');
const crypto = require('node:crypto');
const { Server } = require('ws');
const { setupWSConnection } = require('y-websocket/bin/utils');
const yUtils = require('y-websocket/bin/utils');
const Y = require('yjs');
const mongoose = require('mongoose');
const File = require('./models/File');
const Folder = require('./models/Folder');
const Member = require('./models/Member');
const { createYjsPersistence } = require('./yjsPersistence');
const { searchText: searchProjectText, DEFAULT_RESULT_LIMIT } = require('./projectSearch');
const { BACKEND_BIND_HOST, isAllowedFrontendOrigin } = require('./networkBoundary');
const { isValidProjectPath, parentProjectPath, projectPathAncestors } = require('./projectPaths');


const app = express();
const PORT = process.env.PORT || 3001;
const EXECUTION_UNAVAILABLE_REASON = 'JavaScript execution is disabled because a verified local isolation runtime is unavailable.';
let projectMutationQueue = Promise.resolve();

function queueProjectMutation(mutation) {
  const operation = projectMutationQueue.then(mutation, mutation);
  projectMutationQueue = operation.catch(() => {});
  return operation;
}
const SUPPORTED_FILE_LANGUAGES = new Set([
  'javascript', 'typescript', 'python', 'java', 'c', 'cpp', 'html', 'css', 'json', 'markdown',
  'scss', 'less', 'csharp', 'go', 'rust', 'yaml', 'xml', 'sql', 'shell', 'plaintext',
  'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'py', 'sh', 'yml', 'md',
]);
const LANGUAGE_BY_EXTENSION = {
  java: 'java',
  c: 'c',
  py: 'python',
  html: 'html',
  htm: 'html',
  css: 'css',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  md: 'markdown',
};

function isSupportedFileLanguage(language) {
  return typeof language === 'string'
    && SUPPORTED_FILE_LANGUAGES.has(language.trim().toLowerCase());
}

function getFileLanguage(name, requestedLanguage) {
  if (isSupportedFileLanguage(requestedLanguage)) {
    return { language: requestedLanguage, languageSource: 'explicit' };
  }
  const extension = String(name).split('.').pop()?.toLowerCase() || '';
  return {
    language: LANGUAGE_BY_EXTENSION[extension] || 'javascript',
    languageSource: 'extension',
  };
}

function languageForExistingFile(file) {
  if (isSupportedFileLanguage(file.language)) {
    if (file.languageSource === 'explicit' || file.languageSource === 'extension') return file.language;
    // Before languageSource was recorded, the backend defaulted unknown extensions
    // to JavaScript. Infer those legacy defaults without rewriting stored records.
    if (file.language.trim().toLowerCase() !== 'javascript') return file.language;
  }
  return getFileLanguage(file.name).language;
}

// Browsers can call the local API only from the project's default Vite dev/preview
// origins. Requests without Origin remain available for local command-line tools.
app.use((req, res, next) => {
  const origin = req.get('Origin');
  if (origin && !isAllowedFrontendOrigin(origin)) {
    return res.status(403).json({ error: 'Origin not allowed' });
  }
  next();
});
app.use(cors({
  origin: (origin, callback) => callback(null, isAllowedFrontendOrigin(origin) ? origin : false),
}));
app.use(express.json());

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI)
.then(async () => {
  console.log('✅ Connected to MongoDB');
  // Seed default files if db is empty
  const count = await File.countDocuments();
  if (count === 0) {
    await File.insertMany([
      { name: 'script.js', language: 'javascript' },
      { name: 'style.css', language: 'css' },
      { name: 'index.html', language: 'html' },
    ]);
    console.log('✅ Seeded default files');
  }
})
.catch(err => console.error('❌ MongoDB connection error:', err));

// Tests may redirect persistence to the same isolated temporary directory
// used by the JSON store. Normal runs keep using backend/yjs_db.
const DATA_DIR = process.env.CODESTUDIO_DATA_DIR || __dirname;
const yjsPersistence = createYjsPersistence({
  Y,
  dataDir: DATA_DIR,
  onRoomUnavailable: (docName, error, doc) => {
    console.error(`Yjs room ${encodeURIComponent(docName).slice(0, 120)} unavailable (${error.code})`);
    if (doc && doc.conns) {
      for (const conn of doc.conns.keys()) {
        try {
          conn.close(1011, 'Document history unavailable');
        } catch {
          // The connection may already be closing.
        }
      }
    }
  },
});
yUtils.setPersistence(yjsPersistence.persistence);

app.get('/api/files', async (req, res) => {
  try {
    const files = await File.find({});
    res.json(files.map(f => f.name));
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch files' });
  }
});

app.get('/api/folders', async (req, res) => {
  try {
    const folders = await Folder.find({});
    res.json(folders.map(folder => folder.path).sort((a, b) => a.localeCompare(b)));
  } catch {
    res.status(500).json({ error: 'Failed to fetch folders' });
  }
});

app.get('/api/execution-capability', (req, res) => {
  res.json({ available: false, reason: EXECUTION_UNAVAILABLE_REASON });
});

// Fail closed. Do not execute code in the collaboration server process.
app.post('/api/executions', (req, res) => {
  res.status(503).json({ error: EXECUTION_UNAVAILABLE_REASON });
});

app.get('/api/files/:filename/revisions/latest', async (req, res) => {
  try {
    if (!isValidProjectPath(req.params.filename)) {
      return res.status(400).json({ error: 'Invalid project-relative file path' });
    }
    const file = await File.findOne({ name: req.params.filename });
    if (!file) return res.status(404).json({ error: 'File not found' });
    const revision = yjsPersistence.readDocumentRevision(file.name);
    if (!revision) return res.status(404).json({ error: 'No persisted document revision is available' });
    const { source, ...metadata } = revision;
    res.json({ ...metadata, sourceHash: crypto.createHash('sha256').update(source).digest('hex') });
  } catch (error) {
    const roomError = yjsPersistence.getRoomError(req.params.filename);
    res.status(503).json({
      error: roomError ? 'Document history is unavailable' : 'Could not read persisted document revision',
      code: roomError?.code || 'revision_unavailable',
    });
  }
});

app.get('/api/files/:filename/revisions/:revisionId', async (req, res) => {
  try {
    if (!/^yrev1_[a-f0-9]{64}$/.test(req.params.revisionId)) {
      return res.status(400).json({ error: 'Invalid document revision identifier' });
    }
    if (!isValidProjectPath(req.params.filename)) {
      return res.status(400).json({ error: 'Invalid project-relative file path' });
    }
    const file = await File.findOne({ name: req.params.filename });
    if (!file) return res.status(404).json({ error: 'File not found' });
    const revision = yjsPersistence.readDocumentRevision(file.name, req.params.revisionId);
    if (!revision) return res.status(404).json({ error: 'Persisted document revision not found' });
    const { source, ...metadata } = revision;
    res.json({ ...metadata, sourceHash: crypto.createHash('sha256').update(source).digest('hex') });
  } catch (error) {
    const roomError = yjsPersistence.getRoomError(req.params.filename);
    res.status(503).json({
      error: roomError ? 'Document history is unavailable' : 'Could not read persisted document revision',
      code: roomError?.code || 'revision_unavailable',
    });
  }
});

app.get('/api/files/:filename', async (req, res) => {
  try {
    if (!isValidProjectPath(req.params.filename)) {
      return res.status(400).json({ error: 'Invalid project-relative file path' });
    }
    const file = await File.findOne({ name: req.params.filename });
    if (!file) {
      return res.status(404).json({ error: 'File not found' });
    }
    res.json({ language: languageForExistingFile(file) });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch file' });
  }
});

app.post('/api/search', async (req, res) => {
  const { query, caseSensitive = false, wholeWord = false, excludeFileName } = req.body || {};
  if (typeof query !== 'string' || !query.trim() || query.trim().length > 200
    || typeof caseSensitive !== 'boolean' || typeof wholeWord !== 'boolean'
    || (excludeFileName !== undefined
      && (!isValidProjectPath(excludeFileName) || excludeFileName.length > 255))) {
    return res.status(400).json({ error: 'Invalid project search request' });
  }

  try {
    const files = await File.find({});
    const results = [];
    const unavailableFiles = [];
    let truncated = false;

    for (const file of files) {
      if (file.name === excludeFileName) continue;
      try {
        const text = yjsPersistence.readDocumentText(file.name);
        const matches = searchProjectText(text, query, file.name, { caseSensitive, wholeWord }, DEFAULT_RESULT_LIMIT - results.length);
        results.push(...matches);
        if (results.length >= DEFAULT_RESULT_LIMIT) {
          truncated = true;
          break;
        }
      } catch {
        unavailableFiles.push(file.name);
      }
    }

    res.json({ results, unavailableFiles, truncated });
  } catch {
    res.status(500).json({ error: 'Failed to search project files' });
  }
});

app.post('/api/files', async (req, res) => {
  try {
    await queueProjectMutation(async () => {
      const { name, language } = req.body || {};
      if (!name) return res.status(400).json({ error: 'Name is required' });
      if (!isValidProjectPath(name)) {
        return res.status(400).json({ error: 'Invalid project-relative file path' });
      }

      const [files, folders] = await Promise.all([File.find({}), Folder.find({})]);
      if (files.some(file => file.name === name)) return res.status(400).json({ error: 'File already exists' });
      if (folders.some(folder => folder.path === name || folder.path.startsWith(`${name}/`))) {
        return res.status(400).json({ error: 'A folder already exists at or below this path' });
      }

      const ancestors = projectPathAncestors(name);
      if (ancestors.some(ancestor => files.some(file => file.name === ancestor))) {
        return res.status(400).json({ error: 'A file blocks this project path' });
      }
      const parentPath = parentProjectPath(name);
      if (parentPath && !folders.some(folder => folder.path === parentPath)) {
        return res.status(400).json({ error: 'Parent folder does not exist' });
      }

      const languageMetadata = getFileLanguage(name, language);
      const newFile = new File({ name, ...languageMetadata });
      await newFile.save();
      return res.json({ message: 'File created successfully', file: newFile });
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to create file' });
  }
});

app.post('/api/folders', async (req, res) => {
  try {
    await queueProjectMutation(async () => {
      const folderPath = req.body?.path;
      if (!isValidProjectPath(folderPath)) {
        return res.status(400).json({ error: 'Invalid project-relative folder path' });
      }

      const [files, folders] = await Promise.all([File.find({}), Folder.find({})]);
      if (folders.some(folder => folder.path === folderPath)) {
        return res.status(400).json({ error: 'Folder already exists' });
      }
      if (files.some(file => file.name === folderPath)) {
        return res.status(400).json({ error: 'A file already exists at this path' });
      }

      const ancestors = projectPathAncestors(folderPath);
      if (ancestors.some(ancestor => files.some(file => file.name === ancestor))) {
        return res.status(400).json({ error: 'A file blocks this project path' });
      }
      const parentPath = parentProjectPath(folderPath);
      if (parentPath && !folders.some(folder => folder.path === parentPath)) {
        return res.status(400).json({ error: 'Parent folder does not exist' });
      }

      const folder = new Folder({ path: folderPath });
      await folder.save();
      return res.json({ message: 'Folder created successfully', folder });
    });
  } catch {
    res.status(500).json({ error: 'Failed to create folder' });
  }
});

app.delete('/api/files/:filename', async (req, res) => {
  try {
    if (!isValidProjectPath(req.params.filename)) {
      return res.status(400).json({ error: 'Invalid project-relative file path' });
    }
    const deleted = await File.findOneAndDelete({ name: req.params.filename });
    if (!deleted) return res.status(404).json({ error: 'File not found' });
    res.json({ message: 'File deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete file' });
  }
});

// Member Routes
app.get('/api/members', async (req, res) => {
  try {
    const members = await Member.find({});
    res.json(members);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch members' });
  }
});

app.post('/api/members', async (req, res) => {
  try {
    const { name, color } = req.body;
    if (!name || !color) return res.status(400).json({ error: 'Name and color are required' });
    const existing = await Member.findOne({ name });
    if (existing) return res.status(400).json({ error: 'Member already exists' });
    
    const newMember = new Member({ name, color });
    await newMember.save();
    res.json({ message: 'Member created successfully', member: newMember });
  } catch (error) {
    res.status(500).json({ error: 'Failed to create member' });
  }
});

app.delete('/api/members/:id', async (req, res) => {
  try {
    const deleted = await Member.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Member not found' });
    res.json({ message: 'Member deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete member' });
  }
});

const server = http.createServer(app);
const wss = new Server({
  server,
  verifyClient: ({ origin }) => isAllowedFrontendOrigin(origin),
});

wss.on('connection', (ws, req) => {
  const roomName = req.url.slice(1).split('?')[0];
  const existingError = yjsPersistence.getRoomError(roomName);
  if (existingError) {
    ws.close(1011, 'Document history unavailable');
    return;
  }

  // getYDoc invokes bindState synchronously. Load the room before setupWSConnection
  // so an invalid history can be rejected before y-websocket sends sync traffic.
  try {
    yUtils.getYDoc(roomName);
  } catch (error) {
    const reason = yjsPersistence.getRoomError(roomName);
    console.error(`Yjs room ${encodeURIComponent(roomName).slice(0, 120)} unavailable (${reason?.code || 'history_load_failed'})`);
    ws.close(1011, 'Document history unavailable');
    return;
  }

  setupWSConnection(ws, req);
});

server.listen(PORT, BACKEND_BIND_HOST, () => {
  console.log(`🚀 API & WebSocket Server is running at http://${BACKEND_BIND_HOST}:${PORT}`);
});
