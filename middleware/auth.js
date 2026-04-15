const AccountMembership = require('../models/AccountMembership');

function requireLogin(req, res, next) {
  if (req.session && req.session.userId) {
    return next();
  }
  const returnTo = encodeURIComponent(req.originalUrl || '/admin');
  return res.redirect(`/admin/login?returnTo=${returnTo}`);
}

function requireSuperAdmin(req, res, next) {
  if (req.session && req.session.userId && req.session.role === 'superadmin') {
    return next();
  }
  return res.status(403).render('error', { title: 'אין הרשאה', message: 'אין לך הרשאות לביצוע פעולה זו.' });
}

async function requireAccountContext(req, res, next) {
  if (!req.session || !req.session.userId) {
    const returnTo = encodeURIComponent(req.originalUrl || '/admin');
    return res.redirect(`/admin/login?returnTo=${returnTo}`);
  }
  if (req.session.role === 'superadmin') {
    return next();
  }
  if (!req.session.activeAccountId) {
    return res.redirect('/admin/select-account');
  }
  const membership = await AccountMembership.findOne({
    userId: req.session.userId,
    accountId: req.session.activeAccountId,
  });
  if (!membership) {
    return res.status(403).render('error', { title: 'אין הרשאה', message: 'אין לך גישה לחשבון זה.' });
  }
  return next();
}

// Legacy alias kept for backward-compat; now equivalent to requireLogin
const requireAdmin = requireLogin;

module.exports = { requireLogin, requireSuperAdmin, requireAccountContext, requireAdmin };
