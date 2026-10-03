const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { createDemoPayments } = require('../src/payments');
const { createBookingService } = require('../src/bookings');

const HOUR = 3600_000;

function setup({ capacity = 2, price = 10, refunds } = {}) {
  let clock = Date.UTC(2026, 9, 5, 4, 0); // Monday 5 Oct 2026, 04:00 UTC — class at 18:00
  const config = {
    baseUrl: 'http://test',
    studio: { name: 'Test Studio', instructor: 'Basma', timezone: 'UTC', currency: 'usd', weeksAhead: 1 },
    classes: [{ key: 'mon-1800', title: 'Mat Pilates', weekday: 1, time: '18:00', durationMinutes: 60, capacity, price, description: '', location: '' }],
    waitlistOfferHours: 2,
    cancellationHours: 12,
    refundOnCancel: true,
    checkoutMinutes: 31,
    holdMinutes: 35,
  };
  const payments = createDemoPayments(config);
  if (refunds) payments.refund = async (ref) => refunds.push(ref);
  const sent = [];
  const mailer = { send: async (m) => sent.push(m) };
  const db = openDb(':memory:');
  const service = createBookingService({ db, config, payments, mailer, now: () => clock });
  service.syncSessions();
  const sessionId = service.listUpcoming()[0].id;
  return {
    service, sent, sessionId,
    advance: (ms) => (clock += ms),
    person: (n) => ({ name: `Person ${n}`, email: `p${n}@example.com` }),
  };
}

async function bookAndPay(service, sessionId, customer) {
  const { bookingToken } = await service.startBooking(sessionId, customer);
  await service.demoPay(bookingToken);
  return bookingToken;
}

test('generates sessions from the weekly timetable', () => {
  const { service } = setup();
  const sessions = service.listUpcoming();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].startsAt, '2026-10-05T18:00');
  assert.equal(sessions[0].price, '$10');
  service.syncSessions();
  assert.equal(service.listUpcoming().length, 1, 'sync is idempotent');
});

test('books until full, then refuses and allows the waiting list', async () => {
  const { service, sessionId, person, sent } = setup({ capacity: 2 });
  await bookAndPay(service, sessionId, person(1));
  await bookAndPay(service, sessionId, person(2));
  assert.equal(service.listUpcoming()[0].full, true);
  assert.ok(sent.some((m) => m.to === 'p1@example.com' && /confirmed/.test(m.subject)));

  await assert.rejects(service.startBooking(sessionId, person(3)), (err) => err.full === true);
  assert.deepEqual(service.joinWaitlist(sessionId, person(3)).position, 1);
  assert.deepEqual(service.joinWaitlist(sessionId, person(4)).position, 2);
  assert.throws(() => service.joinWaitlist(sessionId, person(3)), /already on the waiting list/);
});

test('cannot join the waiting list while spots are free', () => {
  const { service, sessionId, person } = setup({ capacity: 2 });
  assert.throws(() => service.joinWaitlist(sessionId, person(1)), (err) => err.available === true);
});

test('unpaid seat holds expire and are released', async () => {
  const { service, sessionId, person, advance } = setup({ capacity: 1 });
  const { bookingToken } = await service.startBooking(sessionId, person(1));
  await assert.rejects(service.startBooking(sessionId, person(2)), (err) => err.full);
  advance(36 * 60_000);
  await service.sweep();
  assert.equal(service.bookingView(bookingToken).status, 'expired');
  await bookAndPay(service, sessionId, person(2));
});

