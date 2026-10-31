const mongoose = require('mongoose');

const accountSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, trim: true, lowercase: true },
    logoUrl: { type: String, default: '' },
    brandColor: { type: String, default: '#126c59' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Account', accountSchema);
