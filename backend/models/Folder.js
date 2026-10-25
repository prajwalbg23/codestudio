const mongoose = require('mongoose');

const folderSchema = new mongoose.Schema({
  path: { type: String, required: true, unique: true },
});

module.exports = mongoose.model('Folder', folderSchema);
