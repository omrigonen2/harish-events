const express = require('express');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const Event = require('../models/Event');
const Registration = require('../models/Registration');
const FormConfig = require('../models/FormConfig');
const User = require('../models/User');
const Account = require('../models/Account');
const AccountMembership = require('../models/AccountMembership');
const { requireLogin, requireAccountContext, requireSuperAdmin } = require('../middleware/auth');
const { uploadFile, deleteFile, resolveConfigUrls } = require('../lib/s3');
const {
  defaultFields,
  normalizeStoredFields,
  sanitizeFieldsFromBuilder,
  getCustomFieldDefs,
  getFieldsForRender,
} = require('../lib/formFields');
const { escapeForTextarea } = require('../lib/htmlSanitize');
const { toDatetimeLocalInputValue, parseDatetimeLocalInput } = require('../lib/datetimeLocal');
const { buildGateUrl, generateToken } = require('../lib/tickets');

const router = express.Router();

// Memory storage — files go to S3, not disk
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /^image\/(jpeg|png|gif|webp|svg\+xml)$/.test(file.mimetype);
    if (ok) cb(null, true);
    else cb(new Error('רק קבצי תמונה מותרים'));
  },
});

function slugify(text) {
  return text
    .toString()
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\w\u0590-\u05FF-]+/g, '')
    .replace(/--+/g, '-');
}

async function uniqueSlug(baseSlug, excludeId) {
  let slug = baseSlug || `event-${Date.now()}`;
  let candidate = slug;
  let n = 0;
  for (;;) {
    const query = { slug: candidate };
    if (excludeId) query._id = { $ne: excludeId };
    const exists = await Event.findOne(query);
    if (!exists) return candidate;
    n += 1;
    candidate = `${slug}-${n}`;
  }
}

function parseSignupFields(body) {
  const raw = (body.signupLimit || '').trim();
  let signupLimit = null;
  if (raw !== '') {
    const n = parseInt(raw, 10);
    if (!Number.isNaN(n) && n >= 0) signupLimit = n;
  }
  let signupLimitCountMode = 'families';
  if (body.signupLimitCountMode === 'participants') signupLimitCountMode = 'participants';
  else if (body.signupLimitCountMode === 'children') signupLimitCountMode = 'children';
  const signupCloseAt = parseDatetimeLocalInput(body.signupCloseAt || '');
  return { signupLimit, signupLimitCountMode, signupCloseAt };
}

function parseFormConfigBody(body) {
  let fields = [];
  if (body.fieldsJson) {
    try {
      fields = JSON.parse(body.fieldsJson);
    } catch {
      fields = [];
    }
  }
  if (!Array.isArray(fields)) fields = [];

  return {
    colors: {
      primary: body.colorPrimary || '#0d6efd',
      background: body.colorBackground || '#f8f9fa',
      text: body.colorText || '#212529',
      button: body.colorButton || '#0d6efd',
    },
    fields: sanitizeFieldsFromBuilder(fields),
  };
}

async function ensureFormConfig(eventId) {
  let cfg = await FormConfig.findOne({ eventId });
  if (!cfg) {
    return FormConfig.create({ eventId, colors: {}, fields: defaultFields() });
  }
  const needsMigrate =
    !cfg.fields ||
    cfg.fields.length === 0 ||
    (cfg.customFields && cfg.customFields.length > 0);
  if (needsMigrate) {
    cfg.fields = normalizeStoredFields(cfg);
    cfg.customFields = [];
    await cfg.save();
  }
  return cfg;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

router.get('/login', (req, res) => {
  if (req.session && req.session.userId) return res.redirect('/admin');
  res.render('admin/login', {
    title: 'כניסת מנהלים',
    error: null,
    returnTo: req.query.returnTo || '/admin',
  });
});

router.post('/login', async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const password = req.body.password || '';
  const returnTo = req.body.returnTo && String(req.body.returnTo).startsWith('/') ? req.body.returnTo : '/admin';

  let user = await User.findOne({ email });

  // Fallback: if no users exist yet, allow env credentials to bootstrap the first superadmin
  if (!user) {
    const userCount = await User.countDocuments();
    const envUser = (process.env.ADMIN_USERNAME || '').toLowerCase();
    const envPass = process.env.ADMIN_PASSWORD || '';
    if (userCount === 0 && envUser && envPass && email === envUser && password === envPass) {
      const passwordHash = await bcrypt.hash(password, 12);
      user = await User.create({
        email,
        passwordHash,
        displayName: 'מנהל על',
        role: 'superadmin',
      });
      // Ensure default account exists for the superadmin
      let defaultAccount = await Account.findOne({ slug: 'default' });
      if (!defaultAccount) {
        defaultAccount = await Account.create({ name: 'ברירת מחדל', slug: 'default' });
      }
      // Backfill events missing accountId
      await Event.updateMany(
        { $or: [{ accountId: { $exists: false } }, { accountId: null }] },
        { $set: { accountId: defaultAccount._id } }
      );
    }
  }

  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    return res.status(401).render('admin/login', {
      title: 'כניסת מנהלים',
      error: 'אימייל או סיסמה שגויים',
      returnTo,
    });
  }

  req.session.userId = String(user._id);
  req.session.role = user.role;
  req.session.displayName = user.displayName || user.email;

  if (user.role === 'superadmin') {
    return res.redirect(returnTo);
  }

  // Regular user: auto-set activeAccountId if they have exactly one membership
  const memberships = await AccountMembership.find({ userId: user._id }).populate('accountId');
  if (memberships.length === 1) {
    req.session.activeAccountId = String(memberships[0].accountId._id);
    req.session.activeAccountName = memberships[0].accountId.name;
    return res.redirect(returnTo);
  }
  if (memberships.length === 0) {
    req.session.destroy(() => {});
    return res.status(401).render('admin/login', {
      title: 'כניסת מנהלים',
      error: 'משתמש ללא חשבון משויך. פנה למנהל המערכת.',
      returnTo,
    });
  }

  return res.redirect('/admin/select-account');
});