test('a cancellation offers the spot to the waiting list, in order', async () => {
  const refunds = [];
  const { service, sessionId, person, sent, advance } = setup({ capacity: 1, refunds });
  const t1 = await bookAndPay(service, sessionId, person(1));
  const w2 = service.joinWaitlist(sessionId, person(2));
  const w3 = service.joinWaitlist(sessionId, person(3));

  const view = await service.cancelByCustomer(t1);
  assert.equal(view.status, 'cancelled');
  assert.equal(refunds.length, 1, 'payment refunded');
  assert.equal(service.waitlistView(w2.token).status, 'offered');
  assert.equal(service.waitlistView(w3.token).status, 'waiting');
  assert.ok(sent.some((m) => m.to === 'p2@example.com' && /spot opened up/.test(m.subject)));

  // The held spot is not available to the public.
  await assert.rejects(service.startBooking(sessionId, person(9)), (err) => err.full);

  // Person 2 lets the offer lapse; it moves to person 3.
  advance(2 * HOUR + 1);
  await service.sweep();
  assert.equal(service.waitlistView(w2.token).status, 'expired');
  assert.equal(service.waitlistView(w3.token).status, 'offered');

  // Person 3 claims and pays.
  const { bookingToken } = await service.claimOffer(w3.token);
  await service.demoPay(bookingToken);
  assert.equal(service.bookingView(bookingToken).status, 'confirmed');
  assert.equal(service.waitlistView(w3.token).status, 'booked');
  assert.equal(service.listUpcoming()[0].spotsLeft, 0);
});

test('an abandoned waitlist checkout keeps the offer open while it is valid', async () => {
  const { service, sessionId, person, advance } = setup({ capacity: 1 });
  const t1 = await bookAndPay(service, sessionId, person(1));
  const w2 = service.joinWaitlist(sessionId, person(2));
  await service.cancelByCustomer(t1);

  await service.claimOffer(w2.token); // starts checkout, never pays
  advance(40 * 60_000);
  await service.sweep();
  assert.equal(service.waitlistView(w2.token).status, 'offered');
  const { bookingToken } = await service.claimOffer(w2.token);
  await service.demoPay(bookingToken);
  assert.equal(service.waitlistView(w2.token).status, 'booked');
});

test('leaving the waiting list with an open offer passes it on', async () => {
  const { service, sessionId, person } = setup({ capacity: 1 });
  const t1 = await bookAndPay(service, sessionId, person(1));
  const w2 = service.joinWaitlist(sessionId, person(2));
  const w3 = service.joinWaitlist(sessionId, person(3));
  await service.cancelByCustomer(t1);
  service.leaveWaitlist(w2.token);
  assert.equal(service.waitlistView(w3.token).status, 'offered');
});

test('online cancellation closes before class', async () => {
  const { service, sessionId, person, advance } = setup({ capacity: 1 });
  const t1 = await bookAndPay(service, sessionId, person(1));
  advance(3 * HOUR); // 07:00 — inside the 12h window
  assert.equal(service.bookingView(t1).canCancel, false);
  await assert.rejects(service.cancelByCustomer(t1), /closes 12 hours/);
});

test('raising capacity offers new spots to the waiting list', async () => {
  const { service, sessionId, person } = setup({ capacity: 1 });
  await bookAndPay(service, sessionId, person(1));
  const w2 = service.joinWaitlist(sessionId, person(2));
  service.adminSetCapacity(sessionId, 2);
  assert.equal(service.waitlistView(w2.token).status, 'offered');
});

test('cancelling a class refunds everyone and clears the waiting list', async () => {
  const refunds = [];
  const { service, sessionId, person } = setup({ capacity: 1, refunds });
  const t1 = await bookAndPay(service, sessionId, person(1));
  const w2 = service.joinWaitlist(sessionId, person(2));
  const r = await service.adminCancelSession(sessionId, { reason: 'instructor unwell' });
  assert.equal(r.cancelledBookings, 1);
  assert.equal(refunds.length, 1);
  assert.equal(service.bookingView(t1).status, 'cancelled');
  assert.equal(service.waitlistView(w2.token).status, 'removed');
});

test('free classes are confirmed without payment', async () => {
  const { service, sessionId, person } = setup({ price: 0 });
  const { bookingToken } = await service.startBooking(sessionId, person(1));
  assert.equal(service.bookingView(bookingToken).status, 'confirmed');
});

test('rejects invalid details and duplicate bookings', async () => {
  const { service, sessionId, person } = setup({ capacity: 3 });
  await assert.rejects(service.startBooking(sessionId, { name: 'X', email: 'nope' }), /valid email/);
  await bookAndPay(service, sessionId, person(1));
  await assert.rejects(service.startBooking(sessionId, person(1)), /already have a confirmed booking/);
});
