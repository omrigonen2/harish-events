const express = require('express');
const bcrypt = require('bcryptjs');
const Account = require('../models/Account');
const User = require('../models/User');
const AccountMembership = require('../models/AccountMembership');
const { requireSuperAdmin } = require('../middleware/auth');

const router = express.Router();

function slugify(text) {
  return text
    .toString()
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\w\u0590-\u05FF-]+/g, '')
    .replace(/--+/g, '-') || `account-${Date.now()}`;
}

async function uniqueAccountSlug(baseSlug, excludeId) {
  let slug = baseSlug || `account-${Date.now()}`;
  let candidate = slug;
  let n = 0;
  for (;;) {
    const query = { slug: candidate };
    if (excludeId) query._id = { $ne: excludeId };
    const exists = await Account.findOne(query);
    if (!exists) return candidate;
    n += 1;
    candidate = `${slug}-${n}`;
  }
}

function sessionUserLocals(req) {
  return {
    sessionUser: {
      displayName: req.session.displayName || '',
      role: req.session.role,
      activeAccountId: req.session.activeAccountId || null,
      activeAccountName: req.session.activeAccountName || null,
    },
    memberships: [],
  };
}

// ---------------------------------------------------------------------------
// Accounts list + create
// ---------------------------------------------------------------------------

router.get('/accounts', requireSuperAdmin, async (req, res) => {
  const accounts = await Account.find().sort({ createdAt: -1 }).lean();
  const memberCounts = await AccountMembership.aggregate([
    { $group: { _id: '$accountId', count: { $sum: 1 } } },
  ]);
  const memberCountMap = Object.fromEntries(memberCounts.map((c) => [String(c._id), c.count]));

  res.render('admin/accounts', {
    title: 'ניהול חשבונות',
    accounts,
    memberCountMap,
    formError: null,
    ...sessionUserLocals(req),
  });
});

router.post('/accounts/create', requireSuperAdmin, async (req, res) => {
  try {
    const name = (req.body.name || '').trim();
    if (!name) {
      const accounts = await Account.find().sort({ createdAt: -1 }).lean();
      const memberCounts = await AccountMembership.aggregate([
        { $group: { _id: '$accountId', count: { $sum: 1 } } },
      ]);
      const memberCountMap = Object.fromEntries(memberCounts.map((c) => [String(c._id), c.count]));
      return res.status(400).render('admin/accounts', {
        title: 'ניהול חשבונות',
        accounts,
        memberCountMap,
        formError: 'שם חשבון חובה',
        ...sessionUserLocals(req),
      });
    }
    const slug = await uniqueAccountSlug(slugify(name));
    await Account.create({ name, slug });
    return res.redirect('/admin/accounts');
  } catch (err) {
    console.error(err);
    return res.status(500).render('error', { title: 'שגיאה', message: err.message || 'שגיאת שרת' });
  }
});

// ---------------------------------------------------------------------------
// Account edit
// ---------------------------------------------------------------------------

router.get('/accounts/:accountId/edit', requireSuperAdmin, async (req, res) => {
  const account = await Account.findById(req.params.accountId).lean();
  if (!account) return res.status(404).render('error', { title: 'לא נמצא', message: 'חשבון לא קיים' });

  res.render('admin/account-edit', {
    title: `עריכת חשבון — ${account.name}`,
    account,
    formError: null,
    ...sessionUserLocals(req),
  });
});

router.post('/accounts/:accountId/update', requireSuperAdmin, async (req, res) => {
  try {
    const account = await Account.findById(req.params.accountId);
    if (!account) return res.status(404).render('error', { title: 'לא נמצא', message: 'חשבון לא קיים' });

    const name = (req.body.name || '').trim();
    const slugInput = (req.body.slug || '').trim();
    if (!name) {
      return res.status(400).render('admin/account-edit', {
        title: 'עריכת חשבון',
        account: account.toObject(),
        formError: 'שם חשבון חובה',
        ...sessionUserLocals(req),
      });
    }

    account.name = name;
    account.slug = await uniqueAccountSlug(slugify(slugInput || name), account._id);
    await account.save();
    return res.redirect(`/admin/accounts/${account._id}/edit`);
  } catch (err) {
    console.error(err);
    return res.status(500).render('error', { title: 'שגיאה', message: err.message || 'שגיאת שרת' });
  }
});

// ---------------------------------------------------------------------------
// Account users
// ---------------------------------------------------------------------------

router.get('/accounts/:accountId/users', requireSuperAdmin, async (req, res) => {
  const account = await Account.findById(req.params.accountId).lean();
  if (!account) return res.status(404).render('error', { title: 'לא נמצא', message: 'חשבון לא קיים' });

  const memberships = await AccountMembership.find({ accountId: account._id }).populate('userId').lean();

  res.render('admin/account-users', {
    title: `משתמשים — ${account.name}`,
    account,
    memberships,
    formError: null,
    ...sessionUserLocals(req),
    membershipsList: [],
  });
});

router.post('/accounts/:accountId/users', requireSuperAdmin, async (req, res) => {
  try {
    const account = await Account.findById(req.params.accountId);
    if (!account) return res.status(404).render('error', { title: 'לא נמצא', message: 'חשבון לא קיים' });

    const email = (req.body.email || '').trim().toLowerCase();
    const password = (req.body.password || '').trim();
    const displayName = (req.body.displayName || '').trim();

    if (!email) {
      return res.redirect(`/admin/accounts/${account._id}/users?error=email`);
    }

    let user = await User.findOne({ email });
    if (!user) {
      if (!password) {
        return res.redirect(`/admin/accounts/${account._id}/users?error=password`);
      }
      const passwordHash = await bcrypt.hash(password, 12);
      user = await User.create({
        email,
        passwordHash,
        displayName: displayName || email.split('@')[0],
        role: 'user',
      });
    }

    const existingMembership = await AccountMembership.findOne({ userId: user._id, accountId: account._id });
    if (!existingMembership) {
      await AccountMembership.create({ userId: user._id, accountId: account._id });
    }

    return res.redirect(`/admin/accounts/${account._id}/users`);
  } catch (err) {
    console.error(err);
    return res.status(500).render('error', { title: 'שגיאה', message: err.message || 'שגיאת שרת' });
  }
});

router.post('/accounts/:accountId/users/:userId/remove', requireSuperAdmin, async (req, res) => {
  try {
    await AccountMembership.deleteOne({
      userId: req.params.userId,
      accountId: req.params.accountId,
    });
    return res.redirect(`/admin/accounts/${req.params.accountId}/users`);
  } catch (err) {
    console.error(err);
    return res.status(500).render('error', { title: 'שגיאה', message: err.message || 'שגיאת שרת' });
  }
});

module.exports = router;
