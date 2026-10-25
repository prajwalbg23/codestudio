const mongoose = require('mongoose');

const fileSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },
  language: { type: String, required: true },
  languageSource: { type: String, enum: ['explicit', 'extension'] },
  documentId: { type: String, required: true, unique: true, immutable: true },
  historyKey: { type: String, required: true, immutable: true },
});

module.exports = mongoose.model('File', fileSchema);
