const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const multer = require('multer');
const { BookingError } = require('./errors');
const { ACTIVITY_LEVELS } = require('./accounts');

const RECEIPT_TYPES = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/heic': '.heic',
  'image/heif': '.heif',
  'application/pdf': '.pdf',
};
const COOKIE = 'sid';

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

function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

// Small in-memory limiter for sign-in / sign-up / reset attempts.
function rateLimit({ max, windowMs }) {
  const hits = new Map();
  return (req, res, next) => {
    const key = req.ip;
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || entry.reset < now) {
      hits.set(key, { count: 1, reset: now + windowMs });
      if (hits.size > 10_000) hits.clear();
      return next();
    }
    if (++entry.count > max) return res.status(429).json({ error: 'Too many attempts. Please wait a few minutes and try again.' });
    next();
  };
}

// Wraps async handlers so thrown errors reach the error middleware.
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function createApp({ config, service, accounts }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '20kb' }));
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    next();
  });

  fs.mkdirSync(config.uploadDir, { recursive: true });
  const upload = multer({
    storage: multer.diskStorage({
      destination: config.uploadDir,
      filename: (req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex') + RECEIPT_TYPES[file.mimetype]),
    }),
    limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 1 },
    fileFilter: (req, file, cb) => {
      if (RECEIPT_TYPES[file.mimetype]) return cb(null, true);
      cb(new BookingError('Please upload the receipt as a photo (JPG, PNG, HEIC) or a PDF.'));
    },
  });

  const secure = config.baseUrl.startsWith('https://');
  const setSession = (res, token) => res.cookie(COOKIE, token, {
    httpOnly: true, sameSite: 'lax', secure, maxAge: 60 * 86400_000, path: '/',
  });

  // Attaches the signed-in client (if any) to req.user.
  app.use((req, res, next) => {
    req.user = accounts.userFromToken(readCookie(req, COOKIE));
    next();
  });
  const requireUser = (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Please sign in first.', signIn: true });
    next();
  };

  const authLimit = rateLimit({ max: 20, windowMs: 10 * 60_000 });

  // ----------------------------------------------------------------- public

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
      paymentInstructions: studio.paymentInstructions,
      bookingCutoffHours: config.bookingCutoffHours,
      paymentDeadlineHours: config.paymentDeadlineHours,
      cancellationHours: config.cancellationHours,
      waitlistOfferHours: config.waitlistOfferHours,
      activityLevels: ACTIVITY_LEVELS,
      maxUploadMb: config.maxUploadMb,
    });
  });

  app.get('/api/sessions', (req, res) => res.json(service.listUpcoming(req.user)));

  // ------------------------------------------------------------------ auth

  app.post('/api/auth/signup', authLimit, (req, res) => {
    const { user, token } = accounts.signUp(req.body);
    setSession(res, token);
    res.json({ user });
  });

  app.post('/api/auth/signin', authLimit, (req, res) => {
    const { user, token } = accounts.signIn(req.body);
    setSession(res, token);
    res.json({ user });
  });

  app.post('/api/auth/signout', (req, res) => {
    accounts.signOut(readCookie(req, COOKIE));
    res.clearCookie(COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  app.get('/api/auth/me', (req, res) => res.json({ user: req.user ? accounts.publicUser(req.user) : null }));

  app.post('/api/auth/forgot', authLimit, h(async (req, res) => {
    await accounts.requestPasswordReset(req.body.email);
    res.json({ ok: true });
  }));

  app.post('/api/auth/reset', authLimit, (req, res) => {
    const { user, token } = accounts.resetPassword(req.body.token, req.body.password);
    setSession(res, token);
    res.json({ user });
  });

  // ---------------------------------------------------------------- client

  app.get('/api/me', requireUser, (req, res) => res.json(service.myAccount(req.user)));

  app.post('/api/me/profile', requireUser, (req, res) => res.json({ user: accounts.updateProfile(req.user.id, req.body) }));

  app.post('/api/bookings', requireUser, h(async (req, res) => {
    res.json(await service.bookClasses(req.user, req.body.sessionIds));
  }));

  app.post('/api/bookings/:id/cancel', requireUser, h(async (req, res) => {
    res.json(await service.cancelByUser(req.user, Number(req.params.id)));
  }));

  app.get('/api/bookings/:id/calendar.ics', requireUser, (req, res) => {
    res.type('text/calendar').attachment('pilates-class.ics').send(service.bookingCalendar(req.user, Number(req.params.id)));
  });

  app.post('/api/payments', requireUser, upload.single('receipt'), h(async (req, res) => {
    let ids = req.body.bookingIds;
    if (typeof ids === 'string') ids = ids.split(',');
    try {
      res.json(await service.payBookings(req.user, {
        bookingIds: ids,
        useCredits: req.body.useCredits === 'true' || req.body.useCredits === true,
        file: req.file,
      }));
    } catch (err) {
      if (req.file) fs.rm(req.file.path, { force: true }, () => {});
      throw err;
    }
  }));

  const sendReceipt = (res, p) => {
    res.type(p.receipt_type);
    res.set('Content-Disposition', `inline; filename="receipt-${p.id}${path.extname(p.receipt_file)}"`);
    res.sendFile(path.join(config.uploadDir, path.basename(p.receipt_file)));
  };

  app.get('/api/payments/:id/receipt', requireUser, (req, res) => sendReceipt(res, service.receiptFor(Number(req.params.id), req.user)));

  app.post('/api/sessions/:id/waitlist', requireUser, (req, res) => res.json(service.joinWaitlist(req.user, Number(req.params.id))));
  app.post('/api/waitlist/:id/claim', requireUser, (req, res) => res.json(service.claimOffer(req.user, Number(req.params.id))));
  app.post('/api/waitlist/:id/leave', requireUser, (req, res) => {
    service.leaveWaitlist(req.user, Number(req.params.id));
    res.json({ ok: true });
  });

  // ----------------------------------------------------------------- admin

  const admin = express.Router();
  admin.use(adminAuth(config));
  admin.get('/sessions', (req, res) => res.json(service.adminSessions({ includePast: req.query.past === '1' })));
  admin.get('/sessions/:id', (req, res) => res.json(service.adminSessionDetail(Number(req.params.id))));
  admin.post('/sessions/:id/capacity', (req, res) => {
    service.adminSetCapacity(Number(req.params.id), req.body.capacity);
    res.json({ ok: true });
  });
  admin.post('/sessions/:id/cancel', h(async (req, res) => {
    res.json(await service.adminCancelClass(Number(req.params.id), { reason: req.body.reason }));
  }));
  admin.post('/sessions/:id/bookings', h(async (req, res) => {
    await service.adminAddBooking(Number(req.params.id), req.body);
    res.json({ ok: true });
  }));
  admin.post('/bookings/:id/cancel', h(async (req, res) => {
    res.json(await service.adminCancelBooking(Number(req.params.id), { credit: req.body.credit !== false, reason: req.body.reason }));
  }));
  admin.post('/waitlist/:id/remove', (req, res) => {
    service.adminRemoveWaitlist(Number(req.params.id));
    res.json({ ok: true });
  });
  admin.get('/payments', (req, res) => res.json(service.adminPayments(String(req.query.status || 'pending_review'))));
  admin.get('/payments/:id/receipt', (req, res) => sendReceipt(res, service.receiptFor(Number(req.params.id))));
  admin.post('/payments/:id/approve', h(async (req, res) => res.json(await service.approvePayment(Number(req.params.id)))));
  admin.post('/payments/:id/reject', h(async (req, res) => res.json(await service.rejectPayment(Number(req.params.id), req.body.reason))));
  admin.get('/clients', (req, res) => res.json(service.adminClients(req.query.q || '')));
  admin.get('/clients/:id', (req, res) => res.json(service.adminClientDetail(Number(req.params.id))));
  admin.get('/templates', (req, res) => res.json(service.listTemplates()));
  admin.post('/templates', (req, res) => {
    service.addTemplate(req.body);
    res.json({ ok: true });
  });
  admin.post('/templates/:id', (req, res) => res.json(service.editTemplate(Number(req.params.id), req.body)));
  admin.post('/classes', (req, res) => {
    service.addOneOffClass(req.body);
    res.json({ ok: true });
  });
  app.use('/api/admin', admin);

  // ---------------------------------------------------------- static pages

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
    if (err instanceof multer.MulterError) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? `The receipt must be smaller than ${config.maxUploadMb} MB.` : 'The upload could not be read.';
      return res.status(400).json({ error: msg });
    }
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid request.' });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  });

  return app;
}

module.exports = { createApp };
