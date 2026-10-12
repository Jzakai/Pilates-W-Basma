const { config } = require('./config');
const { openDb } = require('./db');
const { createMailer } = require('./mailer');
const { createStorage } = require('./storage');
const { createBookingService } = require('./bookings');
const { createAccountService } = require('./accounts');
const { createApp } = require('./app');

async function main() {
  const db = await openDb({ url: config.databaseUrl, file: config.databasePath });
  const storage = createStorage(config);
  await storage.init();
  const mailer = createMailer(config);
  const service = createBookingService({ db, config, mailer });
  const accounts = createAccountService({ db, config, mailer });
  const app = createApp({ config, service, accounts, storage });

  await service.seedTemplates();
  await service.syncSessions();

  const sweep = () => service.sweep().catch((err) => console.error('Sweep failed:', err));
  const sync = () => service.syncSessions().catch((err) => console.error('Schedule update failed:', err));
  // Catch up straight away in case the server was asleep (free hosting plans pause idle sites).
  await sweep();
  // Every minute: release unpaid spots, send payment reminders, pass on lapsed waitlist offers.
  // Every hour: add dates for the coming weeks.
  setInterval(sweep, 60_000);
  setInterval(sync, 3600_000);

  app.listen(config.port, () => {
    console.log(`${config.studio.name} booking site running at ${config.baseUrl}`);
    console.log(`Database: ${db.dialect === 'pg' ? 'Postgres (DATABASE_URL)' : `SQLite file ${config.databasePath}`}`);
    console.log(`Receipts: ${storage.kind === 'supabase' ? `Supabase Storage bucket "${config.supabaseBucket}"` : `local folder ${config.uploadDir}`}`);
    if (!config.adminPassword) console.log('Dashboard disabled: set ADMIN_PASSWORD to enable /admin');
    console.log(`Email: ${{ brevo: `Brevo, from ${config.emailFrom}`, smtp: `SMTP ${config.smtp.host}`, console: 'not configured, emails will be printed here' }[mailer.kind]}`);
  });
}

main().catch((err) => {
  console.error('Could not start:', err.message);
  process.exit(1);
});
