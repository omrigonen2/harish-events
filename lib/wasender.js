const { formatDateTimeIsrael } = require('./datetimeLocal');
const crypto = require('crypto');
const WasenderSettings = require('../models/WasenderSettings');

const DEFAULT_BASE_URL = 'https://www.wasenderapi.com';

function encryptionKey() {
  return crypto.createHash('sha256').update(process.env.SESSION_SECRET || 'dev-secret-change-me').digest();
}

function encryptSecret(plain) {
  const value = String(plain || '').trim();
  if (!value) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64url')}.${tag.toString('base64url')}.${encrypted.toString('base64url')}`;
}

function decryptSecret(encrypted) {
  const value = String(encrypted || '').trim();
  if (!value) return '';
  const [ivRaw, tagRaw, encryptedRaw] = value.split('.');
  if (!ivRaw || !tagRaw || !encryptedRaw) return '';
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivRaw, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedRaw, 'base64url')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}

function previewSecret(secret) {
  const value = String(secret || '').trim();
  if (!value) return '';
  if (value.length <= 8) return '********';
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function normalizeBaseUrl(raw) {
  const value = String(raw || DEFAULT_BASE_URL).trim();
  const withProtocol = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  return withProtocol.replace(/\/+$/, '');
}

async function getSettings() {
  let settings = await WasenderSettings.findOne({ singletonKey: 'global' });
  if (!settings) {
    settings = await WasenderSettings.create({ singletonKey: 'global', baseUrl: DEFAULT_BASE_URL });
  }
  return settings;
}

async function saveSettings({ apiKey, baseUrl }) {
  const settings = await getSettings();
  settings.baseUrl = normalizeBaseUrl(baseUrl || settings.baseUrl);
  if (apiKey && String(apiKey).trim()) {
    settings.apiKeyEncrypted = encryptSecret(apiKey);
    settings.apiKeyPreview = previewSecret(apiKey);
  }
  await settings.save();
  return settings;
}

async function resolveCredentials() {
  const settings = await getSettings();
  const dbApiKey = decryptSecret(settings.apiKeyEncrypted);
  return {
    apiKey: dbApiKey || (process.env.WASENDER_API_KEY || '').trim(),
    baseUrl: normalizeBaseUrl(settings.baseUrl || process.env.WASENDER_BASE_URL || DEFAULT_BASE_URL),
    settings,
  };
}

function normalizePhone(rawPhone) {
  const raw = String(rawPhone || '').trim();
  if (!raw) return '';
  if (raw.startsWith('+')) return `+${raw.replace(/[^\d]/g, '')}`;

  const digits = raw.replace(/[^\d]/g, '');
  if (!digits) return '';
  if (digits.startsWith('972')) return `+${digits}`;
  if (digits.startsWith('0')) return `+972${digits.slice(1)}`;
  return `+${digits}`;
}

function buildTicketMessage({ event, registration, ticketUrl }) {
  const holder = `${registration.parentFirstName || ''} ${registration.parentLastName || ''}`.trim();
  const lines = [
    `כרטיס לאירוע: ${event.name}`,
    holder ? `שם: ${holder}` : '',
    event.date ? `מועד: ${formatDateTimeIsrael(event.date)}` : '',
    `קישור לכרטיס: ${ticketUrl}`,
    '',
    'יש להציג את קוד ה-QR בכניסה לאירוע.',
  ].filter((line) => line !== '');
  return lines.join('\n');
}

async function sendMessage({ to, text, imageUrl }) {
  const { apiKey, baseUrl } = await resolveCredentials();
  if (!apiKey) {
    return { sent: false, skipped: true, error: 'WASENDER_API_KEY is not configured' };
  }

  const body = { to, text };
  if (imageUrl) body.imageUrl = imageUrl;

  const response = await fetch(`${baseUrl}/api/send-message`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.success === false) {
    const message = payload.message || payload.error || `Wasender request failed with status ${response.status}`;
    throw new Error(message);
  }

  return { sent: true, response: payload };
}

async function sendImageMessage({ to, text, imageUrl }) {
  return sendMessage({ to, text, imageUrl });
}

async function checkConnection() {
  const { apiKey, baseUrl, settings } = await resolveCredentials();
  if (!apiKey) {
    settings.lastStatus = '';
    settings.lastCheckedAt = new Date();
    settings.lastError = 'API key is not configured';
    await settings.save();
    return { ok: false, status: '', error: settings.lastError, settings };
  }

  try {
    const response = await fetch(`${baseUrl}/api/status`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const payload = await response.json().catch(() => ({}));
    const status = payload.status || '';
    if (!response.ok) {
      throw new Error(payload.message || payload.error || `Wasender status failed with ${response.status}`);
    }

    settings.lastStatus = status;
    settings.lastCheckedAt = new Date();
    settings.lastError = '';
    await settings.save();
    return { ok: status === 'connected', status, payload, settings };
  } catch (err) {
    settings.lastStatus = '';
    settings.lastCheckedAt = new Date();
    settings.lastError = err.message || 'Connection check failed';
    await settings.save();
    return { ok: false, status: '', error: settings.lastError, settings };
  }
}

async function sendTicket({ event, registration, ticketUrl, qrImageUrl }) {
  const to = normalizePhone(registration.phone);
  if (!to) {
    return { sent: false, skipped: true, error: 'Registration phone is missing' };
  }

  return sendImageMessage({
    to,
    text: buildTicketMessage({ event, registration, ticketUrl }),
    imageUrl: qrImageUrl,
  });
}

module.exports = {
  buildTicketMessage,
  checkConnection,
  decryptSecret,
  encryptSecret,
  getSettings,
  normalizePhone,
  saveSettings,
  sendImageMessage,
  sendMessage,
  sendTicket,
};
