const MessageCampaign = require('../models/MessageCampaign');
const MessageRecipient = require('../models/MessageRecipient');
const Registration = require('../models/Registration');
const { formatDateTimeIsrael } = require('./datetimeLocal');
const {
  campaignDelaySeconds,
  messageToTicketDelaySeconds,
  recipientAttachTicket,
  recipientDeliveryStep,
  validateCampaignOptions,
} = require('./messageCampaignOptions');
const { getPresignedUrl } = require('./s3');
const { assignTicketToken, buildTicketUrlFromBase } = require('./tickets');
const { normalizePhone, sendMessage, sendTicket } = require('./wasender');

const IDLE_INTERVAL_MS = 2000;
const DEFAULT_LOG_LIMIT = 50;

let timer = null;
let processing = false;
let started = false;

function schedule(ms) {
  if (!started) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(processNext, Math.max(0, ms));
}

function campaignIsSendable(campaign) {
  return campaign && campaign.status === 'running';
}

function replacePlaceholders(template, values) {
  return String(template || '').replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, key) => {
    return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : match;
  });
}

async function buildPlaceholderValues({ event, registration, recipient, messageText, publicBaseUrl }) {
  let ticketUrl = '';
  if (registration && event.ticketsEnabled && messageText.includes('{{ticketUrl')) {
    await assignTicketToken(registration);
    const baseUrl = (publicBaseUrl || process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || '').trim();
    ticketUrl = baseUrl ? buildTicketUrlFromBase(baseUrl, registration.ticketToken) : '';
  }

  return {
    parentFirstName: (registration && registration.parentFirstName) || (recipient && recipient.parentFirstName) || 'שם פרטי',
    parentLastName: (registration && registration.parentLastName) || (recipient && recipient.parentLastName) || 'שם משפחה',
    eventName: event.name || '',
    eventDate: event.date ? formatDateTimeIsrael(event.date) : '',
    ticketUrl,
  };
}

async function renderMessage({ event, registration, recipient, messageText, publicBaseUrl }) {
  const values = await buildPlaceholderValues({ event, registration, recipient, messageText, publicBaseUrl });
  return replacePlaceholders(messageText, values);
}

async function renderRecipientMessage(campaign, recipient) {
  const event = campaign.eventId;
  const registration = await Registration.findOne({
    _id: recipient.registrationId,
    eventId: event._id,
  });

  return renderMessage({
    event,
    registration,
    recipient,
    messageText: campaign.messageText,
    publicBaseUrl: campaign.publicBaseUrl,
  });
}

async function loadRegistrationForRecipient(campaign, recipient) {
  return Registration.findOne({
    _id: recipient.registrationId,
    eventId: campaign.eventId._id,
  });
}

function resolvePublicBaseUrl(campaign) {
  return (
    (campaign.publicBaseUrl || process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || '').trim().replace(/\/+$/, '')
  );
}

async function sendRecipientTicket(campaign, recipient, registration) {
  await assignTicketToken(registration);
  const baseUrl = resolvePublicBaseUrl(campaign);
  if (!baseUrl) {
    throw new Error('PUBLIC_BASE_URL is not configured for ticket delivery');
  }

  const ticketUrl = buildTicketUrlFromBase(baseUrl, registration.ticketToken);
  const qrImageUrl = `${ticketUrl}/qr.png`;
  const result = await sendTicket({
    event: campaign.eventId,
    registration,
    ticketUrl,
    qrImageUrl,
  });

  if (!result.sent) {
    throw new Error(result.error || 'Wasender did not send the ticket');
  }

  return result;
}

async function markCampaignCompleted(campaign) {
  const failedCount = await MessageRecipient.countDocuments({ campaignId: campaign._id, status: 'failed' });
  const sentCount = await MessageRecipient.countDocuments({ campaignId: campaign._id, status: 'sent' });
  await MessageCampaign.updateOne(
    { _id: campaign._id },
    {
      $set: {
        status: 'completed',
        sentCount,
        failedCount,
        completedAt: new Date(),
      },
    }
  );
}

async function promoteDueCampaigns() {
  const now = new Date();
  await MessageCampaign.updateMany(
    { status: 'queued', scheduledAt: { $ne: null, $lte: now } },
    { $set: { status: 'running', startedAt: now, completedAt: null } }
  );
}