router.get('/select-account', requireLogin, async (req, res) => {
  if (req.session.role === 'superadmin') return res.redirect('/admin');
  const memberships = await AccountMembership.find({ userId: req.session.userId }).populate('accountId');
  res.render('admin/select-account', {
    title: 'בחירת חשבון',
    memberships,
  });
});

router.post('/set-active-account', requireLogin, async (req, res) => {
  const accountId = (req.body.accountId || '').trim();
  if (!accountId) return res.redirect('/admin/select-account');

  if (req.session.role !== 'superadmin') {
    const membership = await AccountMembership.findOne({ userId: req.session.userId, accountId });
    if (!membership) {
      return res.status(403).render('error', { title: 'אין הרשאה', message: 'אין לך גישה לחשבון זה.' });
    }
  }
  const account = await Account.findById(accountId);
  if (!account) {
    return res.status(404).render('error', { title: 'לא נמצא', message: 'חשבון לא קיים.' });
  }
  req.session.activeAccountId = String(account._id);
  req.session.activeAccountName = account.name;
  return res.redirect('/admin');
});

router.get('/logout', requireLogin, (req, res) => {
  req.session.destroy(() => res.redirect('/admin/login'));
});

router.post('/logout', requireLogin, (req, res) => {
  req.session.destroy(() => res.redirect('/admin/login'));
});

// ---------------------------------------------------------------------------
// Helpers — account scoping
// ---------------------------------------------------------------------------

/** Build a Mongoose filter that restricts to the active account for regular users. */
function accountFilter(session) {
  if (session.role === 'superadmin') return {};
  return { accountId: session.activeAccountId };
}

/** Load event only if the user has access (owns it or is superadmin). */
async function loadEventScoped(eventId, session) {
  const event = await Event.findById(eventId);
  if (!event) return null;
  if (session.role === 'superadmin') return event;
  if (String(event.accountId) !== session.activeAccountId) return null;
  return event;
}

/** Session locals injected into all admin renders for navbar/account switcher. */
async function adminLocals(req) {
  const locals = {
    sessionUser: {
      displayName: req.session.displayName || '',
      role: req.session.role,
      activeAccountId: req.session.activeAccountId || null,
      activeAccountName: req.session.activeAccountName || null,
    },
    memberships: [],
  };
  if (req.session.role !== 'superadmin') {
    locals.memberships = await AccountMembership.find({ userId: req.session.userId }).populate('accountId').lean();
  }
  return locals;
}

// ---------------------------------------------------------------------------
// AJAX image upload — returns { key } for use in form hidden inputs
// ---------------------------------------------------------------------------

router.post('/upload-image', requireLogin, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'לא נבחרה תמונה' });
    const key = await uploadFile(req.file.buffer, req.file.originalname, req.file.mimetype);
    return res.json({ key });
  } catch (err) {
    console.error('upload-image error', err);
    return res.status(500).json({ error: err.message || 'שגיאת שרת' });
  }
});

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

