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
const { buildGateUrl, generateToken, assignTicketToken, buildTicketUrl, ensureEventCheckInToken } = require('../lib/tickets');
const { normalizePhone, sendTicket } = require('../lib/wasender');
const { countSignupUsage } = require('../lib/signupLimits');
const { additionalParticipants, participantCounts, totalsForRegistrations, deliveryState, activeRegistrationFilter } = require('../lib/participants');
const { eventState, registrationState, limitLabel } = require('../lib/eventStatus');
const { adminLocals: sharedAdminLocals, accountFilter: sharedAccountFilter } = require('../lib/adminContext');
const MessageCampaign = require('../models/MessageCampaign');

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
  const hasChildrenSubmitted = body.hasChildrenPresent === '1';
  const hasChildren = hasChildrenSubmitted
    ? body.hasChildren === 'on' || body.hasChildren === 'true'
    : body.hasChildren === undefined
      ? true
      : body.hasChildren === 'on' || body.hasChildren === 'true';
  let signupLimitCountMode = 'families';
  if (body.signupLimitCountMode === 'participants') signupLimitCountMode = 'participants';
  else if (body.signupLimitCountMode === 'children') signupLimitCountMode = 'children';
  const signupCloseAt = parseDatetimeLocalInput(body.signupCloseAt || '');
  const signupPhoneUnique = body.signupPhoneUnique === 'on' || body.signupPhoneUnique === 'true';
  const capPresent = body.ticketCapIncludesRegistrantPresent === '1';
  const ticketCapIncludesRegistrant = capPresent
    ? body.ticketCapIncludesRegistrant === 'on' || body.ticketCapIncludesRegistrant === 'true'
    : body.ticketCapIncludesRegistrant === 'on' || body.ticketCapIncludesRegistrant === 'true';
  return {
    signupLimit,
    signupLimitCountMode,
    signupCloseAt,
    signupPhoneUnique,
    hasChildren,
    ticketCapIncludesRegistrant,
    signupPaused: body.signupPaused === 'on',
    signupOpenAt: parseDatetimeLocalInput(body.signupOpenAt || ''),
  };
}

function parseLogoMaxHeight(raw) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return 120;
  return Math.min(400, Math.max(60, Math.round(value)));
}

function parseFormConfigBody(body, { hasChildren = true } = {}) {
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
    fields: sanitizeFieldsFromBuilder(fields, { hasChildren }),
    logoMaxHeight: parseLogoMaxHeight(body.logoMaxHeight),
  };
}

function stableS3ImageUrl(key) {
  return `/images/s3/${encodeURIComponent(key)}`;
}

async function ensureFormConfig(eventId, { hasChildren = true } = {}) {
  let cfg = await FormConfig.findOne({ eventId });
  if (!cfg) {
    const owner = await Event.findById(eventId).select('accountId').lean();
    const account = owner ? await Account.findById(owner.accountId).lean() : null;
    return FormConfig.create({
      eventId,
      colors: account?.brandColor ? { primary: account.brandColor, button: account.brandColor } : {},
      organizerLogoUrl: account?.logoUrl || '',
      fields: defaultFields({ hasChildren }),
    });
  }
  const needsMigrate =
    !cfg.fields ||
    cfg.fields.length === 0 ||
    (cfg.customFields && cfg.customFields.length > 0);
  if (needsMigrate) {
    cfg.fields = normalizeStoredFields(cfg, { hasChildren });
    cfg.customFields = [];
    await cfg.save();
  }
  return cfg;
}

async function syncFormConfigForChildren(eventId, hasChildren) {
  const cfg = await FormConfig.findOne({ eventId });
  if (!cfg) return;
  cfg.fields = sanitizeFieldsFromBuilder(cfg.fields || [], { hasChildren });
  cfg.customFields = [];
  await cfg.save();
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
  if (req.session.role === 'superadmin' && accountId === 'all') {
    delete req.session.activeAccountId; delete req.session.activeAccountName;
    return res.redirect('/admin');
  }
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
  return sharedAccountFilter(session);
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
  return sharedAdminLocals(req);
}

