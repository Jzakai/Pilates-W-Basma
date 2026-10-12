const { config } = require('./config');
const { openDb } = require('./db');
const { createMailer } = require('./mailer');
const { createBookingService } = require('./bookings');
const { createAccountService } = require('./accounts');
const { createApp } = require('./app');

const db = openDb(config.databasePath);
const mailer = createMailer(config);
const service = createBookingService({ db, config, mailer });
const accounts = createAccountService({ db, config, mailer });
const app = createApp({ config, service, accounts });

service.seedTemplates();
service.syncSessions();

// Every minute: release unpaid spots, send payment reminders, pass on lapsed waitlist offers.
// Every hour: add dates for the coming weeks.
setInterval(() => service.sweep().catch((err) => console.error('Sweep failed:', err)), 60_000);
setInterval(() => service.syncSessions(), 3600_000);

app.listen(config.port, () => {
  console.log(`${config.studio.name} booking site running at ${config.baseUrl}`);
  console.log('Payments: bank transfer / STC Pay with receipt upload');
  if (!config.adminPassword) console.log('Dashboard disabled: set ADMIN_PASSWORD to enable /admin');
  if (!config.smtp.host) console.log('Email: SMTP not configured, emails will be printed here');
});
