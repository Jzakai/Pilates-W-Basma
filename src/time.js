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

// "YYYY-MM-DDTHH:MM" in the studio timezone -> epoch ms.
function localToEpoch(local, timeZone) {
  const [date, time] = local.split('T');
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const asUtc = Date.UTC(y, m - 1, d, hh, mm);
  // Shift by the zone's offset at that moment (twice, to settle across DST changes).
  let guess = asUtc;
  for (let i = 0; i < 2; i++) {
    const seen = localString(guess, timeZone);
    const [sd, st] = seen.split('T');
    const [sy, sm, sdd] = sd.split('-').map(Number);
    const [sh, smin] = st.split(':').map(Number);
    guess += asUtc - Date.UTC(sy, sm - 1, sdd, sh, smin);
  }
  return guess;
}

module.exports = { localString, localToEpoch, upcomingDates };
