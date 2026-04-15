const mongoose = require('mongoose');

const eventSchema = new mongoose.Schema(
  {
    accountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Account',
      required: true,
      index: true,
    },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    date: { type: Date, default: null },
    isActive: { type: Boolean, default: true },
    slug: { type: String, required: true, unique: true, trim: true },
    /** null = no cap */
    signupLimit: { type: Number, default: null },
    /** families | participants | children */
    signupLimitCountMode: { type: String, enum: ['families', 'participants', 'children'], default: 'families' },
    /** when reached, public form shows closed (Israel local time in admin UI) */
    signupCloseAt: { type: Date, default: null },
  },
  { timestamps: true }
);

function slugify(text) {
  return text
    .toString()
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\w\u0590-\u05FF-]+/g, '')
    .replace(/--+/g, '-');
}

// Mongoose 9+: pre hooks do not receive `next`; use sync or async without calling next()
eventSchema.pre('validate', function ensureSlug() {
  if (!this.slug && this.name) {
    this.slug = slugify(this.name);
  }
  if (this.slug) {
    this.slug = slugify(this.slug);
  }
});

module.exports = mongoose.model('Event', eventSchema);
