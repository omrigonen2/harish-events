function eventState(event, now = new Date()) {
  if (event.archivedAt) return { key: 'archived', label: 'בארכיון', tone: 'secondary' };
  if (!event.isActive) return { key: 'draft', label: 'טיוטה', tone: 'secondary' };
  if (event.date && new Date(event.date) <= now) return { key: 'past', label: 'אירוע שהסתיים', tone: 'secondary' };
  return { key: 'upcoming', label: 'אירוע קרוב', tone: 'primary' };
}

function registrationState(event, now = new Date()) {
  if (event.archivedAt || !event.isActive) return { key: 'unpublished', label: 'אינו מפורסם', open: false };
  if (event.date && new Date(event.date) <= now) return { key: 'ended', label: 'האירוע הסתיים', open: false };
  if (event.signupPaused) return { key: 'paused', label: 'ההרשמה סגורה ידנית', open: false };
  if (event.signupCloseAt && new Date(event.signupCloseAt) <= now) return { key: 'closed', label: 'ההרשמה נסגרה', open: false };
  if (event.signupOpenAt && new Date(event.signupOpenAt) > now) return { key: 'scheduled', label: 'ההרשמה תיפתח בהמשך', open: false };
  return { key: 'open', label: 'ההרשמה פתוחה', open: true };
}

function limitLabel(mode) {
  return mode === 'participants' ? 'משתתפים' : mode === 'children' ? 'משתתפים נוספים' : 'הרשמות';
}

module.exports = { eventState, registrationState, limitLabel };
