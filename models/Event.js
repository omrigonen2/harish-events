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
    /** Block more than one registration with the same normalized phone for this event */
    signupPhoneUnique: { type: Boolean, default: false },
    /** When false, the event has no children — children section is hidden everywhere */
    hasChildren: { type: Boolean, default: true },
    /** Optional WhatsApp ticket with QR check-in */
    ticketsEnabled: { type: Boolean, default: false },
    /** Allow gate staff to adjust admitted adults/children before check-in */
    ticketsGateAllowCountEdit: { type: Boolean, default: false },
    /** Secret staff check-in link token; generated when ticketing is enabled */
    checkInToken: { type: String, trim: true },
  },
  { timestamps: true }
);

eventSchema.index({ checkInToken: 1 }, { unique: true, sparse: true });

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