async function findEarliestPendingActionAt(campaignId) {
  const recipient = await MessageRecipient.findOne({
    campaignId,
    status: 'pending',
    nextActionAt: { $ne: null },
  })
    .sort({ nextActionAt: 1 })
    .select('nextActionAt')
    .lean();

  return recipient && recipient.nextActionAt ? new Date(recipient.nextActionAt) : null;
}

async function claimDueRecipient(campaignId, now = new Date()) {
  return MessageRecipient.findOneAndUpdate(
    {
      campaignId,
      status: 'pending',
      $or: [{ nextActionAt: null }, { nextActionAt: { $lte: now } }],
    },
    { $set: { status: 'sending', error: '' }, $inc: { attempts: 1 } },
    { sort: { createdAt: 1 }, new: true }
  );
}

async function failRecipient(campaign, recipient, error, stepLabel) {
  const message = stepLabel ? `${stepLabel}: ${error}` : error;
  await MessageRecipient.updateOne(
    { _id: recipient._id },
    { $set: { status: 'failed', error: message } }
  );
  await MessageCampaign.updateOne(
    { _id: campaign._id },
    { $inc: { failedCount: 1 }, $set: { lastError: message } }
  );
  return campaignDelaySeconds(campaign) * 1000;
}

async function processRecipientAction(campaign, recipient) {
  const step = recipientDeliveryStep(recipient);
  const attachTicket = recipientAttachTicket(campaign);

  if (step === 'message') {
    const text = await renderRecipientMessage(campaign, recipient);
    const imageUrl = campaign.imageKey ? await getPresignedUrl(campaign.imageKey, 3600) : '';
    const result = await sendMessage({
      to: recipient.phoneNormalized,
      text,
      imageUrl,
    });

    if (!result.sent) {
      throw new Error(result.error || 'Wasender did not send the message');
    }

    const now = new Date();
    if (attachTicket) {
      const delaySeconds = messageToTicketDelaySeconds(campaign);
      await MessageRecipient.updateOne(
        { _id: recipient._id },
        {
          $set: {
            status: 'pending',
            deliveryStep: 'ticket',
            messageSentAt: now,
            nextActionAt: new Date(now.getTime() + delaySeconds * 1000),
            error: '',
          },
        }
      );
      return delaySeconds * 1000;
    }

    await MessageRecipient.updateOne(
      { _id: recipient._id },
      { $set: { status: 'sent', sentAt: now, messageSentAt: now, error: '' } }
    );
    await MessageCampaign.updateOne({ _id: campaign._id }, { $inc: { sentCount: 1 }, $set: { lastError: '' } });
    return campaignDelaySeconds(campaign) * 1000;
  }

  const registration = await loadRegistrationForRecipient(campaign, recipient);
  if (!registration) {
    throw new Error('Registration was not found for this recipient');
  }

  await sendRecipientTicket(campaign, recipient, registration);
  const now = new Date();
  await MessageRecipient.updateOne(
    { _id: recipient._id },
    {
      $set: {
        status: 'sent',
        sentAt: now,
        ticketSentAt: now,
        error: '',
      },
    }
  );
  await MessageCampaign.updateOne({ _id: campaign._id }, { $inc: { sentCount: 1 }, $set: { lastError: '' } });
  return campaignDelaySeconds(campaign) * 1000;
}

async function processNext() {
  if (processing) return schedule(IDLE_INTERVAL_MS);
  processing = true;

  try {
    await promoteDueCampaigns();

    const campaign = await MessageCampaign.findOne({ status: 'running' })
      .sort({ createdAt: 1 })
      .populate('eventId');

    if (!campaign || !campaign.eventId) {
      processing = false;
      return schedule(IDLE_INTERVAL_MS);
    }

    const now = new Date();
    const recipient = await claimDueRecipient(campaign._id, now);

    if (!recipient) {
      const pendingCount = await MessageRecipient.countDocuments({
        campaignId: campaign._id,
        status: { $in: ['pending', 'sending'] },
      });

      if (!pendingCount) {
        await markCampaignCompleted(campaign);
        processing = false;
        return schedule(IDLE_INTERVAL_MS);
      }

      const earliest = await findEarliestPendingActionAt(campaign._id);
      processing = false;
      if (earliest && earliest.getTime() > now.getTime()) {
        return schedule(earliest.getTime() - now.getTime());
      }
      return schedule(IDLE_INTERVAL_MS);
    }

    const freshCampaign = await MessageCampaign.findById(campaign._id).populate('eventId');
    if (!campaignIsSendable(freshCampaign)) {
      await MessageRecipient.updateOne({ _id: recipient._id, status: 'sending' }, { $set: { status: 'pending' } });
      processing = false;
      return schedule(IDLE_INTERVAL_MS);
    }

    let nextDelayMs = campaignDelaySeconds(freshCampaign) * 1000;
    const stepLabel = recipientDeliveryStep(recipient) === 'ticket' ? 'Ticket send failed' : 'Message send failed';

    try {
      nextDelayMs = await processRecipientAction(freshCampaign, recipient);
    } catch (err) {
      nextDelayMs = await failRecipient(freshCampaign, recipient, err.message || 'Message send failed', stepLabel);
    }

    processing = false;
    return schedule(nextDelayMs);
  } catch (err) {
    console.error('message queue error', err);
    processing = false;
    return schedule(IDLE_INTERVAL_MS);
  }
}

