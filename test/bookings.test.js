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
    studio: {
      name: 'Test Studio', instructor: 'Basma', timezone: 'UTC', currency: 'usd', weeksAhead: 1,
      bankTransfer: { enabled: true, instructions: 'IBAN SA00 TEST' },
    },
    classes: [{ key: 'mon-1800', title: 'Mat Pilates', weekday: 1, time: '18:00', durationMinutes: 60, capacity, price, description: '', location: '' }],
    waitlistOfferHours: 2,
    transferHoldHours: 6,
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
    person: (n, extra = {}) => ({ name: `Person ${n}`, email: `p${n}@example.com`, phone: '+966 50 000 0000', firstTime: 'no', ...extra }),
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
  await assert.rejects(service.startBooking(sessionId, person(5, { email: 'nope' })), /valid email/);
  await assert.rejects(service.startBooking(sessionId, person(5, { phone: '' })), /WhatsApp/);
  await assert.rejects(service.startBooking(sessionId, person(5, { firstTime: undefined })), /first time/);
  await bookAndPay(service, sessionId, person(1));
  await assert.rejects(service.startBooking(sessionId, person(1)), /already have a confirmed booking/);
});

test('bank transfer bookings hold the spot until marked paid', async () => {
  const { service, sessionId, person, sent } = setup({ capacity: 1 });
  const { bookingToken } = await service.startBooking(sessionId, person(1, { paymentMethod: 'transfer' }));
  const view = service.bookingView(bookingToken);
  assert.equal(view.status, 'pending');
  assert.equal(view.transferInstructions, 'IBAN SA00 TEST');
  assert.ok(sent.some((m) => m.to === 'p1@example.com' && /IBAN SA00 TEST/.test(m.text)));
  await assert.rejects(service.startBooking(sessionId, person(2)), (err) => err.full, 'spot is held');

  const id = service.adminSessionDetail(sessionId).bookings[0].id;
  await service.adminMarkPaid(id);
  assert.equal(service.bookingView(bookingToken).status, 'confirmed');
});

test('unpaid bank transfers expire and pass the spot to the waiting list', async () => {
  const { service, sessionId, person, advance, sent } = setup({ capacity: 1 });
  const { bookingToken } = await service.startBooking(sessionId, person(1, { paymentMethod: 'transfer' }));
  const w2 = service.joinWaitlist(sessionId, person(2));
  advance(6 * HOUR + 1);
  await service.sweep();
  assert.equal(service.bookingView(bookingToken).status, 'expired');
  assert.ok(sent.some((m) => m.to === 'p1@example.com' && /Reservation expired/.test(m.subject)));
  assert.equal(service.waitlistView(w2.token).status, 'offered');

  // Waitlisted person claims by transfer.
  const claim = await service.claimOffer(w2.token, { paymentMethod: 'transfer' });
  assert.equal(service.bookingView(claim.bookingToken).status, 'pending');
});

test('a pending transfer can be cancelled by the customer at any time before class', async () => {
  const { service, sessionId, person, advance } = setup({ capacity: 1 });
  const { bookingToken } = await service.startBooking(sessionId, person(1, { paymentMethod: 'transfer' }));
  advance(3 * HOUR); // inside the 12h window, but nothing was paid
  assert.equal(service.bookingView(bookingToken).canCancel, true);
  assert.equal((await service.cancelByCustomer(bookingToken)).status, 'cancelled');
});

test('formats class times like the old form', () => {
  const { formatClassTime } = require('../src/format');
  assert.equal(formatClassTime('2026-10-04T19:15', 60), 'Sunday, 4 October 2026, 7:15–8:15 pm');
  assert.equal(formatClassTime('2026-10-06T19:00', 60), 'Tuesday, 6 October 2026, 7–8 pm');
  assert.equal(formatClassTime('2026-10-06T11:30', 60), 'Tuesday, 6 October 2026, 11:30 am–12:30 pm');
});

test('converts studio local time to an instant', () => {
  const { localToEpoch } = require('../src/time');
  assert.equal(localToEpoch('2026-10-04T19:15', 'Asia/Riyadh'), Date.UTC(2026, 9, 4, 16, 15));
  assert.equal(localToEpoch('2026-07-01T09:00', 'Europe/London'), Date.UTC(2026, 6, 1, 8, 0));
});

test('a transfer reservation never holds the spot past the start of class', async () => {
  const { service, sessionId, person, advance } = setup({ capacity: 1 });
  advance(10 * HOUR); // 14:00, class at 18:00, transfer hold is 6h
  const { bookingToken } = await service.startBooking(sessionId, person(1, { paymentMethod: 'transfer' }));
  assert.match(service.bookingView(bookingToken).payBy, /6:00\s?pm/i);
});
