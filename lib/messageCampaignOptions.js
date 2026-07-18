const DEFAULT_MESSAGE_TO_TICKET_DELAY_SECONDS = 6;
const DEFAULT_RECIPIENT_DELAY_SECONDS = 6;
const MIN_DELAY_SECONDS = 1;
const MAX_DELAY_SECONDS = 3600;

function parseDelaySeconds(raw, fallback = DEFAULT_RECIPIENT_DELAY_SECONDS) {
  if (raw === undefined || raw === null || raw === '') {
    return fallback;
  }
  const value = Number(String(raw).trim());
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    return null;
  }
  if (value < MIN_DELAY_SECONDS || value > MAX_DELAY_SECONDS) {
    return null;
  }
  return value;
}

function normalizeAudienceMode(raw) {
  const value = String(raw || 'all').trim().toLowerCase();
  return value === 'selected' ? 'selected' : 'all';
}

function parseRegistrationIds(raw) {
  if (!raw) return [];
  const values = Array.isArray(raw) ? raw : [raw];
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
}

function validateCampaignOptions({
  event,
  audienceMode,
  selectedRegistrationIds = [],
  attachTicket = false,
  messageToTicketDelaySeconds,
  recipientDelaySeconds,
}) {
  const mode = normalizeAudienceMode(audienceMode);
  const ids = parseRegistrationIds(selectedRegistrationIds);

  if (mode === 'selected' && !ids.length) {
    throw new Error('יש לבחור לפחות נרשם אחד לשליחה');
  }

  if (attachTicket && !event.ticketsEnabled) {
    throw new Error('לא ניתן לצרף כרטיס כשמערכת הכרטיסים כבויה לאירוע זה');
  }

  const parsedMessageToTicketDelay = parseDelaySeconds(
    messageToTicketDelaySeconds,
    DEFAULT_MESSAGE_TO_TICKET_DELAY_SECONDS
  );
  const parsedRecipientDelay = parseDelaySeconds(recipientDelaySeconds, DEFAULT_RECIPIENT_DELAY_SECONDS);

  if (parsedMessageToTicketDelay == null) {
    throw new Error(`השהייה בין הודעה לכרטיס חייבת להיות בין ${MIN_DELAY_SECONDS} ל-${MAX_DELAY_SECONDS} שניות`);
  }
  if (parsedRecipientDelay == null) {
    throw new Error(`השהייה בין נמענים חייבת להיות בין ${MIN_DELAY_SECONDS} ל-${MAX_DELAY_SECONDS} שניות`);
  }

  return {
    audienceMode: mode,
    selectedRegistrationIds: ids,
    attachTicket: Boolean(attachTicket),
    messageToTicketDelaySeconds: parsedMessageToTicketDelay,
    recipientDelaySeconds: parsedRecipientDelay,
  };
}

function campaignDelaySeconds(campaign) {
  return parseDelaySeconds(campaign && campaign.recipientDelaySeconds, DEFAULT_RECIPIENT_DELAY_SECONDS)
    || DEFAULT_RECIPIENT_DELAY_SECONDS;
}

function messageToTicketDelaySeconds(campaign) {
  return parseDelaySeconds(
    campaign && campaign.messageToTicketDelaySeconds,
    DEFAULT_MESSAGE_TO_TICKET_DELAY_SECONDS
  ) || DEFAULT_MESSAGE_TO_TICKET_DELAY_SECONDS;
}

function recipientAttachTicket(campaign) {
  return Boolean(campaign && campaign.attachTicket);
}

function recipientDeliveryStep(recipient) {
  return recipient && recipient.deliveryStep === 'ticket' ? 'ticket' : 'message';
}

module.exports = {
  DEFAULT_MESSAGE_TO_TICKET_DELAY_SECONDS,
  DEFAULT_RECIPIENT_DELAY_SECONDS,
  MAX_DELAY_SECONDS,
  MIN_DELAY_SECONDS,
  campaignDelaySeconds,
  messageToTicketDelaySeconds,
  normalizeAudienceMode,
  parseDelaySeconds,
  parseRegistrationIds,
  recipientAttachTicket,
  recipientDeliveryStep,
  validateCampaignOptions,
};
