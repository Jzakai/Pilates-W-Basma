const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { createBookingService } = require('../src/bookings');
const { createAccountService } = require('../src/accounts');

// Runs against SQLite in memory, or against Postgres when TEST_DATABASE_URL is set
// (that database is wiped before every test, so never point it at real data).
const PG_URL = process.env.TEST_DATABASE_URL || '';
const open = [];
test.after(() => Promise.all(open.map((db) => db.close())));

async function freshDb() {
  if (!PG_URL) return openDb({ file: ':memory:' });
  const pg = require('pg');
  const client = new pg.Client({ connectionString: PG_URL });
  await client.connect();
  await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await client.end();
  const db = await openDb({ url: PG_URL });
  open.push(db);
  return db;
}

const HOUR = 3600_000;
// Intl currency formatting uses a non-breaking space.
const sp = (s) => String(s).replace(/\s/g, ' ');
const DAY = 24 * HOUR;
const receipt = { key: 'r.png', originalname: 'receipt.png', mimetype: 'image/png' };

// Clock starts Monday 5 Oct 2026, 08:00 UTC. The weekly class is on Thursdays at 18:00 UTC,
// so the first one (8 Oct) is 3 days 10 hours away: open for booking.
async function setup({ capacity = 2, price = 30 } = {}) {
  let clock = Date.UTC(2026, 9, 5, 8, 0);
  const config = {
    baseUrl: 'http://test',
    studio: { name: 'Test Studio', instructor: 'Basma', timezone: 'UTC', currency: 'sar', weeksAhead: 1, location: 'Studio', paymentInstructions: 'IBAN SA00' },
    classes: [{ key: 'thu', title: 'Pilates', weekday: 4, time: '18:00', durationMinutes: 60, capacity, price, description: '' }],
    bookingCutoffHours: 48,
    paymentDeadlineHours: 24,
    paymentReminderHours: 48,
    cancellationHours: 12,
    waitlistOfferHours: 12,
  };
  const sent = [];
  const mailer = { send: async (m) => sent.push(m) };
  const db = await freshDb();
  const now = () => clock;
  const service = createBookingService({ db, config, mailer, now });
  const accounts = createAccountService({ db, config, mailer, now });
  await service.seedTemplates();
  await service.syncSessions();
  let n = 0;
  const signUp = async () => {
    n++;
    const r = await accounts.signUp({ email: `p${n}@example.com`, name: `Person ${n}`, phone: '+966 50 000 0000', activityLevel: 'Very active', password: 'password123' });
    return r.user;
  };
  const sessionId = (await service.listUpcoming())[0].id;
  return { service, accounts, db, config, sent, sessionId, signUp, advance: (ms) => (clock += ms) };
}

async function bookAndPay(service, user, sessionId) {
  const { booked } = await service.bookClasses(user, [sessionId]);
  await service.payBookings(user, { bookingIds: booked, file: receipt });
  const pending = await service.adminPayments();
  await service.approvePayment(pending.at(-1).id);
  return booked[0];
}

async function statusOf(service, user, id) {
  const me = await service.myAccount(user);
  return me.upcoming.concat(me.history).find((b) => b.id === id)?.status;
}

test('sign up validates details and signs in', async () => {
  const { accounts } = await setup();
  await assert.rejects(accounts.signUp({ email: 'bad', name: 'A', phone: '0500000000', activityLevel: 'Very active', password: 'password123' }), /valid email/);
  await assert.rejects(accounts.signUp({ email: 'a@b.co', name: 'A', phone: '0500000000', activityLevel: 'x', password: 'password123' }), /activity level/);
  await assert.rejects(accounts.signUp({ email: 'a@b.co', name: 'A', phone: '0500000000', activityLevel: 'Very active', password: 'short' }), /8 characters/);
  const { user, token } = await accounts.signUp({ email: 'A@B.co', name: 'A', phone: '0500000000', injuries: 'knee', activityLevel: 'Very active', password: 'password123' });
  assert.equal(user.email, 'a@b.co');
  assert.equal((await accounts.userFromToken(token)).id, user.id);
  await assert.rejects(accounts.signIn({ email: 'a@b.co', password: 'wrong-password' }), /incorrect/);
  assert.ok((await accounts.signIn({ email: 'a@b.co', password: 'password123' })).token);
  await assert.rejects(accounts.signUp({ email: 'a@b.co', name: 'A', phone: '0500000000', activityLevel: 'Very active', password: 'password123' }), /already exists/);
});

test('password reset by emailed link', async () => {
  const { accounts, sent, signUp } = await setup();
  const u = await signUp();
  await accounts.requestPasswordReset(u.email);
  const token = sent.at(-1).text.match(/token=([\w-]+)/)[1];
  await accounts.resetPassword(token, 'new-password-1');
  assert.ok((await accounts.signIn({ email: u.email, password: 'new-password-1' })).token);
  await assert.rejects(accounts.resetPassword(token, 'another-pass'), /expired/);
});

