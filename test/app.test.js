const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb } = require('../src/db');
const { createBookingService } = require('../src/bookings');
const { createAccountService } = require('../src/accounts');
const { createApp } = require('../src/app');
const { localStorage, supabaseStorage } = require('../src/storage');

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));

test('Supabase Storage adapter: creates the bucket, uploads, downloads and deletes receipts', async () => {
  const objects = new Map();
  const seen = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, apikey: req.headers.apikey });
    if (req.method === 'POST' && req.url === '/storage/v1/bucket') {
      res.statusCode = 400;
      return res.end(JSON.stringify({ statusCode: '409', error: 'Duplicate', message: 'The resource already exists' }));
    }
    const m = req.url.match(/^\/storage\/v1\/object\/receipts\/?(.*)$/);
    if (!m) return res.writeHead(404).end();
    if (req.method === 'POST') objects.set(m[1], { body, type: req.headers['content-type'] });
    if (req.method === 'GET') {
      if (!objects.has(m[1])) return res.writeHead(400).end('{"error":"not_found"}');
      return res.writeHead(200, { 'Content-Type': objects.get(m[1]).type }).end(objects.get(m[1]).body);
    }
    if (req.method === 'DELETE') for (const k of JSON.parse(body).prefixes) objects.delete(k);
    res.writeHead(200).end('{}');
  });
  const url = await listen(server);
  try {
    const storage = supabaseStorage({ url, serviceKey: 'service-key', bucket: 'receipts' });
    await storage.init();
    await storage.save('abc.png', Buffer.from('png-bytes'), 'image/png');
    assert.equal(objects.get('abc.png').type, 'image/png');
    assert.equal((await storage.read('abc.png')).toString(), 'png-bytes');
    await storage.remove('abc.png');
    assert.equal(await storage.read('abc.png'), null);
    assert.ok(seen.every((r) => r.auth === 'Bearer service-key' && r.apikey === 'service-key'));
  } finally {
    server.close();
  }
});

test('website: sign up, book, upload a receipt, instructor opens it and approves', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'receipts-'));
  let clock = Date.UTC(2026, 9, 5, 8, 0);
  const config = {
    root: path.join(__dirname, '..'),
    baseUrl: 'http://test',
    adminPassword: 'admin-pass',
    maxUploadMb: 1,
    studio: { name: 'Test Studio', instructor: 'Basma', timezone: 'UTC', currency: 'sar', weeksAhead: 1, location: 'Studio' },
    classes: [{ key: 'thu', title: 'Pilates', weekday: 4, time: '18:00', durationMinutes: 60, capacity: 5, price: 30, description: '' }],
    bookingCutoffHours: 48, paymentDeadlineHours: 24, paymentReminderHours: 48, cancellationHours: 12, waitlistOfferHours: 12,
  };
  const db = await openDb({ file: ':memory:' });
  const mailer = { send: async () => {} };
  const now = () => clock;
  const service = createBookingService({ db, config, mailer, now });
  const accounts = createAccountService({ db, config, mailer, now });
  await service.seedTemplates();
  await service.syncSessions();
  const storage = localStorage(dir);
  const server = http.createServer(createApp({ config, service, accounts, storage }));
  const base = await listen(server);
  try {
    const signup = await fetch(`${base}/api/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'sara@example.com', name: 'Sara', phone: '0500000000', activityLevel: 'Very active', password: 'password123' }),
    });
    assert.equal(signup.status, 200);
    const cookie = signup.headers.get('set-cookie').split(';')[0];
    const sessions = await (await fetch(`${base}/api/sessions`, { headers: { cookie } })).json();
    const book = await (await fetch(`${base}/api/bookings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ sessionIds: [sessions[0].id] }),
    })).json();
    assert.equal(book.booked.length, 1);

    const form = new FormData();
    form.append('bookingIds', String(book.booked[0]));
    form.append('receipt', new Blob(['fake-png'], { type: 'image/png' }), 'transfer.png');
    const pay = await fetch(`${base}/api/payments`, { method: 'POST', headers: { cookie }, body: form });
    assert.equal(pay.status, 200);
    const { paymentId } = await pay.json();
    assert.equal(fs.readdirSync(dir).length, 1);

    const auth = { authorization: `Basic ${Buffer.from('admin:admin-pass').toString('base64')}` };
    const file = await fetch(`${base}/api/admin/payments/${paymentId}/receipt`, { headers: auth });
    assert.equal(file.headers.get('content-type'), 'image/png');
    assert.equal(await file.text(), 'fake-png');
    const approve = await fetch(`${base}/api/admin/payments/${paymentId}/approve`, { method: 'POST', headers: auth });
    assert.equal(approve.status, 200);
    const me = await (await fetch(`${base}/api/me`, { headers: { cookie } })).json();
    assert.equal(me.upcoming[0].status, 'confirmed');

    // A receipt for a booking that cannot be paid is not kept.
    const again = new FormData();
    again.append('bookingIds', String(book.booked[0]));
    again.append('receipt', new Blob(['x'], { type: 'image/png' }), 'again.png');
    assert.equal((await fetch(`${base}/api/payments`, { method: 'POST', headers: { cookie }, body: again })).status, 409);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(fs.readdirSync(dir).length, 1);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
