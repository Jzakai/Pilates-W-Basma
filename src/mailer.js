const nodemailer = require('nodemailer');

function createMailer(config) {
  const transport = config.smtp.host
    ? nodemailer.createTransport({
        host: config.smtp.host,
        port: config.smtp.port,
        secure: config.smtp.port === 465,
        auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
      })
    : null;

  return {
    // icalEvent: optional { method, filename, content } calendar invite.
    async send({ to, subject, text, icalEvent }) {
      if (!to) return;
      if (!transport) {
        console.log(`\n--- email (SMTP not configured) ---\nTo: ${to}\nSubject: ${subject}\n\n${text}` +
          (icalEvent ? `\n[calendar invite attached: ${icalEvent.method}]` : '') + '\n---\n');
        return;
      }
      try {
        await transport.sendMail({ from: config.emailFrom, to, subject, text, icalEvent });
      } catch (err) {
        // A failed email must never break a booking.
        console.error(`Failed to send email to ${to}:`, err.message);
      }
    },
  };
}

module.exports = { createMailer };
