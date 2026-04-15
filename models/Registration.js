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
    children: { type: [childSchema], default: [] },
    customFields: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Registration', registrationSchema);
