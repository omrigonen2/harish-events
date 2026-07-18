const mongoose = require('mongoose');

const messageCampaignSchema = new mongoose.Schema(
  {
    accountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Account',
      required: true,
      index: true,
    },
    eventId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Event',
      required: true,
      index: true,
    },
    name: { type: String, default: '', trim: true },
    messageText: { type: String, required: true, trim: true },
    imageKey: { type: String, default: '', trim: true },
    publicBaseUrl: { type: String, default: '', trim: true },
    scheduledAt: { type: Date, default: null, index: true },
    status: {
      type: String,
      enum: ['queued', 'running', 'paused', 'completed', 'cancelled'],
      default: 'queued',
      index: true,
    },
    totalRecipients: { type: Number, min: 0, default: 0 },
    sentCount: { type: Number, min: 0, default: 0 },
    failedCount: { type: Number, min: 0, default: 0 },
    duplicatesSkipped: { type: Number, min: 0, default: 0 },
    invalidPhoneCount: { type: Number, min: 0, default: 0 },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    lastError: { type: String, default: '', trim: true },
    attachTicket: { type: Boolean, default: false },
    messageToTicketDelaySeconds: { type: Number, min: 1, max: 3600, default: 6 },
    recipientDelaySeconds: { type: Number, min: 1, max: 3600, default: 6 },
  },
  { timestamps: true }
);

messageCampaignSchema.index({ eventId: 1, createdAt: -1 });
messageCampaignSchema.index({ status: 1, createdAt: 1 });
messageCampaignSchema.index({ status: 1, scheduledAt: 1, createdAt: 1 });

module.exports = mongoose.model('MessageCampaign', messageCampaignSchema);
