const mongoose = require('mongoose');

const fileSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },
  language: { type: String, required: true },
  languageSource: { type: String, enum: ['explicit', 'extension'] },
});

module.exports = mongoose.model('File', fileSchema);
