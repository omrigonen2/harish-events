const express = require('express');
const mongoose = require('mongoose');
const Event = require('../models/Event');
const Registration = require('../models/Registration');
const FormConfig = require('../models/FormConfig');
const { getPresignedUrl, resolveConfigUrls } = require('../lib/s3');
const {
  getFieldsForRender,
  getCustomFieldDefs,
  isCustomFieldType,
} = require('../lib/formFields');
const { sanitizeDescription } = require('../lib/htmlSanitize');
const { getSignupAvailability } = require('../lib/signupLimits');
const {
  assignTicketToken,
  buildTicketUrl,
  ensureEventCheckInToken,
} = require('../lib/tickets');
const { sendTicket } = require('../lib/wasender');

const router = express.Router();

function isAllowedDescriptionImageKey(key) {
  return (
    typeof key === 'string' &&
    key.startsWith('event-descriptions/') &&
    !key.includes('..') &&
    !key.includes('\\') &&
    !key.includes('\0')
  );
}

function hexToRgb(hex) {
  if (!hex || typeof hex !== 'string') return { r: 248, g: 249, b: 250 };
  let h = hex.replace('#', '').trim();
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (h.length !== 6) return { r: 248, g: 249, b: 250 };
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

async function findEventByParam(param) {
  if (mongoose.Types.ObjectId.isValid(param)) {
    const byId = await Event.findById(param).lean();
    if (byId) return byId;
  }
  return Event.findOne({ slug: param }).lean();
}

function parseChildrenFromBody(body) {
  const pairs = [];
  const indexed = Object.keys(body).filter((k) => k.startsWith('children['));
  if (indexed.length) {
    const map = new Map();
    indexed.forEach((key) => {
      const m = key.match(/^children\[(\d+)\]\[(name|age)\]$/);
      if (!m) return;
      const idx = parseInt(m[1], 10);
      const field = m[2];
      if (!map.has(idx)) map.set(idx, {});
      map.get(idx)[field] = body[key];
    });
    const sorted = [...map.keys()].sort((a, b) => a - b);
    sorted.forEach((i) => pairs.push(map.get(i)));
    return pairs
      .map((row) => ({
        name: (row.name || '').trim(),
        age: row.age === '' || row.age === undefined ? NaN : Number(row.age),
      }))
      .filter((row) => row.name || !Number.isNaN(row.age));
  }

  if (Array.isArray(body.children)) {
    return body.children.map((c) => ({
      name: (c.name || '').trim(),
      age: c.age === '' || c.age === undefined ? NaN : Number(c.age),
    }));
  }

  return [];
}

function normalizeChildren(rows) {
  return rows
    .filter((r) => r.name && !Number.isNaN(r.age))
    .map((r) => ({
      name: r.name.trim(),
      age: Math.min(120, Math.max(0, Math.floor(Number(r.age)))),
    }));
}

function childRowsFromOld(oldBody) {
  if (!oldBody || typeof oldBody !== 'object') {
    return [{ name: '', age: '' }];
  }
  if (Array.isArray(oldBody.children) && oldBody.children.length) {
    return oldBody.children.map((c) => ({
      name: c.name != null ? String(c.name) : '',
      age: c.age != null ? String(c.age) : '',
    }));
  }
  const map = new Map();
  Object.keys(oldBody).forEach((key) => {
    const m = key.match(/^children\[(\d+)\]\[(name|age)\]$/);
    if (!m) return;
    const idx = parseInt(m[1], 10);
    if (!map.has(idx)) map.set(idx, {});
    map.get(idx)[m[2]] = oldBody[key];
  });
  const sorted = [...map.keys()]
    .sort((a, b) => a - b)
    .map((i) => ({
      name: map.get(i).name != null ? String(map.get(i).name) : '',
      age: map.get(i).age != null ? String(map.get(i).age) : '',
    }));
  return sorted.length ? sorted : [{ name: '', age: '' }];
}

function parseCustomFieldsFromBody(body, fieldDefs) {
  const out = {};
  if (!fieldDefs || !fieldDefs.length) return out;
  for (const def of fieldDefs) {
    if (!isCustomFieldType(def.type)) continue;
    const key = `custom_${def.id}`;
    if (def.type === 'checkbox') {
      const raw = Array.isArray(body[key]) ? body[key][body[key].length - 1] : body[key];
      out[def.id] = raw === 'on' || raw === 'true' || raw === true;
    } else if (def.type === 'select') {
      const v = body[key];
      if (v !== undefined && v !== '') out[def.id] = String(v).trim();
    } else {
      const v = body[key];
      if (v !== undefined && v !== null) out[def.id] = String(v).trim();
    }
  }
  return out;
}

function validateSubmission(fieldDefs, parentFirstName, parentLastName, phone, children, customData) {
  const errors = [];
  const sorted = [...fieldDefs].sort((a, b) => (a.order || 0) - (b.order || 0));
  for (const f of sorted) {
    if (!f.required) continue;
    if (f.type === 'parent_first') {
      if (!parentFirstName) errors.push(`"${f.label}" חובה`);
    } else if (f.type === 'parent_last') {
      if (!parentLastName) errors.push(`"${f.label}" חובה`);
    } else if (f.type === 'phone') {
      if (!phone) errors.push(`"${f.label}" חובה`);
    } else if (f.type === 'children') {
      if (!children.length) errors.push(`יש למלא לפחות ילד/ה בקטע "${f.label}"`);
    } else if (isCustomFieldType(f.type)) {
      const val = customData[f.id];
      if (val === undefined || val === '' || val === false) {
        errors.push(`"${f.label}" חובה`);
      }
    }
  }
  return errors;
}

async function renderRegistrationForm(res, status, { event, formErrors = [], oldBody = {}, childRows, configDoc }) {
  const rows = childRows || [{ name: '', age: '' }];
  const cfg = configDoc !== undefined ? configDoc : await FormConfig.findOne({ eventId: event._id }).lean();
  const fields = getFieldsForRender(cfg);
  const base = cfg || {
    colors: { primary: '#0d6efd', background: '#f8f9fa', text: '#212529', button: '#0d6efd' },
    backgroundImage: '',
    logoUrl: '',
    fields: [],
  };
  base.fields = fields;
  const effective = await resolveConfigUrls(base);
  const signupAvailability = await getSignupAvailability(event);
  return res.status(status).render('form', {
    title: `הרשמה — ${event.name}`,
    event,
    descriptionHtml: sanitizeDescription(event.description || ''),
    config: effective,
    fields,
    formErrors,
    oldBody,
    childRows: rows,
    signupAvailability,
  });
}

router.get('/', (req, res) => {
  res.render('home', { title: 'חריש · אירועים לקהילה' });
});

router.get('/events', (req, res) => {
  res.redirect('/');
});

router.get('/images/s3/:encodedKey', async (req, res) => {
  try {
    const key = req.params.encodedKey;
    if (!isAllowedDescriptionImageKey(key)) {
      return res.status(404).send('Not found');
    }
    const url = await getPresignedUrl(key);
    return res.redirect(302, url);
  } catch (err) {
    console.error('presigned image error', err);
    return res.status(404).send('Not found');
  }
});

router.get('/register/:eventId', async (req, res) => {
  try {
    const { eventId } = req.params;
    const event = await findEventByParam(eventId);
    if (!event || !event.isActive) {
      return res.status(404).render('error', { title: 'לא נמצא', message: 'האירוע לא נמצא או אינו פעיל' });
    }

    const configDoc = await FormConfig.findOne({ eventId: event._id }).lean();
    return renderRegistrationForm(res, 200, {
      event,
      configDoc,
      childRows: [{ name: '', age: '' }],
    });
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { title: 'שגיאה', message: 'שגיאת שרת' });
  }
});

