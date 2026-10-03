const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch {
  // No .env file — rely on real environment variables.
}

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function loadSchedule(file = process.env.SCHEDULE_PATH || path.join(ROOT, 'schedule.json')) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const studio = raw.studio || {};
  const keys = new Set();
  const classes = (raw.classes || []).map((c, i) => {
    const where = `schedule.json classes[${i}]`;
    if (!c.key) throw new Error(`${where}: missing "key"`);
    if (keys.has(c.key)) throw new Error(`${where}: duplicate key "${c.key}"`);
    keys.add(c.key);
    const day = DAYS.indexOf(String(c.day || '').toLowerCase());
    if (day === -1) throw new Error(`${where}: "day" must be a weekday name, got "${c.day}"`);
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(c.time || '')) {
      throw new Error(`${where}: "time" must be HH:MM (24h), got "${c.time}"`);
    }
    if (!(c.capacity > 0)) throw new Error(`${where}: "capacity" must be a positive number`);
    if (!(c.price >= 0)) throw new Error(`${where}: "price" must be zero or more`);
    return {
      key: c.key,
      title: c.title || 'Class',
      weekday: day,
      time: c.time,
      durationMinutes: c.durationMinutes || 60,
      capacity: Math.floor(c.capacity),
      price: c.price,
      description: c.description || '',
      location: c.location || studio.location || '',
    };
  });

  return {
    studio: {
      name: studio.name || 'Pilates Studio',
      instructor: studio.instructor || '',
      eyebrow: studio.eyebrow || '',
      tagline: studio.tagline || '',
      notice: studio.notice || '',
      about: studio.about || '',
      location: studio.location || '',
      contactEmail: studio.contactEmail || '',
      contactPhone: studio.contactPhone || '',
      instagram: studio.instagram || '',
      timezone: studio.timezone || 'UTC',
      currency: (studio.currency || 'usd').toLowerCase(),
      weeksAhead: studio.weeksAhead || 4,
      bankTransfer: {
        enabled: Boolean(studio.bankTransfer?.enabled),
        instructions: studio.bankTransfer?.instructions || '',
      },
    },
    classes,
  };
}

const env = process.env;

const config = {
  root: ROOT,
  port: Number(env.PORT) || 3000,
  // RENDER_EXTERNAL_URL is set automatically on Render.
  baseUrl: (env.BASE_URL || env.RENDER_EXTERNAL_URL || `http://localhost:${Number(env.PORT) || 3000}`).replace(/\/$/, ''),
  adminPassword: env.ADMIN_PASSWORD || '',
  databasePath: env.DATABASE_PATH || path.join(ROOT, 'data', 'bookings.db'),
  // moyasar | stripe | demo. Defaults to whichever gateway has a key configured.
  paymentProvider: (env.PAYMENT_PROVIDER ||
    (env.MOYASAR_SECRET_KEY ? 'moyasar' : env.STRIPE_SECRET_KEY ? 'stripe' : 'demo')).toLowerCase(),
  moyasarSecretKey: env.MOYASAR_SECRET_KEY || '',
  moyasarWebhookSecret: env.MOYASAR_WEBHOOK_SECRET || '',
  stripeSecretKey: env.STRIPE_SECRET_KEY || '',
  stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET || '',
  smtp: {
    host: env.SMTP_HOST || '',
    port: Number(env.SMTP_PORT) || 587,
    user: env.SMTP_USER || '',
    pass: env.SMTP_PASS || '',
  },
  emailFrom: env.EMAIL_FROM || 'bookings@example.com',
  adminNotifyEmail: env.ADMIN_NOTIFY_EMAIL || '',
  waitlistOfferHours: Number(env.WAITLIST_OFFER_HOURS) || 12,
  // How long a bank-transfer booking holds its spot while waiting for the money.
  transferHoldHours: Number(env.TRANSFER_HOLD_HOURS) || 24,
  cancellationHours: env.CANCELLATION_HOURS === undefined ? 12 : Number(env.CANCELLATION_HOURS),
  refundOnCancel: (env.REFUND_ON_CANCEL || 'true').toLowerCase() !== 'false',
  // Seat hold while the customer is on the payment page. Stripe Checkout sessions
  // must last at least 30 minutes, so the hold is a little longer than that.
  checkoutMinutes: 31,
  holdMinutes: 35,
  ...loadSchedule(),
};

module.exports = { config, loadSchedule, DAYS };
