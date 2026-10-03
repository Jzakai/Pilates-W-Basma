const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');
const { BookingError } = require('./bookings');

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function adminAuth(config) {
  return (req, res, next) => {
    if (!config.adminPassword) {
      return res.status(503).json({ error: 'Set ADMIN_PASSWORD to enable the dashboard.' });
    }
    const [scheme, encoded] = (req.headers.authorization || '').split(' ');
    if (scheme === 'Basic' && encoded) {
      const decoded = Buffer.from(encoded, 'base64').toString();
      const password = decoded.slice(decoded.indexOf(':') + 1);
      if (safeEqual(password, config.adminPassword)) return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="Studio dashboard", charset="UTF-8"');
    res.status(401).send('Authentication required');
  };
}

// Wraps async handlers so thrown errors reach the error middleware.
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

function createApp({ config, service, payments }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  // Stripe needs the raw body to verify the webhook signature, so this route comes before express.json().
  app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), h(async (req, res) => {
    if (payments.name !== 'stripe') return res.status(404).end();
    let event;
    try {
      event = payments.constructWebhookEvent(req.body, req.headers['stripe-signature']);
    } catch (err) {
      return res.status(400).send(`Webhook error: ${err.message}`);
    }
    const checkout = event.data.object;
    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
      await service.completeCheckout(checkout.id);
    } else if (event.type === 'checkout.session.expired') {
      await service.checkoutExpired(checkout.id);
    }
    res.json({ received: true });
  }));

  app.use(express.json({ limit: '20kb' }));

  // Moyasar calls this when an invoice is paid. Ids in the body are re-verified with Moyasar's API.
  app.post('/api/moyasar/webhook', h(async (req, res) => {
    if (payments.name !== 'moyasar') return res.status(404).end();
    for (const id of payments.invoiceIdsFromEvent(req.body || {})) await service.completeCheckout(id);
    res.json({ received: true });
  }));

  // ---------------------------------------------------------------- public API

  app.get('/api/studio', (req, res) => {
    const { studio } = config;
    res.json({
      name: studio.name,
      instructor: studio.instructor,
      eyebrow: studio.eyebrow,
      tagline: studio.tagline,
      notice: studio.notice,
      about: studio.about,
      location: studio.location,
      contactEmail: studio.contactEmail,
      contactPhone: studio.contactPhone,
      instagram: studio.instagram,
      timezone: studio.timezone,
      cancellationHours: config.cancellationHours,
      waitlistOfferHours: config.waitlistOfferHours,
      demoPayments: payments.name === 'demo',
      onlinePayments: payments.name,
      bankTransfer: studio.bankTransfer.enabled,
    });
  });

  app.get('/api/sessions', (req, res) => res.json(service.listUpcoming()));

  app.post('/api/sessions/:id/book', h(async (req, res) => {
    res.json(await service.startBooking(Number(req.params.id), req.body));
  }));

  app.post('/api/sessions/:id/waitlist', (req, res) => {
    res.json(service.joinWaitlist(Number(req.params.id), req.body));
  });

  app.get('/api/bookings/:token', h(async (req, res) => {
    res.json(await service.refreshBooking(req.params.token));
  }));

  app.post('/api/bookings/:token/cancel', h(async (req, res) => {
    res.json(await service.cancelByCustomer(req.params.token));
  }));

  app.post('/api/demo-pay/:token', h(async (req, res) => {
    await service.demoPay(req.params.token);
    res.json({ ok: true });
  }));

  app.get('/api/waitlist/:token', (req, res) => res.json(service.waitlistView(req.params.token)));

  app.post('/api/waitlist/:token/claim', h(async (req, res) => {
    res.json(await service.claimOffer(req.params.token, { paymentMethod: req.body.paymentMethod }));
  }));

  app.post('/api/waitlist/:token/leave', (req, res) => res.json(service.leaveWaitlist(req.params.token)));

  // ----------------------------------------------------------------- admin API

  const admin = express.Router();
  admin.use(adminAuth(config));
  admin.get('/sessions', (req, res) => res.json(service.adminSessions({ includePast: req.query.past === '1' })));
  admin.get('/sessions/:id', (req, res) => res.json(service.adminSessionDetail(Number(req.params.id))));
  admin.post('/sessions/:id/capacity', (req, res) => {
    service.adminSetCapacity(Number(req.params.id), req.body.capacity);
    res.json({ ok: true });
  });
  admin.post('/sessions/:id/cancel', h(async (req, res) => {
    res.json(await service.adminCancelSession(Number(req.params.id), { reason: String(req.body.reason || '').slice(0, 300) }));
  }));
  admin.post('/sessions/:id/bookings', h(async (req, res) => {
    await service.adminAddBooking(Number(req.params.id), req.body);
    res.json({ ok: true });
  }));
  admin.post('/bookings/:id/cancel', h(async (req, res) => {
    const refunded = await service.adminCancelBooking(Number(req.params.id), { refund: Boolean(req.body.refund) });
    res.json({ ok: true, refunded });
  }));
  admin.post('/bookings/:id/paid', h(async (req, res) => {
    await service.adminMarkPaid(Number(req.params.id));
    res.json({ ok: true });
  }));
  admin.post('/waitlist/:id/remove', (req, res) => {
    service.adminRemoveWaitlist(Number(req.params.id));
    res.json({ ok: true });
  });
  app.use('/api/admin', admin);

  // -------------------------------------------------------------- static pages

  app.get(['/admin', '/admin.html'], adminAuth(config), (req, res) => {
    res.sendFile(path.join(config.root, 'public', 'admin.html'));
  });
  app.use(express.static(path.join(config.root, 'public'), { extensions: ['html'] }));

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof BookingError) {
      const { message, status, ...extra } = err;
      return res.status(status).json({ error: message, ...extra });
    }
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid request.' });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  });

  return app;
}

module.exports = { createApp };
