const { DateTime } = require('luxon');

/** Israel — matches datetime-local wall time in the admin UI */
const ZONE = 'Asia/Jerusalem';

/**
 * Value for HTML input[type=datetime-local] from a stored Date (Mongo UTC).
 */
function toDatetimeLocalInputValue(d) {
  if (d == null) return '';
  const dt = DateTime.fromJSDate(new Date(d), { zone: ZONE });
  if (!dt.isValid) return '';
  return dt.toFormat("yyyy-MM-dd'T'HH:mm");
}

/**
 * Parse POST body from datetime-local (wall time in Israel).
 * @returns {Date|null}
 */
function parseDatetimeLocalInput(str) {
  if (str == null || typeof str !== 'string') return null;
  const trimmed = str.trim();
  if (!trimmed) return null;
  const dt = DateTime.fromISO(trimmed, { zone: ZONE });
  if (!dt.isValid) return null;
  return dt.toJSDate();
}

module.exports = {
  ZONE,
  toDatetimeLocalInputValue,
  parseDatetimeLocalInput,
};
