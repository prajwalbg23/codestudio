const mongoose = require('mongoose');

const fileTombstoneSchema = new mongoose.Schema({
  path: { type: String, required: true, unique: true },
  documentId: { type: String, immutable: true },
  deletedAt: { type: String, required: true },
});

module.exports = mongoose.model('FileTombstone', fileTombstoneSchema);
