const mongoose = require('mongoose');

const messageRecipientSchema = new mongoose.Schema(
  {
    campaignId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'MessageCampaign',
      required: true,
      index: true,
    },
    registrationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Registration',
      required: true,
    },
    parentFirstName: { type: String, default: '', trim: true },
    parentLastName: { type: String, default: '', trim: true },
    phoneOriginal: { type: String, default: '', trim: true },
    phoneNormalized: { type: String, required: true, trim: true },
    status: {
      type: String,
      enum: ['pending', 'sending', 'sent', 'failed'],
      default: 'pending',
      index: true,
    },
    attempts: { type: Number, min: 0, default: 0 },
    error: { type: String, default: '', trim: true },
    sentAt: { type: Date, default: null },
  },
  { timestamps: true }
);

messageRecipientSchema.index({ campaignId: 1, status: 1, createdAt: 1 });
messageRecipientSchema.index({ campaignId: 1, phoneNormalized: 1 }, { unique: true });

module.exports = mongoose.model('MessageRecipient', messageRecipientSchema);