async function start() {
  if (started) return;
  started = true;
  await MessageRecipient.updateMany(
    { status: 'sending' },
    { $set: { status: 'pending', error: 'Recovered after server restart before send completed' } }
  );
  schedule(0);
}

async function buildRecipientSnapshot(event, options) {
  let registrations;
  if (options.audienceMode === 'selected') {
    registrations = await Registration.find({
      eventId: event._id,
      _id: { $in: options.selectedRegistrationIds },
    }).sort({ createdAt: 1 });

    const foundIds = new Set(registrations.map((registration) => String(registration._id)));
    const missingIds = options.selectedRegistrationIds.filter((id) => !foundIds.has(id));
    if (missingIds.length) {
      throw new Error('חלק מהנרשמים שנבחרו לא שייכים לאירוע זה');
    }
  } else {
    registrations = await Registration.find({ eventId: event._id }).sort({ createdAt: 1 });
  }

  const seen = new Set();
  const recipients = [];
  let duplicatesSkipped = 0;
  let invalidPhoneCount = 0;

  for (const registration of registrations) {
    const phoneNormalized = normalizePhone(registration.phone);
    if (!phoneNormalized || phoneNormalized === '+') {
      invalidPhoneCount += 1;
      continue;
    }
    if (seen.has(phoneNormalized)) {
      duplicatesSkipped += 1;
      continue;
    }
    seen.add(phoneNormalized);
    recipients.push({
      registrationId: registration._id,
      parentFirstName: registration.parentFirstName || '',
      parentLastName: registration.parentLastName || '',
      phoneOriginal: registration.phone || '',
      phoneNormalized,
      deliveryStep: 'message',
      nextActionAt: null,
    });
  }

  return { recipients, duplicatesSkipped, invalidPhoneCount };
}

async function createCampaign({
  event,
  accountId,
  userId,
  messageText,
  imageKey = '',
  name = '',
  publicBaseUrl = '',
  scheduledAt = null,
  audienceMode = 'all',
  selectedRegistrationIds = [],
  attachTicket = false,
  messageToTicketDelaySeconds: messageToTicketDelayInput,
  recipientDelaySeconds: recipientDelayInput,
}) {
  const text = String(messageText || '').trim();
  if (!text) throw new Error('Message text is required');

  const options = validateCampaignOptions({
    event,
    audienceMode,
    selectedRegistrationIds,
    attachTicket,
    messageToTicketDelaySeconds: messageToTicketDelayInput,
    recipientDelaySeconds: recipientDelayInput,
  });

  const scheduleDate = scheduledAt instanceof Date && !Number.isNaN(scheduledAt.getTime()) ? scheduledAt : null;
  const isScheduled = scheduleDate && scheduleDate.getTime() > Date.now();
  const { recipients, duplicatesSkipped, invalidPhoneCount } = await buildRecipientSnapshot(event, options);

  if (options.audienceMode === 'selected' && !recipients.length) {
    throw new Error('לא נמצאו נמענים תקינים עם טלפון בבחירה');
  }

  const skippedNotes = [];
  if (duplicatesSkipped) skippedNotes.push(`${duplicatesSkipped} duplicate registrations skipped`);
  if (invalidPhoneCount) skippedNotes.push(`${invalidPhoneCount} registrations skipped because phone is missing`);

  const campaign = await MessageCampaign.create({
    accountId,
    eventId: event._id,
    name: name || `הודעה ל-${event.name}`,
    messageText: text,
    imageKey,
    publicBaseUrl,
    scheduledAt: scheduleDate,
    attachTicket: options.attachTicket,
    messageToTicketDelaySeconds: options.messageToTicketDelaySeconds,
    recipientDelaySeconds: options.recipientDelaySeconds,
    status: recipients.length ? (isScheduled ? 'queued' : 'running') : 'completed',
    totalRecipients: recipients.length,
    duplicatesSkipped,
    invalidPhoneCount,
    createdBy: userId || null,
    startedAt: recipients.length && !isScheduled ? new Date() : null,
    completedAt: recipients.length ? null : new Date(),
    lastError: skippedNotes.join('. '),
  });

  if (recipients.length) {
    await MessageRecipient.insertMany(recipients.map((recipient) => ({ ...recipient, campaignId: campaign._id })), {
      ordered: false,
    });
  }

  if (!isScheduled) schedule(0);
  return MessageCampaign.findById(campaign._id).lean();
}