// ---------------------------------------------------------------------------
// AJAX image upload — returns { key } for use in form hidden inputs
// ---------------------------------------------------------------------------

router.post('/upload-image', requireLogin, upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'לא נבחרה תמונה' });
    const folder = req.body.purpose === 'event-description' ? 'event-descriptions' : 'uploads';
    const key = await uploadFile(req.file.buffer, req.file.originalname, req.file.mimetype, folder);
    return res.json({ key, location: stableS3ImageUrl(key) });
  } catch (err) {
    console.error('upload-image error', err);
    return res.status(500).json({ error: err.message || 'שגיאת שרת' });
  }
});

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

router.get('/settings', requireSuperAdmin, async (req, res) => res.render('admin/settings', { title: 'הגדרות המערכת', ...await adminLocals(req) }));

router.get('/', requireAccountContext, async (req, res) => {
  try {
    const filter = accountFilter(req.session);
    const events = await Event.find(filter).sort({ createdAt: -1 }).populate('accountId').lean();
    const registrations = await Registration.find({ eventId: { $in: events.map(e => e._id) } }).select('eventId participants children status ticketCheckedInAt ticketCheckInAdults ticketCheckInChildren ticketWhatsAppError ticketWhatsAppSentAt').lean();
    const stats = Object.fromEntries(events.map(e => [String(e._id), totalsForRegistrations(registrations.filter(r => String(r.eventId) === String(e._id)), e)]));
    const al = await adminLocals(req);
    res.render('admin/dashboard', { title: 'לוח בקרה', events, stats, ...al });
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
  const registrations = await Registration.find({ eventId: { $in: events.map(e => e._id) } }).select('eventId participants children status ticketCheckedInAt ticketWhatsAppError ticketWhatsAppSentAt').lean();
  const stats = Object.fromEntries(events.map(e => [String(e._id), totalsForRegistrations(registrations.filter(r => String(r.eventId) === String(e._id)), e)]));
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const al = await adminLocals(req);
  const allAccounts = req.session.role === 'superadmin' ? await Account.find().sort({ name: 1 }).lean() : [];
  return res.render('admin/events', {
    title: 'ניהול אירועים',
    events,
    stats,
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
  const hasChildren = editObj.hasChildren !== false;
  const cfg = await ensureFormConfig(editObj._id, { hasChildren });
  const plain = cfg.toObject();
  plain.fields = getFieldsForRender(plain, { hasChildren });
  const builderConfig = await resolveConfigUrls(plain);
  const builderConfigRaw = cfg.toObject();
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const al = await adminLocals(req);
  const gateUrl = editObj.ticketsEnabled && editObj.checkInToken ? buildGateUrl(req, editObj.checkInToken) : '';
  const registrations = await Registration.find({ eventId: editObj._id }).select('participants children status ticketCheckedInAt ticketCheckInAdults ticketCheckInChildren ticketWhatsAppError ticketWhatsAppSentAt').lean();
  const stats = totalsForRegistrations(registrations, editObj);
  const tab = ['overview', 'page', 'registration', 'tickets'].includes(req.query.tab) ? req.query.tab : 'page';
  return res.render('admin/event-edit', {
    title: `עריכה — ${editObj.name}`,
    editEvent: editObj,
    event: editObj, activeTab: tab, stats, saved: req.query.saved === '1',
    editDescriptionHtml,
    formError: opts.formError || null,
    formBuilderError: opts.formBuilderError || null,
    baseUrl,
    builderConfig,
    builderConfigRaw,
    eventDateInput: toDatetimeLocalInputValue(editObj.date),
    signupCloseAtInput: toDatetimeLocalInputValue(editObj.signupCloseAt),
    signupOpenAtInput: toDatetimeLocalInputValue(editObj.signupOpenAt),
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

router.get('/events/:id', requireAccountContext, async (req, res) => {
  return res.redirect(`/admin/events/${req.params.id}/edit?tab=overview`);
});

router.get('/events/:id/preview', requireAccountContext, async (req, res) => {
  const event = await loadEventScoped(req.params.id, req.session);
  if (!event) return res.status(404).send('Event not found');
  return require('./public').renderRegistrationForm(res, 200, { event: event.toObject(), preview: true });
});

router.post('/events/:id/page', requireAccountContext, async (req, res) => {
  const event = await loadEventScoped(req.params.id, req.session);
  if (!event) return res.status(404).send('Event not found');
  if (!String(req.body.name || '').trim()) return res.status(400).render('error', { title: 'שם אירוע חסר', message: 'יש למלא שם לאירוע.' });
  event.name = String(req.body.name).trim();
  event.description = String(req.body.description || '').trim();
  event.date = parseDatetimeLocalInput(req.body.date || '');
  if (req.body.isActive === 'on' && !event.date) return res.status(400).render('error', { title: 'יש להשלים מועד', message: 'כדי לפרסם את האירוע יש לקבוע תאריך ושעה. ניתן לשמור ללא פרסום כטיוטה.' });
  event.location = String(req.body.location || '').trim();
  event.isActive = req.body.isActive === 'on';
  event.slug = await uniqueSlug(slugify(req.body.slug || event.name), event._id);
  await event.save();
  const cfg = await ensureFormConfig(event._id, { hasChildren: event.hasChildren !== false });
  for (const [input, key] of [['logoKey', 'logoUrl'], ['organizerLogoKey', 'organizerLogoUrl'], ['backgroundImageKey', 'backgroundImage']]) {
    if (Object.prototype.hasOwnProperty.call(req.body, input)) cfg[key] = String(req.body[input] || '').trim();
  }
  cfg.logoMaxHeight = parseLogoMaxHeight(req.body.logoMaxHeight);
  cfg.colors = { primary: req.body.colorPrimary || '#0d6efd', background: req.body.colorBackground || '#f8f9fa', text: req.body.colorText || '#212529', button: req.body.colorButton || '#0d6efd' };
  await cfg.save();
  res.redirect(`/admin/events/${event._id}/edit?tab=page&saved=1`);
});

router.post('/events/:id/registration-settings', requireAccountContext, async (req, res) => {
  const event = await loadEventScoped(req.params.id, req.session);
  if (!event) return res.status(404).send('Event not found');
  const signup = parseSignupFields(req.body);
  if (signup.signupOpenAt && signup.signupCloseAt && signup.signupOpenAt >= signup.signupCloseAt) return res.status(400).render('error', { title: 'מועדים לא תקינים', message: 'מועד פתיחת ההרשמה חייב להיות לפני מועד הסגירה.' });
  let fields;
  try { fields = JSON.parse(req.body.fieldsJson); if (!Array.isArray(fields)) throw new Error(); }
  catch { return res.status(400).render('error', { title: 'הטופס לא נשמר', message: 'מבנה שדות הטופס לא תקין. יש לרענן ולנסות שוב.' }); }
  Object.assign(event, signup);
  const cfg = await ensureFormConfig(event._id, { hasChildren: event.hasChildren !== false });
  cfg.fields = sanitizeFieldsFromBuilder(fields, { hasChildren: event.hasChildren !== false });
  cfg.customFields = [];
  await cfg.save();
  await event.save();
  res.redirect(`/admin/events/${event._id}/edit?tab=registration&saved=1`);
});

router.post('/events/:id/ticket-settings', requireAccountContext, async (req, res) => {
  const event = await loadEventScoped(req.params.id, req.session);
  if (!event) return res.status(404).send('Event not found');
  event.ticketsEnabled = req.body.ticketsEnabled === 'on';
  event.ticketsGateAllowCountEdit = event.ticketsEnabled && req.body.ticketsGateAllowCountEdit === 'on';
  if (event.ticketsEnabled && !event.checkInToken) event.checkInToken = generateToken(32);
  await event.save();
  res.redirect(`/admin/events/${event._id}/edit?tab=tickets&saved=1`);
});

router.post('/events/:id/archive', requireAccountContext, async (req, res) => {
  const event = await loadEventScoped(req.params.id, req.session);
  if (!event) return res.status(404).send('Event not found');
  event.archivedAt = req.body.restore === '1' ? null : new Date();
  await event.save();
  if (event.archivedAt) await MessageCampaign.updateMany({ eventId: event._id, status: { $in: ['queued', 'running', 'paused'] } }, { $set: { status: 'cancelled', completedAt: new Date() } });
  res.redirect('/admin/events');
});

router.post('/events/:id/duplicate', requireAccountContext, async (req, res) => {
  const source = await loadEventScoped(req.params.id, req.session);
  if (!source) return res.status(404).send('Event not found');
  const { _id, createdAt, updatedAt, checkInToken, __v, ...data } = source.toObject();
  const copy = await Event.create({ ...data, name: `${source.name} (עותק)`, slug: await uniqueSlug(`${source.slug}-copy`), date: null, isActive: false, archivedAt: null, signupPaused: false, signupOpenAt: null, signupCloseAt: null, checkInToken: source.ticketsEnabled ? generateToken(32) : undefined });
  const config = await FormConfig.findOne({ eventId: source._id }).lean();
  if (config) { const { _id: configId, eventId, __v: version, createdAt: oldCreated, updatedAt: oldUpdated, ...design } = config; await FormConfig.create({ ...design, eventId: copy._id }); }
  else await ensureFormConfig(copy._id, { hasChildren: copy.hasChildren !== false });
  res.redirect(`/admin/events/${copy._id}/edit?tab=page`);
});

router.post('/events/create', requireAccountContext, async (req, res) => {
  try {
    const name = (req.body.name || '').trim();
    const description = (req.body.description || '').trim();
    const dateVal = parseDatetimeLocalInput(req.body.date || '');
    const slugInput = (req.body.slug || '').trim();
    const isActive = req.body.isActive === 'on' || req.body.isActive === 'true';
    const signup = parseSignupFields(req.body);
    if (['individual', 'group', 'family'].includes(req.body.registrationType)) signup.hasChildren = req.body.registrationType === 'family';
    const ticketsEnabled = req.body.ticketsEnabled === 'on' || req.body.ticketsEnabled === 'true';
    const ticketsGateAllowCountEdit =
      ticketsEnabled && (req.body.ticketsGateAllowCountEdit === 'on' || req.body.ticketsGateAllowCountEdit === 'true');

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
      signupPhoneUnique: signup.signupPhoneUnique,
      hasChildren: signup.hasChildren,
      ticketCapIncludesRegistrant: signup.ticketCapIncludesRegistrant,
      ticketsEnabled,
      ticketsGateAllowCountEdit,
      checkInToken: ticketsEnabled ? generateToken(32) : undefined,
    });
    const initialConfig = await ensureFormConfig(event._id, { hasChildren: signup.hasChildren });
    if (req.body.registrationType === 'group') {
      const fields = initialConfig.fields.map(f => f.toObject ? f.toObject() : f);
      initialConfig.fields = sanitizeFieldsFromBuilder([...fields.filter(f => f.type !== 'checkbox'), { id: 'ch', type: 'children', label: 'משתתפים נוספים', childNameLabel: 'שם המשתתף/ת', collectAge: false, required: false }, ...fields.filter(f => f.type === 'checkbox')], { hasChildren: false });
      await initialConfig.save();
    }
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
    const ticketsGateAllowCountEdit =
      ticketsEnabled && (req.body.ticketsGateAllowCountEdit === 'on' || req.body.ticketsGateAllowCountEdit === 'true');

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
    event.signupPhoneUnique = signup.signupPhoneUnique;
    const previousHasChildren = event.hasChildren !== false;
    event.hasChildren = signup.hasChildren;
    event.ticketCapIncludesRegistrant = signup.ticketCapIncludesRegistrant;
    event.ticketsEnabled = ticketsEnabled;
    event.ticketsGateAllowCountEdit = ticketsGateAllowCountEdit;
    if (ticketsEnabled && !event.checkInToken) {
      event.checkInToken = generateToken(32);
    }
    await event.save();
    if (previousHasChildren !== event.hasChildren) {
      await syncFormConfigForChildren(event._id, event.hasChildren);
    }
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

    event.archivedAt = new Date();
    await event.save();
    await MessageCampaign.updateMany({ eventId: event._id, status: { $in: ['queued', 'running', 'paused'] } }, { $set: { status: 'cancelled', completedAt: new Date() } });
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
  return res.redirect(302, `/admin/events/${req.params.id}/edit?tab=registration`);
});

router.post('/events/:id/form-builder', requireAccountContext, async (req, res) => {
  try {
    const event = await loadEventScoped(req.params.id, req.session);
    if (!event) return res.status(404).render('error', { title: 'לא נמצא', message: 'אירוע לא קיים' });

    const hasChildren = event.hasChildren !== false;
    const cfg = await ensureFormConfig(event._id, { hasChildren });
    const parsed = parseFormConfigBody(req.body, { hasChildren });
    cfg.colors = parsed.colors;
    cfg.fields = parsed.fields;
    cfg.logoMaxHeight = parsed.logoMaxHeight;
    cfg.customFields = [];

    // Images are uploaded via AJAX first; the resulting S3 keys arrive as
    // plain text fields: logoKey and backgroundImageKey.
    const logoKey = (req.body.logoKey || '').trim();
    const bgKey = (req.body.backgroundImageKey || '').trim();

    if (logoKey && logoKey !== cfg.logoUrl) {
      cfg.logoUrl = logoKey;
    }

    if (bgKey && bgKey !== cfg.backgroundImage) {
      cfg.backgroundImage = bgKey;
    }

    if (req.body.clearLogo === 'true') {
      cfg.logoUrl = '';
    }

    if (req.body.clearBackground === 'true') {
      cfg.backgroundImage = '';
    }

    await cfg.save();
    return res.redirect(302, `/admin/events/${event._id}/edit?tab=registration&saved=1`);
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

    const hasChildren = event.hasChildren !== false;
    const registrations = await Registration.find({ eventId: event._id }).sort({ createdAt: -1 }).lean();
    const formConfig = await FormConfig.findOne({ eventId: event._id }).lean();
    const allFields = getFieldsForRender(formConfig, { hasChildren });
    const customFieldDefs = getCustomFieldDefs(allFields);
    const peopleField = allFields.find((f) => f.type === 'children') || null;
    const totalPeople = peopleField
      ? registrations.reduce(
          (sum, r) => sum + (r.children && r.children.length ? r.children.length : 0),
          0
        )
      : 0;

    const al = await adminLocals(req);
    res.render('admin/registrations', {
      title: `נרשמים — ${event.name}`,
      event,
      registrations,
      customFieldDefs,
      peopleField,
      registrationCount: registrations.length,
      totalPeople,
      stats: totalsForRegistrations(registrations, event),
      activeTab: 'registrations',
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

    reg.status = 'cancelled'; reg.cancelledAt = new Date(); reg.updatedBy = req.session.userId;
    await reg.save();
    return res.redirect(`/admin/events/${event._id}/registrations`);
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { title: 'שגיאה', message: 'מחיקה נכשלה' });
  }
});

router.get('/events/:eventId/registrations/:registrationId', requireAccountContext, async (req, res, next) => {
  if (req.params.registrationId === 'export.csv') return next();
  const event = await loadEventScoped(req.params.eventId, req.session);
  if (!event) return res.status(404).send('Event not found');
  const registration = await Registration.findOne({ _id: req.params.registrationId, eventId: event._id }).lean();
  if (!registration) return res.status(404).send('Registration not found');
  const config = await FormConfig.findOne({ eventId: event._id }).lean();
  res.render('admin/registration-detail', { title: 'פרטי הרשמה', event: event.toObject(), registration, activeTab: 'registrations', customFieldDefs: getCustomFieldDefs(getFieldsForRender(config, { hasChildren: event.hasChildren !== false })), saved: req.query.saved === '1', ticketSent: req.query.sent === '1', ...await adminLocals(req) });
});

router.post('/events/:eventId/registrations/:registrationId/update', requireAccountContext, async (req, res) => {
  const event = await loadEventScoped(req.params.eventId, req.session);
  if (!event) return res.status(404).send('Event not found');
  const registration = await Registration.findOne({ _id: req.params.registrationId, eventId: event._id });
  if (!registration) return res.status(404).send('Registration not found');
  const phone = String(req.body.phone || '').trim(); const normalized = normalizePhone(phone);
  if (event.signupPhoneUnique && normalized && registration.status !== 'cancelled' && await Registration.exists({ eventId: event._id, phoneNormalized: normalized, _id: { $ne: registration._id }, ...activeRegistrationFilter })) return res.status(400).render('error', { title: 'מספר הטלפון כבר רשום', message: 'קיימת הרשמה פעילה אחרת עם מספר טלפון זה.' });
  const rows = req.body.participants == null ? [] : Array.isArray(req.body.participants) ? req.body.participants : Object.values(req.body.participants);
  if (rows.length > 200) return res.status(400).send('Too many participants');
  const participants = rows.filter(p => String(p.name || '').trim()).map(p => ({ name: String(p.name).trim().slice(0,120), age: p.age === '' || p.age == null ? null : Number(p.age), category: ['child','adult','general'].includes(p.category) ? p.category : 'general' }));
  if (participants.some(p => p.age != null && (!Number.isFinite(p.age) || p.age < 0 || p.age > 120))) return res.status(400).render('error', { title: 'גיל אינו תקין', message: 'יש להזין גיל בטווח 0 עד 120, או להשאיר ריק.' });
  if (registration.status !== 'cancelled' && event.signupLimit != null) {
    const mode = event.signupLimitCountMode; const current = await countSignupUsage(event._id, mode);
    const delta = mode === 'families' ? 0 : participants.length - additionalParticipants(registration, event).length;
    if (delta > 0 && current + delta > event.signupLimit) return res.status(400).render('error', { title: 'חריגה מהמכסה', message: 'אין מספיק מקומות כדי להוסיף את המשתתפים להרשמה.' });
  }
  registration.parentFirstName = String(req.body.parentFirstName || '').trim().slice(0,120);
  registration.parentLastName = String(req.body.parentLastName || '').trim().slice(0,120);
  registration.phone = phone; registration.phoneNormalized = normalized;
  registration.participants = participants;
  registration.children = participants.map(p => ({ name: p.name, age: p.age ?? 0 }));
  registration.updatedBy = req.session.userId;
  await registration.save();
  res.redirect(`/admin/events/${event._id}/registrations/${registration._id}?saved=1`);
});

router.post('/events/:eventId/registrations/:registrationId/restore', requireAccountContext, async (req, res) => {
  const event = await loadEventScoped(req.params.eventId, req.session);
  if (!event) return res.status(404).send('Event not found');
  const registration = await Registration.findOne({ _id: req.params.registrationId, eventId: event._id });
  if (!registration) return res.status(404).send('Registration not found');
  if (registration.status === 'cancelled') {
    if (event.signupPhoneUnique && registration.phoneNormalized && await Registration.exists({ eventId: event._id, phoneNormalized: registration.phoneNormalized, _id: { $ne: registration._id }, ...activeRegistrationFilter })) return res.status(400).render('error', { title: 'לא ניתן לשחזר', message: 'כבר קיימת הרשמה פעילה עם מספר טלפון זה.' });
    const count = participantCounts(registration, event); const mode = event.signupLimitCountMode;
    if (event.signupLimit != null && await countSignupUsage(event._id, mode) + (mode === 'participants' ? count.total : mode === 'children' ? count.additional : 1) > event.signupLimit) return res.status(400).render('error', { title: 'לא ניתן לשחזר', message: 'שחזור ההרשמה יחרוג מהמכסה.' });
    registration.status = 'confirmed'; registration.cancelledAt = null; registration.updatedBy = req.session.userId;
    await registration.save();
  }
  res.redirect(`/admin/events/${event._id}/registrations/${registration._id}?saved=1`);
});

router.post('/events/:eventId/registrations/:registrationId/send-ticket', requireAccountContext, async (req, res) => {
  const event = await loadEventScoped(req.params.eventId, req.session);
  if (!event) return res.status(404).send('Event not found');
  const registration = await Registration.findOne({ _id: req.params.registrationId, eventId: event._id, ...activeRegistrationFilter });
  if (!registration || !event.ticketsEnabled || event.archivedAt) return res.status(400).render('error', { title: 'הכרטיס אינו זמין', message: 'יש לוודא שההרשמה פעילה והכרטיסים מופעלים.' });
  await ensureEventCheckInToken(event); await assignTicketToken(registration);
  const ticketUrl = buildTicketUrl(req, registration.ticketToken);
  try {
    const result = await sendTicket({ event, registration, ticketUrl, qrImageUrl: `${ticketUrl}/qr.png` });
    if (!result.sent) throw new Error(result.error || 'השליחה נכשלה');
    registration.ticketWhatsAppSentAt = new Date(); registration.ticketWhatsAppError = '';
    await registration.save();
  } catch (error) { registration.ticketWhatsAppError = error.message; await registration.save(); return res.status(400).render('error', { title: 'השליחה נכשלה', message: error.message }); }
  res.redirect(`/admin/events/${event._id}/registrations/${registration._id}?sent=1`);
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

    const hasChildren = event.hasChildren !== false;
    const registrations = await Registration.find({ eventId: event._id, ...activeRegistrationFilter }).sort({ createdAt: -1 }).lean();
    const formConfig = await FormConfig.findOne({ eventId: event._id }).lean();
    const allFields = getFieldsForRender(formConfig, { hasChildren });
    const customFieldDefs = getCustomFieldDefs(allFields);
    const peopleField = allFields.find((f) => f.type === 'children') || null;
    const peopleCollectsAge = peopleField ? peopleField.collectAge !== false : false;
    const peopleLabel = peopleField ? peopleField.label : '';

    const baseHeaders = ['תאריך הרשמה', 'שם פרטי', 'שם משפחה', 'טלפון', 'מספר משתתפים', 'שליחת כרטיס', 'כניסה'];
    if (peopleField) {
      baseHeaders.push(`מספר ${peopleLabel}`);
      baseHeaders.push(peopleCollectsAge ? `${peopleLabel} (שם וגיל)` : `${peopleLabel} (שמות)`);
    }
    const customHeaders = customFieldDefs.map((f) => f.label);

    const rows = registrations.map((r) => {
      const childrenArr = additionalParticipants(r, event);
      const base = [
        r.createdAt ? new Date(r.createdAt).toISOString() : '',
        r.parentFirstName,
        r.parentLastName,
        r.phone,
        participantCounts(r, event).total,
        deliveryState(r).label,
        r.ticketCheckedInAt ? formatDateTimeIsrael(r.ticketCheckedInAt) : 'טרם נכנסו',
      ];
      if (peopleField) {
        const childrenStr = peopleCollectsAge
          ? childrenArr.map((c) => `${c.name} (${c.age})`).join('; ')
          : childrenArr.map((c) => c.name).join('; ');
        base.push(String(childrenArr.length), childrenStr);
      }
      const customVals = customFieldDefs.map((f) => {
        const v = r.customFields && r.customFields[f.id];
        if (f.type === 'checkbox') return v === true ? 'כן' : 'לא';
        if (typeof v === 'boolean') return v ? 'כן' : 'לא';
        return v !== undefined && v !== null ? v : '';
      });
      return [...base, ...customVals];
    });

    const headerLine = [...baseHeaders, ...customHeaders].map(csvEscape).join(',');
    const lines = rows.map((row) => row.map(csvEscape).join(','));
    const csv = '\uFEFF' + [headerLine, ...lines].join('\r\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="registrations-${event._id}.csv"; filename*=UTF-8''${encodeURIComponent(`registrations-${event.slug}.csv`)}`);
    return res.send(csv);
  } catch (err) {
    console.error(err);
    res.status(500).send('Error');
  }
});

module.exports = router;