router.post('/register/:eventId', async (req, res) => {
  try {
    const { eventId } = req.params;
    const event = await findEventByParam(eventId);
    if (!event || !event.isActive) {
      return res.status(404).render('error', { title: 'לא נמצא', message: 'האירוע לא נמצא או אינו פעיל' });
    }

    const configDoc = await FormConfig.findOne({ eventId: event._id }).lean();
    const fieldDefs = getFieldsForRender(configDoc);
    const customDefsOnly = getCustomFieldDefs(fieldDefs);

    const closed = await getSignupAvailability(event);
    if (!closed.open) {
      return renderRegistrationForm(res, 403, {
        event,
        configDoc,
        childRows: childRowsFromOld(req.body),
        oldBody: req.body,
      });
    }

    const parentFirstName = (req.body.parentFirstName || '').trim();
    const parentLastName = (req.body.parentLastName || '').trim();
    const phone = (req.body.phone || '').trim();
    const childrenRaw = parseChildrenFromBody(req.body);
    const children = normalizeChildren(childrenRaw);
    const customFields = parseCustomFieldsFromBody(req.body, customDefsOnly);

    const errors = validateSubmission(
      fieldDefs,
      parentFirstName,
      parentLastName,
      phone,
      children,
      customFields
    );

    if (errors.length) {
      return renderRegistrationForm(res, 400, {
        event,
        configDoc,
        formErrors: errors,
        oldBody: req.body,
        childRows: childRowsFromOld(req.body),
      });
    }

    const closedAgain = await getSignupAvailability(event);
    if (!closedAgain.open) {
      return renderRegistrationForm(res, 403, {
        event,
        configDoc,
        childRows: childRowsFromOld(req.body),
        oldBody: req.body,
      });
    }

    const registration = await Registration.create({
      eventId: event._id,
      parentFirstName,
      parentLastName,
      phone,
      children,
      customFields,
    });

    let ticketSent = false;
    if (event.ticketsEnabled) {
      try {
        const eventDoc = await Event.findById(event._id);
        await ensureEventCheckInToken(eventDoc);
        await assignTicketToken(registration);

        const eventForMessage = eventDoc.toObject ? eventDoc.toObject() : eventDoc;
        const ticketUrl = buildTicketUrl(req, registration.ticketToken);
        const result = await sendTicket({
          event: eventForMessage,
          registration,
          ticketUrl,
          qrImageUrl: `${ticketUrl}/qr.png`,
        });

        if (result.sent) {
          registration.ticketWhatsAppSentAt = new Date();
          registration.ticketWhatsAppError = '';
          ticketSent = true;
        } else if (result.error) {
          registration.ticketWhatsAppError = result.error;
        }
        await registration.save();
      } catch (ticketErr) {
        console.error('ticket send error', ticketErr);
        registration.ticketWhatsAppError = ticketErr.message || 'Ticket send failed';
        await registration.save().catch(() => {});
      }
    }

    const ticketParam = ticketSent ? '&ticketSent=1' : '';
    return res.redirect(`/success?event=${encodeURIComponent(event.name)}&eid=${event._id}${ticketParam}`);
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { title: 'שגיאה', message: 'לא ניתן לשמור את ההרשמה' });
  }
});

