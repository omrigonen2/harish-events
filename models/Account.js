const mongoose = require('mongoose');

const accountSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, trim: true, lowercase: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Account', accountSchema);
