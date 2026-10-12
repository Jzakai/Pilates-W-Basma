const nodemailer = require('nodemailer');

// "Name <email@x.com>" → { name, email }
function parseAddress(from) {
  const m = String(from).match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  return m ? { name: m[1].trim() || undefined, email: m[2].trim() } : { email: String(from).trim() };
}

// Brevo's HTTPS API (https://www.brevo.com). Works on hosts that block SMTP ports, like Render's free plan.
function brevoTransport(config, fetchImpl) {
  return {
    async sendMail({ from, to, subject, text, icalEvent }) {
      const body = {
        sender: parseAddress(from),
        to: [{ email: to }],
        subject,
        textContent: text,
      };
      if (icalEvent) {
        body.attachment = [{ name: icalEvent.filename || 'invite.ics', content: Buffer.from(icalEvent.content).toString('base64') }];
      }
      const res = await fetchImpl('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': config.brevoApiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`Brevo ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
    },
  };
}

function createMailer(config, { fetchImpl = fetch } = {}) {
  let transport = null;
  if (config.brevoApiKey) {
    transport = brevoTransport(config, fetchImpl);
  } else if (config.smtp.host) {
    transport = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.port === 465,
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
    });
  }

  return {
    kind: config.brevoApiKey ? 'brevo' : config.smtp.host ? 'smtp' : 'console',
    // icalEvent: optional { method, filename, content } calendar invite.
    async send({ to, subject, text, icalEvent }) {
      if (!to) return;
      if (!transport) {
        console.log(`\n--- email (not configured) ---\nTo: ${to}\nSubject: ${subject}\n\n${text}` +
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

module.exports = { createMailer, parseAddress };
