const Registration = require('../models/Registration');

/**
 * @param {import('mongoose').Types.ObjectId} eventId
 * @param {'families'|'participants'|'children'} mode
 */
async function countSignupUsage(eventId, mode) {
  if (mode === 'children') {
    const regs = await Registration.find({ eventId }).select('children').lean();
    return regs.reduce((sum, r) => sum + (Array.isArray(r.children) ? r.children.length : 0), 0);
  }
  if (mode === 'participants') {
    const regs = await Registration.find({ eventId }).select('children').lean();
    return regs.reduce((sum, r) => sum + 1 + (Array.isArray(r.children) ? r.children.length : 0), 0);
  }
  return Registration.countDocuments({ eventId });
}

/**
 * @param {object} event lean doc with signupLimit, signupLimitCountMode, signupCloseAt
 */
async function getSignupAvailability(event) {
  const now = new Date();
  const closeAt = event.signupCloseAt ? new Date(event.signupCloseAt) : null;
  if (closeAt && !Number.isNaN(closeAt.getTime()) && now > closeAt) {
    return { open: false, reason: 'closed', message: 'ההרשמה לפעילות זו נסגרה.' };
  }

  const rawLimit = event.signupLimit;
  const limit =
    rawLimit == null || rawLimit === '' ? null : Number(rawLimit);
  if (limit == null || Number.isNaN(limit) || limit < 0) {
    return { open: true, reason: null, message: null, current: null, limit: null };
  }

  const mode =
    event.signupLimitCountMode === 'participants'
      ? 'participants'
      : event.signupLimitCountMode === 'children'
        ? 'children'
        : 'families';
  const current = await countSignupUsage(event._id, mode);
  if (current >= limit) {
    return {
      open: false,
      reason: 'full',
      message: 'הגענו למכסת ההרשמות לפעילות זו.',
      current,
      limit,
    };
  }

  return { open: true, reason: null, message: null, current, limit };
}

module.exports = {
  countSignupUsage,
  getSignupAvailability,
};
