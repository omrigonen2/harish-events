const Account = require('../models/Account');
const AccountMembership = require('../models/AccountMembership');

async function adminLocals(req) {
  const [accounts, memberships] = await Promise.all([
    req.session.role === 'superadmin' ? Account.find().sort({ name: 1 }).lean() : [],
    req.session.role !== 'superadmin' ? AccountMembership.find({ userId: req.session.userId }).populate('accountId').lean() : [],
  ]);
  const selected = accounts.find(a => String(a._id) === req.session.activeAccountId) || memberships.map(m => m.accountId).find(a => a && String(a._id) === req.session.activeAccountId);
  return {
    sessionUser: { displayName: req.session.displayName || '', role: req.session.role,
      activeAccountId: req.session.activeAccountId || null, activeAccountName: selected?.name || req.session.activeAccountName || null },
    memberships, navAccounts: accounts,
  };
}

function accountFilter(session) {
  if (session.role === 'superadmin' && !session.activeAccountId) return {};
  return { accountId: session.activeAccountId };
}

module.exports = { adminLocals, accountFilter };
