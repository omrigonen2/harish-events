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

function buildGateUrl(req, checkInToken) {
  return `${publicBaseUrl(req)}/gate/${encodeURIComponent(checkInToken)}`;
}

async function buildTicketQrPngBuffer(ticketUrl) {
  try {
    // Prefer local generation when the qrcode package is available.
    // Fallback keeps ticketing usable if local dependency installation fails during development.
    const QRCode = require('qrcode');
    return QRCode.toBuffer(ticketUrl, {
      type: 'png',
      width: 720,
      margin: 2,
      errorCorrectionLevel: 'M',
    });
  } catch (err) {
    if (err && err.code !== 'MODULE_NOT_FOUND') throw err;
    const qrApi = `https://quickchart.io/qr?size=720&margin=2&text=${encodeURIComponent(ticketUrl)}`;
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

async function redeemTicket(checkInToken, scannedValue) {
  const event = await Event.findOne({ checkInToken, ticketsEnabled: true }).lean();
  if (!event) {
    return { ok: false, status: 'invalid_gate', message: 'קישור הסריקה אינו תקין או שהכרטיסים כבויים.' };
  }

  const ticketToken = extractTicketToken(scannedValue);
  const registration = await Registration.findOne({ eventId: event._id, ticketToken });
  if (!registration) {
    return { ok: false, status: 'not_found', message: 'הכרטיס לא נמצא לאירוע זה.' };
  }

  const holderName = `${registration.parentFirstName || ''} ${registration.parentLastName || ''}`.trim();
  const holderSummary = {
    name: holderName || 'ללא שם',
    phone: registration.phone || '',
    children: Array.isArray(registration.children) ? registration.children.length : 0,
  };

  if (registration.ticketCheckedInAt) {
    return {
      ok: true,
      status: 'already_checked_in',
      message: 'הכרטיס כבר אושר בעבר.',
      checkedInAt: registration.ticketCheckedInAt,
      holderSummary,
    };
  }

  registration.ticketCheckedInAt = new Date();
  await registration.save();
  return {
    ok: true,
    status: 'checked_in',
    message: 'הכרטיס אושר בהצלחה.',
    checkedInAt: registration.ticketCheckedInAt,
    holderSummary,
  };
}

module.exports = {
  assignTicketToken,
  buildGateUrl,
  buildTicketQrPngBuffer,
  buildTicketUrl,
  ensureEventCheckInToken,
  extractTicketToken,
  generateToken,
  publicBaseUrl,
  redeemTicket,
};
