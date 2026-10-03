// Currencies whose smallest unit is not 1/100 (see Stripe's currency docs).
const ZERO_DECIMAL = new Set(['bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg', 'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf']);
const THREE_DECIMAL = new Set(['bhd', 'jod', 'kwd', 'omr', 'tnd']);

function minorUnitFactor(currency) {
  const c = currency.toLowerCase();
  if (ZERO_DECIMAL.has(c)) return 1;
  if (THREE_DECIMAL.has(c)) return 1000;
  return 100;
}

function toMinor(amount, currency) {
  return Math.round(amount * minorUnitFactor(currency));
}

function formatMoney(minor, currency) {
  const factor = minorUnitFactor(currency);
  try {
    return new Intl.NumberFormat('en', {
      style: 'currency',
      currency: currency.toUpperCase(),
      minimumFractionDigits: minor % factor === 0 ? 0 : undefined,
    }).format(minor / factor);
  } catch {
    return `${(minor / factor).toFixed(2)} ${currency.toUpperCase()}`;
  }
}

function clock12(minutes) {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return { text: `${h % 12 || 12}${m ? ':' + String(m).padStart(2, '0') : ''}`, pm: h >= 12 };
}

// ("19:15", 60) -> "7:15–8:15 pm"
function formatTimeRange(time, durationMin) {
  const [h, m] = time.split(':').map(Number);
  const start = clock12(h * 60 + m);
  const end = clock12(h * 60 + m + (durationMin || 0));
  if (!durationMin) return `${start.text} ${start.pm ? 'pm' : 'am'}`;
  return start.pm === end.pm
    ? `${start.text}–${end.text} ${end.pm ? 'pm' : 'am'}`
    : `${start.text} ${start.pm ? 'pm' : 'am'}–${end.text} ${end.pm ? 'pm' : 'am'}`;
}

// ("2026-10-04T19:15", 60) -> "Sunday 4 October 2026, 7:15–8:15 pm"
function formatClassTime(local, durationMin) {
  const [date, time] = local.split('T');
  const [y, m, d] = date.split('-').map(Number);
  const dayLabel = new Intl.DateTimeFormat('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(y, m - 1, d)));
  return `${dayLabel}, ${formatTimeRange(time, durationMin)}`;
}

module.exports = { toMinor, formatMoney, formatClassTime, formatTimeRange, minorUnitFactor };
