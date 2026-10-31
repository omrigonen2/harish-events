const Registration = require('../models/Registration');
const { activeRegistrationFilter, participantCounts } = require('./participants');
const { registrationState, limitLabel } = require('./eventStatus');

/**
 * @param {import('mongoose').Types.ObjectId} eventId
 * @param {'families'|'participants'|'children'} mode
 */
async function countSignupUsage(eventId, mode, { session } = {}) {
  const filter = { eventId, ...activeRegistrationFilter };
  if (mode === 'children' || mode === 'participants') {
    let query = Registration.find(filter).select('children participants');
    if (session) query = query.session(session);
    const regs = await query.lean();
    return regs.reduce((sum, r) => sum + participantCounts(r)[mode === 'participants' ? 'total' : 'additional'], 0);
  }
  const query = Registration.countDocuments(filter);
  return session ? query.session(session) : query;
}

/**
 * @param {object} event lean doc with signupLimit, signupLimitCountMode, signupCloseAt
 */
async function getSignupAvailability(event, { incoming = 0, session } = {}) {
  const state = registrationState(event);
  if (!state.open) return { open: false, reason: state.key, message: state.label };

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
  const current = await countSignupUsage(event._id, mode, { session });
  if (current >= limit || current + incoming > limit) {
    return {
      open: false,
      reason: 'full',
      message: incoming && current < limit ? `נותרו ${Math.max(0, limit - current)} ${limitLabel(mode)} בלבד.` : 'הגענו למכסת ההרשמות לפעילות זו.',
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
