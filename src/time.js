// Class times are stored as local wall-clock strings ("YYYY-MM-DDTHH:MM") in the
// studio timezone. Comparing them as strings is enough because the format sorts
// chronologically, so we only need to know what "now" is in the studio timezone.

function localString(epochMs, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(epochMs))
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

// Calendar dates (YYYY-MM-DD) starting today in the studio timezone, with weekday (0 = Sunday).
function upcomingDates(nowMs, timeZone, days) {
  const today = localString(nowMs, timeZone).slice(0, 10);
  const [y, m, d] = today.split('-').map(Number);
  const out = [];
  for (let i = 0; i < days; i++) {
    const date = new Date(Date.UTC(y, m - 1, d + i));
    out.push({ date: date.toISOString().slice(0, 10), weekday: date.getUTCDay() });
  }
  return out;
}

module.exports = { localString, upcomingDates };
