const crypto = require('crypto');
const Event = require('../models/Event');
const Registration = require('../models/Registration');

function generateToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function publicBaseUrl(req) {
  const configured = (process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
  if (configured) return configured;
  return `${req.protocol}://${req.get('host')}`;
}

function buildTicketUrl(req, ticketToken) {
  return `${publicBaseUrl(req)}/ticket/${encodeURIComponent(ticketToken)}`;
}

function buildTicketUrlFromBase(baseUrl, ticketToken) {
  if (!ticketToken) return '';
  return `${String(baseUrl || '').replace(/\/+$/, '')}/ticket/${encodeURIComponent(ticketToken)}`;
}

function buildGateUrl(req, checkInToken) {
  return `${publicBaseUrl(req)}/gate/${encodeURIComponent(checkInToken)}`;
}

async function buildTicketQrPngBuffer(ticketToken) {
  const qrPayload = String(ticketToken || '').trim();
  if (!qrPayload) throw new Error('Ticket token is required for QR generation');

  try {
    // Prefer local generation when the qrcode package is available.
    // Fallback keeps ticketing usable if local dependency installation fails during development.
    const QRCode = require('qrcode');
    return QRCode.toBuffer(qrPayload, {
      type: 'png',
      width: 720,
      margin: 2,
      errorCorrectionLevel: 'M',
    });
  } catch (err) {
    if (err && err.code !== 'MODULE_NOT_FOUND') throw err;
    const qrApi = `https://quickchart.io/qr?size=720&margin=2&text=${encodeURIComponent(qrPayload)}`;
    const response = await fetch(qrApi);
    if (!response.ok) throw new Error(`QR generation failed with status ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }
}

function extractTicketToken(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] === 'ticket' && parts[1]) return decodeURIComponent(parts[1]);
  } catch {
    // Not a URL; treat it as the raw ticket token.
  }
  const match = raw.match(/\/ticket\/([^/?#]+)/);
  return match ? decodeURIComponent(match[1]) : raw;
}

async function ensureEventCheckInToken(event) {
  if (!event.ticketsEnabled) return event;
  if (event.checkInToken) return event;
  event.checkInToken = generateToken(32);
  await event.save();
  return event;
}

async function assignTicketToken(registration) {
  if (registration.ticketToken) return registration;
  for (let i = 0; i < 5; i += 1) {
    registration.ticketToken = generateToken(24);
    try {
      await registration.save();
      return registration;
    } catch (err) {
      if (err && err.code === 11000) continue;
      throw err;
    }
  }
  throw new Error('Could not generate a unique ticket token');
}

function registrationCounts(registration) {
  const children = Array.isArray(registration.children) ? registration.children.length : 0;
  return { adults: 1, children };
}

function checkedInCounts(registration) {
  const fallback = registrationCounts(registration);
  return {
    adults: registration.ticketCheckInAdults == null ? fallback.adults : registration.ticketCheckInAdults,
    children: registration.ticketCheckInChildren == null ? fallback.children : registration.ticketCheckInChildren,
  };
}

function holderSummary(registration) {
  const holderName = `${registration.parentFirstName || ''} ${registration.parentLastName || ''}`.trim();
  const counts = checkedInCounts(registration);
  return {
    name: holderName || 'ללא שם',
    phone: registration.phone || '',
    adults: counts.adults,
    children: counts.children,
  };
}

function normalizeCountOverride(value, fallback, { min, max }) {
  if (value === undefined || value === null || value === '') return { ok: true, value: fallback };
  const count = Number(value);
  if (!Number.isInteger(count) || count < min || count > max) {
    return { ok: false };
  }
  return { ok: true, value: count };
}

async function loadTicket(checkInToken, scannedValue, { leanRegistration = false } = {}) {
  const event = await Event.findOne({ checkInToken, ticketsEnabled: true }).lean();
  if (!event) {
    return { ok: false, status: 'invalid_gate', message: 'קישור הסריקה אינו תקין או שהכרטיסים כבויים.' };
  }

  const ticketToken = extractTicketToken(scannedValue);
  if (!ticketToken) {
    return { ok: false, status: 'missing_ticket', message: 'קוד הכרטיס חסר.' };
  }

  let query = Registration.findOne({ eventId: event._id, ticketToken });
  if (leanRegistration) query = query.lean();
  const registration = await query;
  if (!registration) {
    return { ok: false, status: 'not_found', message: 'הכרטיס לא נמצא לאירוע זה.' };
  }

  return { ok: true, event, registration, ticketToken };
}

async function previewTicket(checkInToken, scannedValue) {
  const loaded = await loadTicket(checkInToken, scannedValue, { leanRegistration: true });
  if (!loaded.ok) return loaded;

  const { event, registration } = loaded;
  const alreadyCheckedIn = Boolean(registration.ticketCheckedInAt);
  return {
    ok: true,
    status: alreadyCheckedIn ? 'already_checked_in' : 'preview',
    message: alreadyCheckedIn ? 'הכרטיס כבר אושר בעבר.' : 'הכרטיס נמצא. יש לאשר כדי לצרוב אותו.',
    checkedInAt: registration.ticketCheckedInAt || null,
    alreadyCheckedIn,
    allowCountEdit: Boolean(event.ticketsGateAllowCountEdit),
    counts: checkedInCounts(registration),
    holderSummary: holderSummary(registration),
  };
}

async function redeemTicket(checkInToken, scannedValue, overrides = {}) {
  const loaded = await loadTicket(checkInToken, scannedValue);
  if (!loaded.ok) return loaded;
  const { event, registration } = loaded;

  if (registration.ticketCheckedInAt) {
    return {
      ok: true,
      status: 'already_checked_in',
      message: 'הכרטיס כבר אושר בעבר.',
      checkedInAt: registration.ticketCheckedInAt,
      alreadyCheckedIn: true,
      allowCountEdit: Boolean(event.ticketsGateAllowCountEdit),
      counts: checkedInCounts(registration),
      holderSummary: holderSummary(registration),
    };
  }

  const defaults = registrationCounts(registration);
  let counts = defaults;

  if (event.ticketsGateAllowCountEdit) {
    const adults = normalizeCountOverride(overrides.adults, defaults.adults, { min: 1, max: 50 });
    const children = normalizeCountOverride(overrides.children, defaults.children, { min: 0, max: 50 });
    if (!adults.ok || !children.ok) {
      return {
        ok: false,
        status: 'invalid_counts',
        message: 'כמות המשתתפים אינה תקינה.',
        allowCountEdit: true,
        counts: defaults,
        holderSummary: holderSummary(registration),
      };
    }
    counts = { adults: adults.value, children: children.value };
  }

  registration.ticketCheckedInAt = new Date();
  registration.ticketCheckInAdults = counts.adults;
  registration.ticketCheckInChildren = counts.children;
  await registration.save();
  return {
    ok: true,
    status: 'checked_in',
    message: 'הכרטיס אושר בהצלחה.',
    checkedInAt: registration.ticketCheckedInAt,
    alreadyCheckedIn: false,
    allowCountEdit: Boolean(event.ticketsGateAllowCountEdit),
    counts,
    holderSummary: holderSummary(registration),
  };
}

module.exports = {
  assignTicketToken,
  buildGateUrl,
  buildTicketQrPngBuffer,
  buildTicketUrl,
  buildTicketUrlFromBase,
  ensureEventCheckInToken,
  extractTicketToken,
  generateToken,
  previewTicket,
  publicBaseUrl,
  redeemTicket,
};