test('books several classes at once and closes booking 48h before class', async () => {
  const { service, signUp, advance } = await setup();
  const u = await signUp();
  const ids = (await service.listUpcoming()).map((s) => s.id);
  // weeksAhead 1 → only one Thursday; add a one-off class to book two at once.
  await service.addOneOffClass({ title: 'Extra', date: '2026-10-09', time: '10:00', durationMinutes: 60, capacity: 5, price: 30 });
  const all = (await service.listUpcoming()).map((s) => s.id);
  const r = await service.bookClasses(u, all);
  assert.equal(r.booked.length, 2);
  assert.equal((await service.myAccount(u)).upcoming.every((b) => b.status === 'awaiting_payment'), true);

  advance(DAY + 11 * HOUR); // Tue 19:00 → Thursday class is 47h away
  const v = await signUp();
  const r2 = await service.bookClasses(v, ids);
  assert.equal(r2.booked.length, 0);
  assert.match(r2.failed[0].error, /closes 48 hours/);
});

test('pays with a receipt, instructor approves, client gets calendar invite', async () => {
  const { service, signUp, sessionId, sent } = await setup();
  const u = await signUp();
  const { booked } = await service.bookClasses(u, [sessionId]);
  await assert.rejects(service.payBookings(u, { bookingIds: booked }), /attach your bank transfer receipt/);
  await service.payBookings(u, { bookingIds: booked, file: receipt });
  assert.equal(await statusOf(service, u, booked[0]), 'payment_review');
  const [p] = await service.adminPayments();
  assert.equal(sp(p.amount), 'SAR 30');
  await service.approvePayment(p.id);
  assert.equal(await statusOf(service, u, booked[0]), 'confirmed');
  const confirmation = sent.find((m) => /Booking confirmed/.test(m.subject));
  assert.match(confirmation.icalEvent.content, /BEGIN:VEVENT/);
  assert.match(await service.bookingCalendar(u, booked[0]), /DTSTART:20261008T180000Z/);
});

test('rejected receipt puts the booking back to awaiting payment', async () => {
  const { service, signUp, sessionId, sent } = await setup();
  const u = await signUp();
  const { booked } = await service.bookClasses(u, [sessionId]);
  await service.payBookings(u, { bookingIds: booked, file: receipt });
  await service.rejectPayment((await service.adminPayments())[0].id, 'amount does not match');
  assert.equal(await statusOf(service, u, booked[0]), 'awaiting_payment');
  assert.ok(sent.some((m) => /amount does not match/.test(m.text)));
});

test('unpaid bookings get a reminder, then are released at the payment deadline', async () => {
  const { service, signUp, sessionId, sent, advance } = await setup();
  const u = await signUp();
  const { booked } = await service.bookClasses(u, [sessionId]);
  advance(DAY + 11 * HOUR); // 47h before class
  await service.sweep();
  assert.ok(sent.some((m) => /Reminder: payment needed/.test(m.subject)));
  advance(DAY); // 23h before class
  await service.sweep();
  assert.equal(await statusOf(service, u, booked[0]), 'cancelled');
  assert.ok(sent.some((m) => /released/.test(m.text)));
});

test('client cancels a paid class in time and receives credit, then pays with it', async () => {
  const { service, signUp, sessionId } = await setup();
  const u = await signUp();
  const id = await bookAndPay(service, u, sessionId);
  await service.cancelByUser(u, id);
  assert.equal(sp((await service.myAccount(u)).credit), 'SAR 30');
  const { booked } = await service.bookClasses(u, [sessionId]);
  const r = await service.payBookings(u, { bookingIds: booked, useCredits: true });
  assert.deepEqual(r.byCredit, booked);
  assert.equal(sp((await service.myAccount(u)).credit), 'SAR 0');
  assert.equal(await statusOf(service, u, booked[0]), 'confirmed');
});

test('online cancellation closes 12 hours before class', async () => {
  const { service, signUp, sessionId, advance } = await setup();
  const u = await signUp();
  const id = await bookAndPay(service, u, sessionId);
  advance(3 * DAY); // Thu 08:00, class at 18:00
  await assert.rejects(service.cancelByUser(u, id), /closes 12 hours/);
});

test('cancelling a class turns payments into credit, including receipts still under review', async () => {
  const { service, signUp, sessionId } = await setup({ capacity: 3 });
  const paid = await signUp();
  const reviewing = await signUp();
  const unpaid = await signUp();
  await bookAndPay(service, paid, sessionId);
  const { booked } = await service.bookClasses(reviewing, [sessionId]);
  await service.payBookings(reviewing, { bookingIds: booked, file: receipt });
  await service.bookClasses(unpaid, [sessionId]);

  await service.adminCancelClass(sessionId, { reason: 'instructor unwell' });
  assert.equal(sp((await service.myAccount(paid)).credit), 'SAR 30');
  assert.equal(sp((await service.myAccount(unpaid)).credit), 'SAR 0');
  assert.equal(sp((await service.myAccount(reviewing)).credit), 'SAR 0');
  await service.approvePayment((await service.adminPayments())[0].id);
  assert.equal(sp((await service.myAccount(reviewing)).credit), 'SAR 30');
});

