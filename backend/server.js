// backend/server.js
const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('ws');
const { setupWSConnection } = require('y-websocket/bin/utils');

const app = express();
const PORT = 3001;

const projectData = {
  'script.js': { language: 'javascript' },
  'style.css': { language: 'css' },
  'index.html': { language: 'html' },
};

app.use(cors());

app.get('/api/files', (req, res) => {
  res.json(Object.keys(projectData));
});

app.get('/api/files/:filename', (req, res) => {
  res.json(projectData[req.params.filename]);
});

const server = http.createServer(app);
const wss = new Server({ server });

wss.on('connection', (ws, req) => {
  setupWSConnection(ws, req);
});

server.listen(PORT, () => {
  console.log(`🚀 API & WebSocket Server is running on port ${PORT}`);
});