router.get('/', requireAccountContext, async (req, res) => {
  try {
    const filter = accountFilter(req.session);
    const events = await Event.find(filter).sort({ createdAt: -1 }).populate('accountId').lean();
    const counts = await Registration.aggregate([{ $group: { _id: '$eventId', n: { $sum: 1 } } }]);
    const countMap = Object.fromEntries(counts.map((c) => [String(c._id), c.n]));
    const al = await adminLocals(req);
    res.render('admin/dashboard', { title: 'לוח בקרה', events, countMap, ...al });
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { title: 'שגיאה', message: 'לא ניתן לטעון נתונים' });
  }
});

// ---------------------------------------------------------------------------
// Events CRUD
// ---------------------------------------------------------------------------

async function renderEventsListPage(req, res, opts = {}) {
  const filter = accountFilter(req.session);
  const events = await Event.find(filter).sort({ date: -1, createdAt: -1 }).populate('accountId').lean();
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const al = await adminLocals(req);
  const allAccounts = req.session.role === 'superadmin' ? await Account.find().sort({ name: 1 }).lean() : [];
  return res.render('admin/events', {
    title: 'ניהול אירועים',
    events,
    formError: opts.formError || null,
    baseUrl,
    allAccounts,
    ...al,
  });
}

async function renderEventEditPage(req, res, opts = {}) {
  const editEvent = await loadEventScoped(opts.editId, req.session);
  if (!editEvent) {
    return res.status(404).render('error', { title: 'לא נמצא', message: 'אירוע לא קיים' });
  }
  const editObj = editEvent.toObject ? editEvent.toObject() : editEvent;
  const editDescriptionHtml = escapeForTextarea(editObj.description || '');
  const cfg = await ensureFormConfig(editObj._id);
  const plain = cfg.toObject();
  plain.fields = getFieldsForRender(plain);
  const builderConfig = await resolveConfigUrls(plain);
  const builderConfigRaw = cfg.toObject();
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const al = await adminLocals(req);
  const gateUrl = editObj.ticketsEnabled && editObj.checkInToken ? buildGateUrl(req, editObj.checkInToken) : '';
  return res.render('admin/event-edit', {
    title: `עריכה — ${editObj.name}`,
    editEvent: editObj,
    editDescriptionHtml,
    formError: opts.formError || null,
    formBuilderError: opts.formBuilderError || null,
    baseUrl,
    builderConfig,
    builderConfigRaw,
    eventDateInput: toDatetimeLocalInputValue(editObj.date),
    signupCloseAtInput: toDatetimeLocalInputValue(editObj.signupCloseAt),
    gateUrl,
    ...al,
  });
}

router.get('/events', requireAccountContext, async (req, res) => {
  try {
    if (req.query.edit) {
      return res.redirect(302, `/admin/events/${req.query.edit}/edit`);
    }
    await renderEventsListPage(req, res, {});
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { title: 'שגיאה', message: 'שגיאת שרת' });
  }
});

router.get('/events/:id/edit', requireAccountContext, async (req, res) => {
  try {
    await renderEventEditPage(req, res, { editId: req.params.id });
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { title: 'שגיאה', message: 'שגיאת שרת' });
  }
});

router.post('/events/create', requireAccountContext, async (req, res) => {
  try {
    const name = (req.body.name || '').trim();
    const description = (req.body.description || '').trim();
    const dateVal = parseDatetimeLocalInput(req.body.date || '');
    const slugInput = (req.body.slug || '').trim();
    const isActive = req.body.isActive === 'on' || req.body.isActive === 'true';
    const signup = parseSignupFields(req.body);
    const ticketsEnabled = req.body.ticketsEnabled === 'on' || req.body.ticketsEnabled === 'true';

    if (!name) return renderEventsListPage(req, res.status(400), { formError: 'שם האירוע חובה' });

    // Determine which account owns this event
    let eventAccountId;
    if (req.session.role === 'superadmin') {
      eventAccountId = req.body.accountId || req.session.activeAccountId;
      if (!eventAccountId) {
        const defaultAcct = await Account.findOne({ slug: 'default' });
        eventAccountId = defaultAcct ? defaultAcct._id : null;
      }
    } else {
      eventAccountId = req.session.activeAccountId;
    }
    if (!eventAccountId) return renderEventsListPage(req, res.status(400), { formError: 'חשבון לא נבחר' });

    const slug = await uniqueSlug(slugInput || slugify(name));
    const event = await Event.create({
      accountId: eventAccountId,
      name,
      description,
      date: dateVal,
      isActive,
      slug,
      signupLimit: signup.signupLimit,
      signupLimitCountMode: signup.signupLimitCountMode,
      signupCloseAt: signup.signupCloseAt,
      ticketsEnabled,
      checkInToken: ticketsEnabled ? generateToken(32) : undefined,
    });
    await ensureFormConfig(event._id);
    return res.redirect(`/admin/events/${event._id}/edit`);
  } catch (err) {
    console.error(err);
    return renderEventsListPage(req, res.status(500), { formError: 'שגיאה ביצירת האירוע' });
  }
});