router.get('/success', async (req, res) => {
  const eventName = req.query.event || '';
  const eid = req.query.eid;
  const defaults = {
    colors: { primary: '#0d6efd', background: '#f8f9fa', text: '#212529', button: '#0d6efd' },
    backgroundImage: '',
    logoUrl: '',
  };
  try {
    let config = { ...defaults };
    if (eid && mongoose.Types.ObjectId.isValid(eid)) {
      const cfgDoc = await FormConfig.findOne({ eventId: eid }).lean();
      if (cfgDoc) config = await resolveConfigUrls({ ...cfgDoc, fields: getFieldsForRender(cfgDoc) });
    }
    const c = config.colors || {};
    const rgb = hexToRgb(c.background || '#f8f9fa');
    const overlayRgba = `rgba(${rgb.r},${rgb.g},${rgb.b},0.82)`;
    res.render('success', {
      title: 'ההרשמה התקבלה',
      eventName,
      config,
      overlayRgba,
      ticketSent: req.query.ticketSent === '1',
    });
  } catch (err) {
    console.error(err);
    res.render('success', {
      title: 'ההרשמה התקבלה',
      eventName,
      config: defaults,
      overlayRgba: 'rgba(248,249,250,0.82)',
      ticketSent: req.query.ticketSent === '1',
    });
  }
});

module.exports = router;