test('waitlist: full class, cancellation offers the spot, claim creates a booking to pay', async () => {
  const { service, signUp, sessionId, advance } = await setup({ capacity: 1 });
  const a = await signUp();
  const b = await signUp();
  const c = await signUp();
  const id = await bookAndPay(service, a, sessionId);
  const r = await service.bookClasses(b, [sessionId]);
  assert.equal(r.failed[0].full, true);
  const wb = await service.joinWaitlist(b, sessionId);
  await service.joinWaitlist(c, sessionId);
  await service.cancelByUser(a, id);
  assert.equal((await service.myAccount(b)).waitlist[0].status, 'offered');
  assert.equal((await service.myAccount(c)).waitlist[0].status, 'waiting');

  advance(12 * HOUR + 1); // b lets the offer lapse
  await service.sweep();
  assert.equal((await service.myAccount(c)).waitlist[0].status, 'offered');
  const wc = (await service.myAccount(c)).waitlist[0].id;
  const { bookingId } = await service.claimOffer(c, wc);
  assert.equal(await statusOf(service, c, bookingId), 'awaiting_payment');
  await assert.rejects(service.claimOffer(b, wb.id), /no longer available/);
});

test('instructor manages weekly classes and one-off classes', async () => {
  const { service } = await setup();
  await service.addTemplate({ title: 'Reformer', weekday: 3, time: '09:00', durationMinutes: 50, capacity: 6, price: 45 });
  assert.ok((await service.listUpcoming()).some((s) => s.title === 'Reformer' && s.startsAt === '2026-10-07T09:00' && sp(s.price) === 'SAR 45'));
  const t = (await service.listTemplates()).find((x) => x.title === 'Reformer');
  await service.editTemplate(t.id, { ...t, time: '10:00' });
  assert.ok((await service.listUpcoming()).some((s) => s.title === 'Reformer' && s.startsAt === '2026-10-07T10:00'));
  await service.editTemplate(t.id, { ...t, time: '10:00', active: false });
  assert.ok(!(await service.listUpcoming()).some((s) => s.title === 'Reformer'));
  await assert.rejects(service.addOneOffClass({ title: 'Past', date: '2026-10-01', time: '10:00', durationMinutes: 60, capacity: 5, price: 30 }), /past/);
});

test('free classes are confirmed without payment', async () => {
  const { service, signUp, sessionId } = await setup({ price: 0 });
  const u = await signUp();
  const { booked } = await service.bookClasses(u, [sessionId]);
  assert.equal(await statusOf(service, u, booked[0]), 'confirmed');
});

test('formats class times like the old form', async () => {
  const { formatClassTime } = require('../src/format');
  assert.equal(formatClassTime('2026-10-04T19:15', 60), 'Sunday, 4 October 2026, 7:15–8:15 pm');
  assert.equal(formatClassTime('2026-10-06T19:00', 60), 'Tuesday, 6 October 2026, 7–8 pm');
});

test('converts studio local time to an instant', async () => {
  const { localToEpoch } = require('../src/time');
  assert.equal(localToEpoch('2026-10-04T19:15', 'Asia/Riyadh'), Date.UTC(2026, 9, 4, 16, 15));
});

test('instructor sees the list of clients with their bookings and credit', async () => {
  const { service, signUp, sessionId } = await setup();
  const a = await signUp();
  const b = await signUp();
  await bookAndPay(service, a, sessionId);
  const all = await service.adminClients();
  assert.equal(all.length, 2);
  const row = all.find((c) => c.id === a.id);
  assert.equal(row.upcoming, 1);
  assert.equal(row.paid_classes, 1);
  assert.equal(row.activity_level, 'Very active');
  assert.deepEqual((await service.adminClients(b.email)).map((c) => c.id), [b.id]);
  assert.equal((await service.adminClientDetail(a.id)).bookings[0].status, 'confirmed');
});

test('two people booking the last spot at the same moment: only one gets it', async () => {
  const { service, signUp, sessionId } = await setup({ capacity: 1 });
  const people = await Promise.all([signUp(), signUp(), signUp(), signUp()]);
  const results = await Promise.all(people.map((p) => service.bookClasses(p, [sessionId])));
  assert.equal(results.filter((r) => r.booked.length === 1).length, 1);
  assert.equal(results.filter((r) => r.failed[0]?.full).length, 3);
});

test('credit cannot be spent twice by paying in two tabs at once', async () => {
  const { service, signUp, sessionId } = await setup({ capacity: 3 });
  const u = await signUp();
  const id = await bookAndPay(service, u, sessionId);
  await service.cancelByUser(u, id); // 30 SAR credit
  await service.addOneOffClass({ title: 'Extra', date: '2026-10-09', time: '10:00', durationMinutes: 60, capacity: 5, price: 30 });
  const ids = (await service.listUpcoming()).map((s) => s.id);
  const { booked } = await service.bookClasses(u, ids);
  assert.equal(booked.length, 2);
  const results = await Promise.allSettled(booked.map((b) => service.payBookings(u, { bookingIds: [b], useCredits: true })));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(sp((await service.myAccount(u)).credit), 'SAR 0');
});
