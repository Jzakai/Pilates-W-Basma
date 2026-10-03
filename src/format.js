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

// "2026-10-05T18:00" -> "Monday 5 October 2026, 18:00"
function formatClassTime(local) {
  const [date, time] = local.split('T');
  const [y, m, d] = date.split('-').map(Number);
  const dayLabel = new Intl.DateTimeFormat('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(y, m - 1, d)));
  return `${dayLabel}, ${time}`;
}

module.exports = { toMinor, formatMoney, formatClassTime, minorUnitFactor };
