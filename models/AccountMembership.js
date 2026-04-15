const mongoose = require('mongoose');

const accountMembershipSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    accountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Account',
      required: true,
    },
  },
  { timestamps: true }
);

accountMembershipSchema.index({ userId: 1, accountId: 1 }, { unique: true });

module.exports = mongoose.model('AccountMembership', accountMembershipSchema);
