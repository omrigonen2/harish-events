const activeRegistrationFilter = { status: { $ne: 'cancelled' } };

function additionalParticipants(registration, event = {}) {
  if (Array.isArray(registration.participants)) return registration.participants;
  return (registration.children || []).map((person) => ({
    name: person.name,
    age: event.hasChildren === false ? null : person.age,
    category: event.hasChildren === false ? 'general' : 'child',
  }));
}

function participantCounts(registration, event = {}) {
  const people = additionalParticipants(registration, event);
  const children = people.filter((person) => person.category === 'child').length;
  return { adults: 1 + people.length - children, children, total: 1 + people.length, additional: people.length };
}

function totalsForRegistrations(registrations, event = {}) {
  const totals = { registrations: 0, participants: 0, additional: 0, checkedIn: 0, checkedInPeople: 0, cancelled: 0, failedDeliveries: 0 };
  for (const registration of registrations) {
    if (registration.status === 'cancelled') { totals.cancelled++; continue; }
    const counts = participantCounts(registration, event);
    totals.registrations++;
    totals.participants += counts.total;
    totals.additional += counts.additional;
    if (registration.ticketCheckedInAt) {
      totals.checkedIn++;
      totals.checkedInPeople += (registration.ticketCheckInAdults ?? counts.adults) + (registration.ticketCheckInChildren ?? counts.children);
    }
    if (registration.ticketWhatsAppError && !registration.ticketWhatsAppSentAt) totals.failedDeliveries++;
  }
  return totals;
}

function deliveryState(registration) {
  if (registration.ticketWhatsAppSentAt) return { key: 'sent', label: 'נשלח בוואטסאפ', tone: 'success' };
  if (registration.ticketWhatsAppError) return { key: 'failed', label: 'שליחה נכשלה', tone: 'danger' };
  return { key: 'pending', label: registration.ticketToken ? 'כרטיס נוצר, טרם נשלח' : 'טרם נוצר כרטיס', tone: 'secondary' };
}

module.exports = { activeRegistrationFilter, additionalParticipants, participantCounts, totalsForRegistrations, deliveryState };