router.post('/events/:id/update', requireAccountContext, async (req, res) => {
  try {
    const event = await loadEventScoped(req.params.id, req.session);
    if (!event) return res.status(404).render('error', { title: 'לא נמצא', message: 'אירוע לא קיים' });

    const name = (req.body.name || '').trim();
    const description = (req.body.description || '').trim();
    const dateVal = parseDatetimeLocalInput(req.body.date || '');
    const slugInput = (req.body.slug || '').trim();
    const isActive = req.body.isActive === 'on' || req.body.isActive === 'true';
    const signup = parseSignupFields(req.body);
    const ticketsEnabled = req.body.ticketsEnabled === 'on' || req.body.ticketsEnabled === 'true';

    if (!name) {
      return renderEventEditPage(req, res.status(400), { editId: req.params.id, formError: 'שם האירוע חובה' });
    }

    event.name = name;
    event.description = description;
    event.date = dateVal;
    event.isActive = isActive;
    event.slug = await uniqueSlug(slugInput || slugify(name), event._id);
    event.signupLimit = signup.signupLimit;
    event.signupLimitCountMode = signup.signupLimitCountMode;
    event.signupCloseAt = signup.signupCloseAt;
    event.ticketsEnabled = ticketsEnabled;
    if (ticketsEnabled && !event.checkInToken) {
      event.checkInToken = generateToken(32);
    }
    await event.save();
    return res.redirect(`/admin/events/${req.params.id}/edit`);
  } catch (err) {
    console.error(err);
    return renderEventEditPage(req, res.status(500), { editId: req.params.id, formError: 'שגיאה בעדכון' });
  }
});

router.post('/events/:id/tickets/rotate', requireAccountContext, async (req, res) => {
  try {
    const event = await loadEventScoped(req.params.id, req.session);
    if (!event) return res.status(404).render('error', { title: 'לא נמצא', message: 'אירוע לא קיים' });

    event.ticketsEnabled = true;
    event.checkInToken = generateToken(32);
    await event.save();
    return res.redirect(`/admin/events/${event._id}/edit`);
  } catch (err) {
    console.error(err);
    return renderEventEditPage(req, res.status(500), { editId: req.params.id, formError: 'שגיאה ביצירת קישור סריקה' });
  }
});

router.post('/events/:id/delete', requireAccountContext, async (req, res) => {
  try {
    const event = await loadEventScoped(req.params.id, req.session);
    if (!event) return res.status(404).render('error', { title: 'לא נמצא', message: 'אירוע לא קיים' });

    const cfg = await FormConfig.findOne({ eventId: event._id });
    if (cfg) {
      await Promise.all([deleteFile(cfg.logoUrl), deleteFile(cfg.backgroundImage)]);
      await cfg.deleteOne();
    }

    await Registration.deleteMany({ eventId: event._id });
    await event.deleteOne();
    return res.redirect('/admin/events');
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { title: 'שגיאה', message: 'מחיקה נכשלה' });
  }
});

// ---------------------------------------------------------------------------
// Form Builder — GET: render with signed URLs | POST: save S3 keys from body
// ---------------------------------------------------------------------------

router.get('/events/:id/form-builder', requireAccountContext, async (req, res) => {
  return res.redirect(302, `/admin/events/${req.params.id}/edit#form-design`);
});

router.post('/events/:id/form-builder', requireAccountContext, async (req, res) => {
  try {
    const event = await loadEventScoped(req.params.id, req.session);
    if (!event) return res.status(404).render('error', { title: 'לא נמצא', message: 'אירוע לא קיים' });

    const cfg = await ensureFormConfig(event._id);
    const parsed = parseFormConfigBody(req.body);
    cfg.colors = parsed.colors;
    cfg.fields = parsed.fields;
    cfg.customFields = [];

    // Images are uploaded via AJAX first; the resulting S3 keys arrive as
    // plain text fields: logoKey and backgroundImageKey.
    const logoKey = (req.body.logoKey || '').trim();
    const bgKey = (req.body.backgroundImageKey || '').trim();

    if (logoKey && logoKey !== cfg.logoUrl) {
      await deleteFile(cfg.logoUrl);
      cfg.logoUrl = logoKey;
    }

    if (bgKey && bgKey !== cfg.backgroundImage) {
      await deleteFile(cfg.backgroundImage);
      cfg.backgroundImage = bgKey;
    }

    if (req.body.clearLogo === 'true') {
      await deleteFile(cfg.logoUrl);
      cfg.logoUrl = '';
    }

    if (req.body.clearBackground === 'true') {
      await deleteFile(cfg.backgroundImage);
      cfg.backgroundImage = '';
    }

    await cfg.save();
    return res.redirect(302, `/admin/events/${event._id}/edit#form-design`);
  } catch (err) {
    console.error(err);
    res.status(500);
    return renderEventEditPage(req, res, {
      editId: req.params.id,
      formBuilderError: err.message || 'שגיאה בשמירה',
    });
  }
});

