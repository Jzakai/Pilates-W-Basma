// Builds iCalendar (.ics) invites so clients can add classes to their calendar.
const { localToEpoch } = require('./time');

const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const escape = (s) => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');

function bookingIcs({ booking, session, config, cancelled = false }) {
  const start = localToEpoch(session.starts_at, config.studio.timezone);
  const end = start + session.duration_min * 60_000;
  const host = new URL(config.baseUrl).hostname;
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:-//${escape(config.studio.name)}//Bookings//EN`,
    `METHOD:${cancelled ? 'CANCEL' : 'PUBLISH'}`,
    'BEGIN:VEVENT',
    `UID:booking-${booking.id}@${host}`,
    `SEQUENCE:${cancelled ? 1 : 0}`,
    `DTSTAMP:${stamp(Date.now())}`,
    `DTSTART:${stamp(start)}`,
    `DTEND:${stamp(end)}`,
    `SUMMARY:${escape(`${session.title} with ${config.studio.instructor || config.studio.name}`)}`,
    `LOCATION:${escape(session.location || config.studio.location)}`,
    `DESCRIPTION:${escape(`Manage your booking: ${config.baseUrl}/account.html`)}`,
    `STATUS:${cancelled ? 'CANCELLED' : 'CONFIRMED'}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
}

module.exports = { bookingIcs };
