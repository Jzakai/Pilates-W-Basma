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
      // Bank / STC Pay details shown to clients when they pay.
      paymentInstructions: studio.paymentInstructions || '',
    },
    classes,
  };
}

const env = process.env;

const hours = (name, fallback) => (env[name] === undefined || env[name] === '' ? fallback : Number(env[name]));

const databasePath = env.DATABASE_PATH || path.join(ROOT, 'data', 'bookings.db');

const config = {
  root: ROOT,
  port: Number(env.PORT) || 3000,
  // RENDER_EXTERNAL_URL is set automatically on Render.
  baseUrl: (env.BASE_URL || env.RENDER_EXTERNAL_URL || `http://localhost:${Number(env.PORT) || 3000}`).replace(/\/$/, ''),
  adminPassword: env.ADMIN_PASSWORD || '',
  // Postgres connection string (Supabase). Without it a local SQLite file is used.
  databaseUrl: env.DATABASE_URL || '',
  databasePath,
  // Supabase Storage for receipt files. Without it receipts are kept in a local folder.
  supabaseUrl: env.SUPABASE_URL || '',
  supabaseServiceKey: env.SUPABASE_SERVICE_ROLE_KEY || '',
  supabaseBucket: env.SUPABASE_BUCKET || 'receipts',
  uploadDir: env.UPLOAD_DIR || path.join(path.dirname(databasePath), 'receipts'),
  maxUploadMb: Number(env.MAX_UPLOAD_MB) || 8,
  smtp: {
    host: env.SMTP_HOST || '',
    port: Number(env.SMTP_PORT) || 587,
    user: env.SMTP_USER || '',
    pass: env.SMTP_PASS || '',
  },
  // Brevo API key: sends email over HTTPS (use this on Render's free plan, which blocks SMTP).
  brevoApiKey: env.BREVO_API_KEY || '',
  emailFrom: env.EMAIL_FROM || 'bookings@example.com',
  adminNotifyEmail: env.ADMIN_NOTIFY_EMAIL || '',

  // Booking rules (all in hours before the class starts unless noted).
  bookingCutoffHours: hours('BOOKING_CUTOFF_HOURS', 48),      // online booking closes
  paymentDeadlineHours: hours('PAYMENT_DEADLINE_HOURS', 24),  // unpaid bookings are released
  paymentReminderHours: hours('PAYMENT_REMINDER_HOURS', 48),  // reminder for unpaid bookings
  cancellationHours: hours('CANCELLATION_HOURS', 12),         // clients can cancel online until
  waitlistOfferHours: hours('WAITLIST_OFFER_HOURS', 12),      // time to claim a freed spot
  ...loadSchedule(),
};

module.exports = { config, loadSchedule, DAYS };
