const mongoose = require('mongoose');

const wasenderSettingsSchema = new mongoose.Schema(
  {
    singletonKey: { type: String, required: true, unique: true, default: 'global' },
    apiKeyEncrypted: { type: String, default: '' },
    apiKeyPreview: { type: String, default: '' },
    baseUrl: { type: String, default: 'https://www.wasenderapi.com', trim: true },
    lastStatus: { type: String, default: '' },
    lastCheckedAt: { type: Date, default: null },
    lastError: { type: String, default: '' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('WasenderSettings', wasenderSettingsSchema);
