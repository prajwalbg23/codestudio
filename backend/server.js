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
const fs = require('fs');
const path = require('path');
const { Server } = require('ws');
const { setupWSConnection } = require('y-websocket/bin/utils');
const yUtils = require('y-websocket/bin/utils');
const Y = require('yjs');
const mongoose = require('mongoose');
const File = require('./models/File');
const Member = require('./models/Member');


const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
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

// Set up Yjs persistence locally using binary updates
const YJS_DB_DIR = path.join(__dirname, 'yjs_db');
if (!fs.existsSync(YJS_DB_DIR)) {
  fs.mkdirSync(YJS_DB_DIR);
}

yUtils.setPersistence({
  bindState: async (docName, ydoc) => {
    const docPath = path.join(YJS_DB_DIR, `${encodeURIComponent(docName)}.bin`);
    if (fs.existsSync(docPath)) {
      const data = fs.readFileSync(docPath);
      Y.applyUpdate(ydoc, data);
    }
    ydoc.on('update', (update) => {
      fs.appendFileSync(docPath, Buffer.from(update));
    });
  },
  writeState: async (docName, ydoc) => {
    return Promise.resolve();
  }
});

app.get('/api/files', async (req, res) => {
  try {
    const files = await File.find({});
    res.json(files.map(f => f.name));
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch files' });
  }
});

app.get('/api/files/:filename', async (req, res) => {
  try {
    const file = await File.findOne({ name: req.params.filename });
    if (!file) {
      return res.status(404).json({ error: 'File not found' });
    }
    res.json({ language: file.language });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch file' });
  }
});

app.post('/api/files', async (req, res) => {
  try {
    const { name, language } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required' });
    const existing = await File.findOne({ name });
    if (existing) return res.status(400).json({ error: 'File already exists' });
    
    // Auto-detect language if not provided
    let extLanguage = 'javascript';
    if (language) {
      extLanguage = language;
    } else if (name.endsWith('.html')) {
      extLanguage = 'html';
    } else if (name.endsWith('.css')) {
      extLanguage = 'css';
    } else if (name.endsWith('.json')) {
      extLanguage = 'json';
    } else if (name.endsWith('.md')) {
      extLanguage = 'markdown';
    }

    const newFile = new File({ name, language: extLanguage });
    await newFile.save();
    res.json({ message: 'File created successfully', file: newFile });
  } catch (error) {
    res.status(500).json({ error: 'Failed to create file' });
  }
});

app.delete('/api/files/:filename', async (req, res) => {
  try {
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
const wss = new Server({ server });

wss.on('connection', (ws, req) => {
  setupWSConnection(ws, req);
});

server.listen(PORT, () => {
  console.log(`🚀 API & WebSocket Server is running on port ${PORT}`);
});