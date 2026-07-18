const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_MESSAGE_TO_TICKET_DELAY_SECONDS,
  DEFAULT_RECIPIENT_DELAY_SECONDS,
  campaignDelaySeconds,
  messageToTicketDelaySeconds,
  normalizeAudienceMode,
  parseDelaySeconds,
  parseRegistrationIds,
  recipientAttachTicket,
  recipientDeliveryStep,
  validateCampaignOptions,
} = require('../lib/messageCampaignOptions');

test('parseDelaySeconds accepts integers within bounds and rejects invalid values', () => {
  assert.equal(parseDelaySeconds('6'), 6);
  assert.equal(parseDelaySeconds('', DEFAULT_RECIPIENT_DELAY_SECONDS), DEFAULT_RECIPIENT_DELAY_SECONDS);
  assert.equal(parseDelaySeconds(undefined, 10), 10);
  assert.equal(parseDelaySeconds('0'), null);
  assert.equal(parseDelaySeconds('3601'), null);
  assert.equal(parseDelaySeconds('5.5'), null);
  assert.equal(parseDelaySeconds('abc'), null);
});

test('validateCampaignOptions enforces selected audience and ticket eligibility', () => {
  const eventWithTickets = { ticketsEnabled: true };
  const eventWithoutTickets = { ticketsEnabled: false };

  assert.throws(
    () => validateCampaignOptions({ event: eventWithTickets, audienceMode: 'selected', selectedRegistrationIds: [] }),
    /לפחות נרשם/
  );

  assert.throws(
    () => validateCampaignOptions({ event: eventWithoutTickets, audienceMode: 'all', attachTicket: true }),
    /כרטיסים כבויה/
  );

  const options = validateCampaignOptions({
    event: eventWithTickets,
    audienceMode: 'selected',
    selectedRegistrationIds: ['abc', 'abc', 'def'],
    attachTicket: true,
    messageToTicketDelaySeconds: '8',
    recipientDelaySeconds: '12',
  });

  assert.equal(options.audienceMode, 'selected');
  assert.deepEqual(options.selectedRegistrationIds, ['abc', 'def']);
  assert.equal(options.attachTicket, true);
  assert.equal(options.messageToTicketDelaySeconds, 8);
  assert.equal(options.recipientDelaySeconds, 12);
});

test('campaign delay helpers fall back for legacy campaigns', () => {
  assert.equal(recipientDeliveryStep({ deliveryStep: 'ticket' }), 'ticket');
  assert.equal(recipientDeliveryStep({}), 'message');
  assert.equal(recipientAttachTicket({ attachTicket: true }), true);
  assert.equal(recipientAttachTicket({}), false);
  assert.equal(campaignDelaySeconds({}), DEFAULT_RECIPIENT_DELAY_SECONDS);
  assert.equal(messageToTicketDelaySeconds({}), DEFAULT_MESSAGE_TO_TICKET_DELAY_SECONDS);
});

test('audience and registration id helpers normalize input', () => {
  assert.equal(normalizeAudienceMode('SELECTED'), 'selected');
  assert.equal(normalizeAudienceMode('all'), 'all');
  assert.deepEqual(parseRegistrationIds([' a ', 'b', 'a']), ['a', 'b']);
});