async function sendTestMessage({
  event,
  registrationId,
  to,
  messageText,
  imageKey = '',
  publicBaseUrl = '',
  attachTicket = false,
}) {
  const phoneNormalized = normalizePhone(to);
  if (!phoneNormalized || phoneNormalized === '+') {
    throw new Error('Test phone is required');
  }

  const text = String(messageText || '').trim();
  if (!text) throw new Error('Message text is required');

  if (attachTicket && !event.ticketsEnabled) {
    throw new Error('לא ניתן לצרף כרטיס כשמערכת הכרטיסים כבויה לאירוע זה');
  }

  let registration = null;
  if (registrationId) {
    registration = await Registration.findOne({ _id: registrationId, eventId: event._id });
    if (!registration) throw new Error('Selected registration was not found for this event');
  }

  const renderedText = await renderMessage({
    event,
    registration,
    recipient: null,
    messageText: text,
    publicBaseUrl,
  });
  const imageUrl = imageKey ? await getPresignedUrl(imageKey, 3600) : '';
  const result = await sendMessage({ to: phoneNormalized, text: renderedText, imageUrl });
  if (!result.sent) {
    throw new Error(result.error || 'Wasender did not send the test message');
  }

  if (attachTicket) {
    if (!registration) {
      throw new Error('יש לבחור נרשם לדוגמה כדי לשלוח כרטיס בבדיקה');
    }

    const baseUrl = (publicBaseUrl || process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || '')
      .trim()
      .replace(/\/+$/, '');
    if (!baseUrl) {
      throw new Error('PUBLIC_BASE_URL is not configured for ticket delivery');
    }

    await assignTicketToken(registration);
    const ticketUrl = buildTicketUrlFromBase(baseUrl, registration.ticketToken);
    const ticketResult = await sendTicket({
      event,
      registration,
      ticketUrl,
      qrImageUrl: `${ticketUrl}/qr.png`,
    });
    if (!ticketResult.sent) {
      throw new Error(ticketResult.error || 'Wasender did not send the test ticket');
    }
  }

  return result;
}

async function pauseCampaign(campaignId) {
  return MessageCampaign.findOneAndUpdate(
    { _id: campaignId, status: 'running' },
    { $set: { status: 'paused' } },
    { new: true }
  ).lean();
}

async function resumeCampaign(campaignId) {
  const campaign = await MessageCampaign.findOneAndUpdate(
    { _id: campaignId, status: 'paused' },
    { $set: { status: 'running', startedAt: new Date(), completedAt: null } },
    { new: true }
  ).lean();
  if (campaign) schedule(0);
  return campaign;
}

async function cancelCampaign(campaignId) {
  return MessageCampaign.findOneAndUpdate(
    { _id: campaignId, status: { $in: ['queued', 'running', 'paused'] } },
    { $set: { status: 'cancelled', completedAt: new Date() } },
    { new: true }
  ).lean();
}

async function getCampaignStatus(campaignId, { logLimit = DEFAULT_LOG_LIMIT } = {}) {
  const campaign = await MessageCampaign.findById(campaignId).lean();
  if (!campaign) return null;

  const [counts, recipients] = await Promise.all([
    MessageRecipient.aggregate([
      { $match: { campaignId: campaign._id } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
    MessageRecipient.find({ campaignId: campaign._id })
      .sort({ updatedAt: -1, createdAt: -1 })
      .limit(logLimit)
      .lean(),
  ]);

  const byStatus = { pending: 0, sending: 0, sent: 0, failed: 0 };
  counts.forEach((row) => {
    byStatus[row._id] = row.count;
  });

  return { campaign, counts: byStatus, recipients };
}

module.exports = {
  cancelCampaign,
  createCampaign,
  getCampaignStatus,
  pauseCampaign,
  resumeCampaign,
  sendTestMessage,
  start,
};
