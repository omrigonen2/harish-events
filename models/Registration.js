const mongoose = require('mongoose');

const childSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    age: { type: Number, min: 0, max: 120, required: true },
  },
  { _id: false }
);

const registrationSchema = new mongoose.Schema(
  {
    eventId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Event',
      required: true,
      index: true,
    },
    parentFirstName: { type: String, default: '', trim: true },
    parentLastName: { type: String, default: '', trim: true },
    phone: { type: String, default: '', trim: true },
    phoneNormalized: { type: String, default: '', trim: true, index: true },
    children: { type: [childSchema], default: [] },
    customFields: { type: mongoose.Schema.Types.Mixed, default: {} },
    status: { type: String, enum: ['confirmed', 'cancelled'], default: 'confirmed', index: true },
    cancelledAt: { type: Date, default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    participants: { type: [new mongoose.Schema({
      name: { type: String, required: true, trim: true },
      age: { type: Number, min: 0, max: 120, default: null },
      category: { type: String, enum: ['child', 'adult', 'general'], default: 'general' },
    }, { _id: false })], default: undefined },
    ticketToken: { type: String, trim: true },
    ticketCheckedInAt: { type: Date, default: null },
    ticketCheckInAdults: { type: Number, min: 0, default: null },
    ticketCheckInChildren: { type: Number, min: 0, default: null },
    ticketWhatsAppSentAt: { type: Date, default: null },
    ticketWhatsAppError: { type: String, default: '', trim: true },
    checkInHistory: { type: [new mongoose.Schema({
      at: { type: Date, required: true }, adults: { type: Number, required: true }, children: { type: Number, required: true },
    }, { _id: false })], default: [] },
  },
  { timestamps: true }
);

registrationSchema.index({ ticketToken: 1 }, { unique: true, sparse: true });
registrationSchema.index({ eventId: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model('Registration', registrationSchema);
