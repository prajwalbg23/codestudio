const mongoose = require('mongoose');

const workspaceMembershipSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  workspaceId: { type: String, required: true },
  role: { type: String, enum: ['admin', 'member'], required: true },
});

module.exports = mongoose.model('WorkspaceMembership', workspaceMembershipSchema);
