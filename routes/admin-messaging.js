const express = require('express');
const multer = require('multer');
const Event = require('../models/Event');
const Account = require('../models/Account');
const AccountMembership = require('../models/AccountMembership');
const MessageCampaign = require('../models/MessageCampaign');
const { requireAccountContext } = require('../middleware/auth');
const { uploadFile } = require('../lib/s3');
const {
  cancelCampaign,
  createCampaign,
  getCampaignStatus,
  pauseCampaign,
  resumeCampaign,
} = require('../lib/messageQueue');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /^image\/(jpeg|png|gif|webp|svg\+xml)$/.test(file.mimetype);
    if (ok) cb(null, true);
    else cb(new Error('רק קבצי תמונה מותרים'));
  },
});

async function loadEventScoped(eventId, session) {
  const event = await Event.findById(eventId);
  if (!event) return null;
  if (session.role === 'superadmin') return event;
  if (String(event.accountId) !== session.activeAccountId) return null;
  return event;
}

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

async function ensureCampaignScoped(campaignId, eventId, session) {
  const campaign = await MessageCampaign.findOne({ _id: campaignId, eventId });
  if (!campaign) return null;
  if (session.role === 'superadmin') return campaign;
  if (String(campaign.accountId) !== session.activeAccountId) return null;
  return campaign;
}

function redirectToCampaign(eventId, campaignId) {
  return `/admin/events/${eventId}/messaging/campaigns/${campaignId}`;
}

router.get('/admin/events/:id/messaging', requireAccountContext, async (req, res) => {
  try {
    const eventDoc = await loadEventScoped(req.params.id, req.session);
    if (!eventDoc) return res.status(404).render('error', { title: 'לא נמצא', message: 'אירוע לא קיים' });

    const campaigns = await MessageCampaign.find({ eventId: eventDoc._id }).sort({ createdAt: -1 }).lean();
    const al = await adminLocals(req);
    return res.render('admin/messaging', {
      title: `שליחת הודעות — ${eventDoc.name}`,
      event: eventDoc.toObject(),
      campaigns,
      formError: null,
      formMessage: null,
      ...al,
    });
  } catch (err) {
    console.error('messaging page error', err);
    return res.status(500).render('error', { title: 'שגיאה', message: 'שגיאת שרת' });
  }
});

router.post('/admin/events/:id/messaging/start', requireAccountContext, upload.single('image'), async (req, res) => {
  try {
    const eventDoc = await loadEventScoped(req.params.id, req.session);
    if (!eventDoc) return res.status(404).render('error', { title: 'לא נמצא', message: 'אירוע לא קיים' });

    const messageText = (req.body.messageText || '').trim();
    if (!messageText) {
      const campaigns = await MessageCampaign.find({ eventId: eventDoc._id }).sort({ createdAt: -1 }).lean();
      const al = await adminLocals(req);
      return res.status(400).render('admin/messaging', {
        title: `שליחת הודעות — ${eventDoc.name}`,
        event: eventDoc.toObject(),
        campaigns,
        formError: 'תוכן ההודעה חובה',
        formMessage: null,
        ...al,
      });
    }

    let imageKey = (req.body.imageKey || '').trim();
    if (req.file) {
      imageKey = await uploadFile(req.file.buffer, req.file.originalname, req.file.mimetype, 'message-images');
    }

    const campaign = await createCampaign({
      event: eventDoc,
      accountId: eventDoc.accountId,
      userId: req.session.userId,
      messageText,
      imageKey,
      name: (req.body.name || '').trim(),
      publicBaseUrl: (process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, ''),
    });

    return res.redirect(redirectToCampaign(eventDoc._id, campaign._id));
  } catch (err) {
    console.error('messaging start error', err);
    const eventDoc = await loadEventScoped(req.params.id, req.session).catch(() => null);
    if (!eventDoc) return res.status(500).render('error', { title: 'שגיאה', message: err.message || 'שגיאת שרת' });
    const campaigns = await MessageCampaign.find({ eventId: eventDoc._id }).sort({ createdAt: -1 }).lean();
    const al = await adminLocals(req);
    return res.status(500).render('admin/messaging', {
      title: `שליחת הודעות — ${eventDoc.name}`,
      event: eventDoc.toObject(),
      campaigns,
      formError: err.message || 'לא ניתן להתחיל שליחה',
      formMessage: null,
      ...al,
    });
  }
});

router.get('/admin/events/:id/messaging/campaigns/:campaignId', requireAccountContext, async (req, res) => {
  try {
    const eventDoc = await loadEventScoped(req.params.id, req.session);
    if (!eventDoc) return res.status(404).render('error', { title: 'לא נמצא', message: 'אירוע לא קיים' });

    const campaign = await ensureCampaignScoped(req.params.campaignId, eventDoc._id, req.session);
    if (!campaign) return res.status(404).render('error', { title: 'לא נמצא', message: 'קמפיין לא נמצא' });

    const status = await getCampaignStatus(campaign._id, { logLimit: 100 });
    const al = await adminLocals(req);
    return res.render('admin/messaging-campaign', {
      title: `מעקב שליחה — ${eventDoc.name}`,
      event: eventDoc.toObject(),
      status,
      ...al,
    });
  } catch (err) {
    console.error('campaign page error', err);
    return res.status(500).render('error', { title: 'שגיאה', message: 'שגיאת שרת' });
  }
});

router.get('/admin/events/:id/messaging/campaigns/:campaignId/status.json', requireAccountContext, async (req, res) => {
  try {
    const eventDoc = await loadEventScoped(req.params.id, req.session);
    if (!eventDoc) return res.status(404).json({ error: 'Event not found' });

    const campaign = await ensureCampaignScoped(req.params.campaignId, eventDoc._id, req.session);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    const status = await getCampaignStatus(campaign._id, { logLimit: 100 });
    return res.json(status);
  } catch (err) {
    console.error('campaign status error', err);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
});

router.post('/admin/events/:id/messaging/campaigns/:campaignId/pause', requireAccountContext, async (req, res) => {
  const eventDoc = await loadEventScoped(req.params.id, req.session);
  if (!eventDoc) return res.status(404).render('error', { title: 'לא נמצא', message: 'אירוע לא קיים' });
  const campaign = await ensureCampaignScoped(req.params.campaignId, eventDoc._id, req.session);
  if (campaign) await pauseCampaign(campaign._id);
  return res.redirect(redirectToCampaign(eventDoc._id, req.params.campaignId));
});

router.post('/admin/events/:id/messaging/campaigns/:campaignId/resume', requireAccountContext, async (req, res) => {
  const eventDoc = await loadEventScoped(req.params.id, req.session);
  if (!eventDoc) return res.status(404).render('error', { title: 'לא נמצא', message: 'אירוע לא קיים' });
  const campaign = await ensureCampaignScoped(req.params.campaignId, eventDoc._id, req.session);
  if (campaign) await resumeCampaign(campaign._id);
  return res.redirect(redirectToCampaign(eventDoc._id, req.params.campaignId));
});

router.post('/admin/events/:id/messaging/campaigns/:campaignId/cancel', requireAccountContext, async (req, res) => {
  const eventDoc = await loadEventScoped(req.params.id, req.session);
  if (!eventDoc) return res.status(404).render('error', { title: 'לא נמצא', message: 'אירוע לא קיים' });
  const campaign = await ensureCampaignScoped(req.params.campaignId, eventDoc._id, req.session);
  if (campaign) await cancelCampaign(campaign._id);
  return res.redirect(redirectToCampaign(eventDoc._id, req.params.campaignId));
});

module.exports = router;
