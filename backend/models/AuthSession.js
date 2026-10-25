const mongoose = require('mongoose');

const authSessionSchema = new mongoose.Schema({
  tokenHash: { type: String, required: true, unique: true },
  userId: { type: String, required: true },
  workspaceId: { type: String, required: true },
  expiresAt: { type: Number, required: true },
});

module.exports = mongoose.model('AuthSession', authSessionSchema);
