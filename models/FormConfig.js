const mongoose = require('mongoose');

const formFieldSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    type: {
      type: String,
      enum: [
        'parent_first',
        'parent_last',
        'phone',
        'children',
        'text',
        'textarea',
        'select',
        'checkbox',
      ],
      required: true,
    },
    label: { type: String, required: true, trim: true },
    required: { type: Boolean, default: false },
    checkedByDefault: { type: Boolean, default: false },
    order: { type: Number, default: 0 },
    options: { type: [String], default: [] },
    childNameLabel: { type: String, default: 'שם הילד/ה' },
    childAgeLabel: { type: String, default: 'גיל' },
  },
  { _id: false }
);

const colorsSchema = new mongoose.Schema(
  {
    primary: { type: String, default: '#0d6efd' },
    background: { type: String, default: '#f8f9fa' },
    text: { type: String, default: '#212529' },
    button: { type: String, default: '#0d6efd' },
  },
  { _id: false }
);

const formConfigSchema = new mongoose.Schema(
  {
    eventId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Event',
      required: true,
      unique: true,
    },
    colors: { type: colorsSchema, default: () => ({}) },
    backgroundImage: { type: String, default: '' },
    logoUrl: { type: String, default: '' },
    /** All form fields including parent/phone/children — canonical */
    fields: { type: [formFieldSchema], default: [] },
    /** @deprecated migrated into fields — kept for reading old documents */
    customFields: { type: [mongoose.Schema.Types.Mixed], default: [] },
  },
  { timestamps: true }
);

module.exports = mongoose.model('FormConfig', formConfigSchema);