// ---------------------------------------------------------------------------
// Registrations
// ---------------------------------------------------------------------------

router.get('/events/:id/registrations', requireAccountContext, async (req, res) => {
  try {
    const eventDoc = await loadEventScoped(req.params.id, req.session);
    if (!eventDoc) return res.status(404).render('error', { title: 'לא נמצא', message: 'אירוע לא קיים' });
    const event = eventDoc.toObject ? eventDoc.toObject() : eventDoc;

    const registrations = await Registration.find({ eventId: event._id }).sort({ createdAt: -1 }).lean();
    const formConfig = await FormConfig.findOne({ eventId: event._id }).lean();
    const customFieldDefs = getCustomFieldDefs(getFieldsForRender(formConfig));
    const totalChildren = registrations.reduce(
      (sum, r) => sum + (r.children && r.children.length ? r.children.length : 0),
      0
    );

    const al = await adminLocals(req);
    res.render('admin/registrations', {
      title: `נרשמים — ${event.name}`,
      event,
      registrations,
      customFieldDefs,
      registrationCount: registrations.length,
      totalChildren,
      ...al,
    });
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { title: 'שגיאה', message: 'שגיאת שרת' });
  }
});

router.post('/events/:eventId/registrations/:registrationId/delete', requireAccountContext, async (req, res) => {
  try {
    const eventDoc = await loadEventScoped(req.params.eventId, req.session);
    if (!eventDoc) return res.status(404).render('error', { title: 'לא נמצא', message: 'אירוע לא קיים' });
    const event = eventDoc.toObject ? eventDoc.toObject() : eventDoc;

    const reg = await Registration.findOne({ _id: req.params.registrationId, eventId: event._id });
    if (!reg) return res.status(404).render('error', { title: 'לא נמצא', message: 'הרשמה לא נמצאה' });

    await reg.deleteOne();
    return res.redirect(`/admin/events/${event._id}/registrations`);
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { title: 'שגיאה', message: 'מחיקה נכשלה' });
  }
});

function csvEscape(cell) {
  const s = cell === null || cell === undefined ? '' : String(cell);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

router.get('/events/:id/registrations/export.csv', requireAccountContext, async (req, res) => {
  try {
    const eventDoc = await loadEventScoped(req.params.id, req.session);
    if (!eventDoc) return res.status(404).send('Not found');
    const event = eventDoc.toObject ? eventDoc.toObject() : eventDoc;

    const registrations = await Registration.find({ eventId: event._id }).sort({ createdAt: -1 }).lean();
    const formConfig = await FormConfig.findOne({ eventId: event._id }).lean();
    const customFieldDefs = getCustomFieldDefs(getFieldsForRender(formConfig));

    const baseHeaders = ['תאריך הרשמה', 'שם פרטי הורה', 'שם משפחה הורה', 'טלפון', 'ילדים (שם וגיל)'];
    const customHeaders = customFieldDefs.map((f) => f.label);

    const rows = registrations.map((r) => {
      const childrenArr = r.children || [];
      const childrenStr = childrenArr.map((c) => `${c.name} (${c.age})`).join('; ');
      const base = [
        r.createdAt ? new Date(r.createdAt).toISOString() : '',
        r.parentFirstName,
        r.parentLastName,
        r.phone,
        String(childrenArr.length),
        childrenStr,
      ];
      const customVals = customFieldDefs.map((f) => {
        const v = r.customFields && r.customFields[f.id];
        if (typeof v === 'boolean') return v ? 'כן' : 'לא';
        return v !== undefined && v !== null ? v : '';
      });
      return [...base, ...customVals];
    });

    const headerLine = [...baseHeaders, ...customHeaders].map(csvEscape).join(',');
    const lines = rows.map((row) => row.map(csvEscape).join(','));
    const csv = '\uFEFF' + [headerLine, ...lines].join('\r\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="registrations-${event.slug}.csv"`);
    return res.send(csv);
  } catch (err) {
    console.error(err);
    res.status(500).send('Error');
  }
});

module.exports = router;
