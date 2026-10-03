const { config } = require('./config');
const { openDb } = require('./db');
const { createPayments } = require('./payments');
const { createMailer } = require('./mailer');
const { createBookingService } = require('./bookings');
const { createApp } = require('./app');

const db = openDb(config.databasePath);
const payments = createPayments(config);
const mailer = createMailer(config);
const service = createBookingService({ db, config, payments, mailer });
const app = createApp({ config, service, payments });

service.syncSessions();

// Release unpaid seats and lapsed waitlist offers every minute; add new dates every hour.
setInterval(() => service.sweep().catch((err) => console.error('Sweep failed:', err)), 60_000);
setInterval(() => service.syncSessions(), 3600_000);

app.listen(config.port, () => {
  console.log(`${config.studio.name} booking site running at ${config.baseUrl}`);
  console.log(payments.name === 'demo'
    ? 'Payments: DEMO mode (set MOYASAR_SECRET_KEY to take real payments)'
    : `Payments: ${payments.name}`);
  if (config.studio.bankTransfer.enabled) console.log('Bank transfer / STC Pay option: enabled');
  if (!config.adminPassword) console.log('Dashboard disabled: set ADMIN_PASSWORD to enable /admin');
  if (!config.smtp.host) console.log('Email: SMTP not configured, emails will be printed here');
});
