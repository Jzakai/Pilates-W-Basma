const crypto = require('node:crypto');
const { transaction } = require('./db');
const { localString, localToEpoch, upcomingDates } = require('./time');
const { toMinor, formatMoney, formatClassTime } = require('./format');

class BookingError extends Error {
  constructor(message, status = 400, extra = {}) {
    super(message);
    this.status = status;
    Object.assign(this, extra);
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// strict = the public booking / waiting-list forms, where phone and "first time?" are required.
function cleanCustomer(input = {}, { strict = true } = {}) {
  const name = String(input.name || '').trim().slice(0, 100);
  const email = String(input.email || '').trim().toLowerCase().slice(0, 200);
  const phone = String(input.phone || '').trim().slice(0, 40);
  const notes = String(input.notes || '').trim().slice(0, 500);
  const firstTime = ['yes', 'no'].includes(input.firstTime) ? input.firstTime : '';
  if (!name) throw new BookingError('Please enter your name.');
  if (!EMAIL_RE.test(email)) throw new BookingError('Please enter a valid email address.');
  if (strict && !/^\+?[\d\s()-]{7,}$/.test(phone)) throw new BookingError('Please enter your phone / WhatsApp number.');
  if (strict && !firstTime) throw new BookingError('Please tell us if this is your first time doing Pilates.');
  return { name, email, phone, notes, firstTime };
}

const newToken = () => crypto.randomBytes(24).toString('base64url');

function createBookingService({ db, config, payments, mailer, now = () => Date.now() }) {
  const tz = config.studio.timezone;
  const nowLocal = () => localString(now(), tz);
  const localIn = (hours) => localString(now() + hours * 3600_000, tz);

  const q = {
    session: db.prepare('SELECT * FROM class_sessions WHERE id = ?'),
    booking: db.prepare('SELECT * FROM bookings WHERE id = ?'),
    bookingByToken: db.prepare('SELECT * FROM bookings WHERE token = ?'),
    bookingByCheckout: db.prepare('SELECT * FROM bookings WHERE checkout_id = ?'),
    waitlistById: db.prepare('SELECT * FROM waitlist WHERE id = ?'),
    waitlistByToken: db.prepare('SELECT * FROM waitlist WHERE token = ?'),
    seatsTaken: db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM bookings WHERE session_id = :id
           AND (status = 'confirmed' OR (status = 'pending' AND hold_expires_at > :now)))
      + (SELECT COUNT(*) FROM waitlist WHERE session_id = :id
           AND status = 'offered' AND offer_expires_at > :now) AS taken`),
    waitingCount: db.prepare(`SELECT COUNT(*) AS n FROM waitlist WHERE session_id = ? AND status IN ('waiting', 'offered', 'claiming')`),
    nextWaiting: db.prepare(`SELECT * FROM waitlist WHERE session_id = ? AND status = 'waiting' ORDER BY id LIMIT 1`),
  };

  // ---------------------------------------------------------------- helpers

  function getSession(id) {
    const s = q.session.get(id);
    if (!s) throw new BookingError('Class not found.', 404);
    return s;
  }

  function seatsLeft(session) {
    const { taken } = q.seatsTaken.get({ id: session.id, now: now() });
    return Math.max(0, session.capacity - taken);
  }

  function isBookable(session) {
    return !session.cancelled && session.starts_at > nowLocal();
  }

  function describe(session) {
    return `${session.title}\n${formatClassTime(session.starts_at, session.duration_min)}` +
      (session.location ? `\n${session.location}` : '');
  }

  function publicSession(s) {
    const left = seatsLeft(s);
    return {
      id: s.id,
      title: s.title,
      description: s.description,
      location: s.location,
      startsAt: s.starts_at,
      durationMinutes: s.duration_min,
      capacity: s.capacity,
      spotsLeft: left,
      full: left === 0,
      waitlistCount: q.waitingCount.get(s.id).n,
      price: formatMoney(s.price_minor, s.currency),
      cancelled: Boolean(s.cancelled),
    };
  }

  const manageUrl = (b) => `${config.baseUrl}/booking.html?token=${b.token}`;
  const claimUrl = (w) => `${config.baseUrl}/waitlist.html?token=${w.token}`;
  const sign = `\n\nSee you on the mat,\n${config.studio.instructor || config.studio.name}`;

  // -------------------------------------------------------------- schedule

  // Creates class sessions for the coming weeks from the weekly timetable.
  // Existing sessions are left alone, so edits to the timetable only affect new dates.
  function syncSessions() {
    const insert = db.prepare(`
      INSERT OR IGNORE INTO class_sessions
        (class_key, title, description, location, starts_at, duration_min, capacity, price_minor, currency, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const dates = upcomingDates(now(), tz, config.studio.weeksAhead * 7);
    const current = nowLocal();
    let created = 0;
    transaction(db, () => {
      for (const { date, weekday } of dates) {
        for (const c of config.classes) {
          if (c.weekday !== weekday) continue;
          const startsAt = `${date}T${c.time}`;
          if (startsAt <= current) continue;
          const r = insert.run(c.key, c.title, c.description, c.location, startsAt, c.durationMinutes,
            c.capacity, toMinor(c.price, config.studio.currency), config.studio.currency, now());
          created += Number(r.changes);
        }
      }
    });
    return created;
  }

  function listUpcoming() {
    return db
      .prepare('SELECT * FROM class_sessions WHERE starts_at > ? ORDER BY starts_at, id')
      .all(nowLocal())
      .map(publicSession);
  }

  // ---------------------------------------------------------------- booking

  // Reserves a seat and returns where to send the customer to pay.
  const transferEnabled = () => config.studio.bankTransfer.enabled;

  async function startBooking(sessionId, input, { waitlistEntry = null, strict = true } = {}) {
    const customer = cleanCustomer(input, { strict });
    const byTransfer = input.paymentMethod === 'transfer';
    if (byTransfer && !transferEnabled()) throw new BookingError('Bank transfer is not available — please pay online.');
    let session;
    const booking = transaction(db, () => {
      session = getSession(sessionId);
      if (!isBookable(session)) throw new BookingError('This class is no longer open for booking.', 409);

      const existing = db.prepare(`
        SELECT * FROM bookings WHERE session_id = ? AND email = ? AND status IN ('pending', 'confirmed')`)
        .all(session.id, customer.email);
      if (existing.some((b) => b.status === 'confirmed')) {
        throw new BookingError('You already have a confirmed booking for this class.', 409);
      }
      // An abandoned checkout from the same person: release it so they can start again.
      for (const b of existing) releaseBooking(b, 'expired', { notify: false, refill: false });

      if (!waitlistEntry && seatsLeft(session) === 0) {
        throw new BookingError('Sorry, this class is fully booked.', 409, { full: true });
      }

      const amount = session.price_minor;
      const provider = amount === 0 ? 'free' : byTransfer ? 'transfer' : payments.name;
      const token = newToken();
      // A transfer reservation lasts transferHoldHours, but never past the start of class.
      const holdUntil = provider === 'transfer'
        ? Math.min(now() + config.transferHoldHours * 3600_000, localToEpoch(session.starts_at, tz))
        : now() + config.holdMinutes * 60_000;
      const r = db.prepare(`
        INSERT INTO bookings (session_id, name, email, phone, first_time, notes, status, token, amount_minor, currency,
                              hold_expires_at, payment_provider, waitlist_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)`)
        .run(session.id, customer.name, customer.email, customer.phone, customer.firstTime, customer.notes, token, amount,
          session.currency, holdUntil, provider, waitlistEntry?.id ?? null, now());
      if (waitlistEntry) {
        // The offered seat is now held by the pending booking instead.
        db.prepare(`UPDATE waitlist SET status = 'claiming' WHERE id = ?`).run(waitlistEntry.id);
      }
      return q.booking.get(r.lastInsertRowid);
    });

    if (booking.payment_provider === 'free') {
      await confirmBooking(booking.id, null);
      return { bookingToken: booking.token, redirectUrl: manageUrl(booking) + '&new=1' };
    }

    if (booking.payment_provider === 'transfer') {
      await sendTransferInstructions(booking, session);
      return { bookingToken: booking.token, redirectUrl: manageUrl(booking) + '&new=1' };
    }

    try {
      const checkout = await payments.createCheckout({
        booking,
        session,
        successUrl: `${config.baseUrl}/booking.html?token=${booking.token}&new=1`,
        cancelUrl: `${config.baseUrl}/booking.html?token=${booking.token}&cancelled_checkout=1`,
        expiresAtMs: now() + config.checkoutMinutes * 60_000,
      });
      db.prepare('UPDATE bookings SET checkout_id = ? WHERE id = ?').run(checkout.id, booking.id);
      return { bookingToken: booking.token, redirectUrl: checkout.url };
    } catch (err) {
      console.error('Could not create checkout:', err.message);
      releaseBooking(q.booking.get(booking.id), 'expired', { notify: false });
      throw new BookingError('We could not start the payment. Please try again in a moment.', 502);
    }
  }

  const formatDeadline = (ms) => new Date(ms).toLocaleString('en-GB', {
    timeZone: tz, weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit', hour12: true,
  });

  async function sendTransferInstructions(b, s) {
    const deadline = formatDeadline(b.hold_expires_at);
    await mailer.send({
      to: b.email,
      subject: `Spot reserved — payment needed: ${s.title}, ${formatClassTime(s.starts_at)}`,
      text: `Hi ${b.name},\n\nYour spot is reserved for:\n\n${describe(s)}\n\n` +
        `To confirm it, please send ${formatMoney(b.amount_minor, b.currency)} by ${deadline}:\n\n` +
        `${config.studio.bankTransfer.instructions}\n\n` +
        `If payment isn't received by then, the spot will be released to the next person.\n` +
        `View or cancel your booking: ${manageUrl(b)}` + sign,
    });
    if (config.adminNotifyEmail) {
      await mailer.send({
        to: config.adminNotifyEmail,
        subject: `Awaiting transfer: ${b.name}, ${s.title} ${formatClassTime(s.starts_at)}`,
        text: `${b.name} (${b.phone}, ${b.email}) reserved a spot and will pay by bank transfer / STC Pay.\n` +
          `Mark it as paid in the dashboard once the money arrives: ${config.baseUrl}/admin`,
      });
    }
  }

  async function confirmBooking(bookingId, paymentRef) {
    const result = transaction(db, () => {
      const b = q.booking.get(bookingId);
      if (!b) throw new BookingError('Booking not found.', 404);
      if (b.status === 'confirmed') return { booking: b, changed: false };
      // A payment that lands after the hold lapsed is still honoured — the customer paid.
      db.prepare(`UPDATE bookings SET status = 'confirmed', payment_ref = COALESCE(?, payment_ref),
                  confirmed_at = ?, hold_expires_at = NULL WHERE id = ?`).run(paymentRef, now(), b.id);
      if (b.waitlist_id) db.prepare(`UPDATE waitlist SET status = 'booked' WHERE id = ?`).run(b.waitlist_id);
      return { booking: q.booking.get(b.id), changed: true };
    });

    if (result.changed) {
      const b = result.booking;
      const s = getSession(b.session_id);
      await mailer.send({
        to: b.email,
        subject: `Booking confirmed: ${s.title}, ${formatClassTime(s.starts_at)}`,
        text: `Hi ${b.name},\n\nYour spot is booked!\n\n${describe(s)}\n` +
          (b.amount_minor ? `Paid: ${formatMoney(b.amount_minor, b.currency)}\n` : '') +
          `\nView or cancel your booking: ${manageUrl(b)}` +
          (config.cancellationHours > 0 ? `\n(Online cancellation is available until ${config.cancellationHours} hours before class.)` : '') +
          sign,
      });
      if (config.adminNotifyEmail) {
        await mailer.send({
          to: config.adminNotifyEmail,
          subject: `New booking: ${s.title}, ${formatClassTime(s.starts_at)}`,
          text: `${b.name} (${b.email}${b.phone ? ', ' + b.phone : ''}) booked ${s.title} on ${formatClassTime(s.starts_at)}.` +
            (b.first_time === 'yes' ? '\nFirst time doing Pilates.' : '') +
            (b.notes ? `\nNotes: ${b.notes}` : '') +
            `\nSpots left: ${seatsLeft(s)} of ${s.capacity}.`,
        });
      }
    }
    return result.booking;
  }

  // Called from the Stripe webhook and from the return page.
  async function completeCheckout(checkoutId) {
    const b = q.bookingByCheckout.get(checkoutId);
    if (!b) return null;
    if (b.status === 'confirmed') return b;
    const checkout = await payments.getCheckout(checkoutId);
    if (!checkout.paid) return b;
    return confirmBooking(b.id, checkout.paymentRef);
  }

  async function demoPay(token) {
    if (payments.name !== 'demo') throw new BookingError('Not available.', 404);
    const b = q.bookingByToken.get(token);
    if (!b) throw new BookingError('Booking not found.', 404);
    if (b.status !== 'pending' && b.status !== 'confirmed') {
      throw new BookingError('This booking has expired. Please book again.', 409);
    }
    return confirmBooking(b.id, `demo_${b.id}`);
  }

  // Frees a booking's seat and, unless told otherwise, offers it to the waitlist.
  function releaseBooking(b, status, { notify = true, refill = true } = {}) {
    transaction(db, () => {
      db.prepare(`UPDATE bookings SET status = ?, hold_expires_at = NULL, cancelled_at = ? WHERE id = ?`)
        .run(status, now(), b.id);
      if (b.waitlist_id) {
        // A waitlist claim that was not paid goes back to "offered" if the offer is still valid.
        const w = q.waitlistById.get(b.waitlist_id);
        if (w && w.status === 'claiming') {
          const stillValid = w.offer_expires_at > now() && b.status === 'pending';
          db.prepare('UPDATE waitlist SET status = ? WHERE id = ?').run(stillValid ? 'offered' : 'expired', w.id);
        }
      }
    });
    if (refill) processWaitlist(b.session_id, { notify });
  }

  const awaitingTransfer = (b) => b.status === 'pending' && b.payment_provider === 'transfer' && b.hold_expires_at > now();

  function canCustomerCancel(b, s) {
    if (s.cancelled || s.starts_at <= nowLocal()) return false;
    if (awaitingTransfer(b)) return true; // nothing paid yet, so always free to cancel
    return b.status === 'confirmed' && s.starts_at > localIn(config.cancellationHours);
  }

  function bookingView(token) {
    const b = q.bookingByToken.get(token);
    if (!b) throw new BookingError('Booking not found.', 404);
    const s = getSession(b.session_id);
    return {
      name: b.name,
      email: b.email,
      status: b.status === 'pending' && b.hold_expires_at <= now() ? 'expired' : b.status,
      amount: formatMoney(b.amount_minor, b.currency),
      paymentMethod: b.payment_provider,
      transferInstructions: awaitingTransfer(b) ? config.studio.bankTransfer.instructions : null,
      payBy: awaitingTransfer(b) ? formatDeadline(b.hold_expires_at) : null,
      refunded: Boolean(b.refunded),
      canCancel: canCustomerCancel(b, s),
      cancellationHours: config.cancellationHours,
      refundOnCancel: config.refundOnCancel,
      session: publicSession(s),
    };
  }

  // Customer returning from payment: double-check with the gateway in case the webhook is late.
  async function refreshBooking(token) {
    const b = q.bookingByToken.get(token);
    if (b && b.status === 'pending' && b.checkout_id && payments.name !== 'demo') {
      try {
        await completeCheckout(b.checkout_id);
      } catch (err) {
        console.error('Could not verify checkout:', err.message);
      }
    }
    return bookingView(token);
  }

  async function refundIfPaid(b) {
    if (!b.payment_ref || b.refunded || b.amount_minor === 0 || ['manual', 'transfer'].includes(b.payment_provider)) return false;
    await payments.refund(b.payment_ref);
    db.prepare('UPDATE bookings SET refunded = 1 WHERE id = ?').run(b.id);
    return true;
  }

  async function cancelBooking(b, { refund, byStudio = false, reason = '' }) {
    const s = getSession(b.session_id);
    let refunded = false;
    if (refund) {
      try {
        refunded = await refundIfPaid(b);
      } catch (err) {
        console.error(`Refund failed for booking ${b.id}:`, err.message);
        throw new BookingError('The refund could not be processed, so the booking was not cancelled. Please contact the studio.', 502);
      }
    }
    releaseBooking(b, 'cancelled');
    await mailer.send({
      to: b.email,
      subject: `Booking cancelled: ${s.title}, ${formatClassTime(s.starts_at)}`,
      text: `Hi ${b.name},\n\n` +
        (byStudio ? `Unfortunately your booking has been cancelled by the studio${reason ? `: ${reason}` : '.'}\n\n` : 'Your booking has been cancelled.\n\n') +
        `${describe(s)}\n` +
        (refunded ? `\nA refund of ${formatMoney(b.amount_minor, b.currency)} has been issued — it can take 5–10 days to appear on your statement.\n` : '') +
        (refund && !refunded && b.status === 'confirmed' && b.payment_provider === 'transfer'
          ? `\nAs you paid by transfer, ${config.studio.instructor || 'the studio'} will contact you about your refund.\n` : '') +
        sign,
    });
    if (!byStudio && config.adminNotifyEmail) {
      await mailer.send({
        to: config.adminNotifyEmail,
        subject: `Cancellation: ${b.name}, ${s.title} ${formatClassTime(s.starts_at)}`,
        text: `${b.name} (${b.phone}, ${b.email}) cancelled their booking.` +
          (refunded ? ' They were refunded automatically.' : '') +
          (refund && b.status === 'confirmed' && b.payment_provider === 'transfer' ? ' They paid by transfer — please refund them manually.' : ''),
      });
    }
    return refunded;
  }

  async function cancelByCustomer(token) {
    const b = q.bookingByToken.get(token);
    if (!b) throw new BookingError('Booking not found.', 404);
    const s = getSession(b.session_id);
    if (!canCustomerCancel(b, s)) {
      throw new BookingError(
        `Online cancellation closes ${config.cancellationHours} hours before class. Please contact the studio.`, 409);
    }
    await cancelBooking(b, { refund: config.refundOnCancel && b.status === 'confirmed' });
    return bookingView(token);
  }

  // --------------------------------------------------------------- waitlist

  function joinWaitlist(sessionId, input) {
    const customer = cleanCustomer(input);
    const entry = transaction(db, () => {
      const s = getSession(sessionId);
      if (!isBookable(s)) throw new BookingError('This class is no longer open for booking.', 409);
      if (seatsLeft(s) > 0) throw new BookingError('Good news — a spot is available, you can book it now!', 409, { available: true });
      const dup = db.prepare(`SELECT 1 FROM waitlist WHERE session_id = ? AND email = ? AND status IN ('waiting', 'offered', 'claiming')`)
        .get(s.id, customer.email);
      if (dup) throw new BookingError('You are already on the waiting list for this class.', 409);
      const booked = db.prepare(`SELECT 1 FROM bookings WHERE session_id = ? AND email = ? AND status = 'confirmed'`)
        .get(s.id, customer.email);
      if (booked) throw new BookingError('You already have a booking for this class.', 409);
      const r = db.prepare(`INSERT INTO waitlist (session_id, name, email, phone, first_time, notes, status, token, created_at)
                            VALUES (?, ?, ?, ?, ?, ?, 'waiting', ?, ?)`)
        .run(s.id, customer.name, customer.email, customer.phone, customer.firstTime, customer.notes, newToken(), now());
      return q.waitlistById.get(r.lastInsertRowid);
    });
    const s = getSession(sessionId);
    const position = waitlistPosition(entry);
    mailer.send({
      to: entry.email,
      subject: `You're on the waiting list: ${s.title}, ${formatClassTime(s.starts_at)}`,
      text: `Hi ${entry.name},\n\nYou're number ${position} on the waiting list for:\n\n${describe(s)}\n\n` +
        `If a spot opens up we'll email you a link to claim it. You'll have ${config.waitlistOfferHours} hours to pay and confirm before it goes to the next person.\n\n` +
        `No longer interested? Leave the waiting list here: ${claimUrl(entry)}` + sign,
    });
    return { position, token: entry.token };
  }

  function waitlistPosition(w) {
    return db.prepare(`SELECT COUNT(*) AS n FROM waitlist WHERE session_id = ? AND status IN ('waiting', 'offered', 'claiming') AND id <= ?`)
      .get(w.session_id, w.id).n;
  }

  // Offers free seats to the people at the front of the waiting list.
  function processWaitlist(sessionId, { notify = true } = {}) {
    const offers = transaction(db, () => {
      const s = getSession(sessionId);
      if (!isBookable(s)) return [];
      const made = [];
      let left = seatsLeft(s);
      while (left > 0) {
        const w = q.nextWaiting.get(s.id);
        if (!w) break;
        const expires = now() + config.waitlistOfferHours * 3600_000;
        db.prepare(`UPDATE waitlist SET status = 'offered', offer_expires_at = ? WHERE id = ?`).run(expires, w.id);
        made.push(q.waitlistById.get(w.id));
        left--;
      }
      return made.map((w) => ({ w, s }));
    });
    if (notify) {
      for (const { w, s } of offers) {
        mailer.send({
          to: w.email,
          subject: `A spot opened up: ${s.title}, ${formatClassTime(s.starts_at)}`,
          text: `Hi ${w.name},\n\nGood news — a spot has opened up and it's being held for you:\n\n${describe(s)}\n\n` +
            `Claim it here within ${config.waitlistOfferHours} hours: ${claimUrl(w)}\n\n` +
            `If you don't claim it in time, it will be offered to the next person on the list.` + sign,
        });
      }
    }
    return offers.length;
  }

  function waitlistView(token) {
    const w = q.waitlistByToken.get(token);
    if (!w) throw new BookingError('Waiting list entry not found.', 404);
    const s = getSession(w.session_id);
    let status = w.status === 'claiming' ? 'offered' : w.status;
    if (status === 'offered' && (w.offer_expires_at <= now() || !isBookable(s))) status = 'expired';
    return {
      name: w.name,
      email: w.email,
      status,
      position: ['waiting', 'offered', 'claiming'].includes(status) ? waitlistPosition(w) : null,
      offerExpiresAt: status === 'offered' ? w.offer_expires_at : null,
      session: publicSession(s),
    };
  }

  async function claimOffer(token, { paymentMethod } = {}) {
    const w = q.waitlistByToken.get(token);
    if (!w) throw new BookingError('Waiting list entry not found.', 404);
    if (w.status === 'claiming') {
      // They abandoned an earlier checkout — release it and start a fresh one.
      const pending = db.prepare(`SELECT * FROM bookings WHERE waitlist_id = ? AND status = 'pending'`).get(w.id);
      if (pending) releaseBooking(pending, 'expired', { refill: false });
    }
    const fresh = q.waitlistById.get(w.id);
    if (fresh.status !== 'offered' || fresh.offer_expires_at <= now()) {
      throw new BookingError('Sorry, this offer is no longer available.', 409);
    }
    const customer = { name: fresh.name, email: fresh.email, phone: fresh.phone, firstTime: fresh.first_time, notes: fresh.notes, paymentMethod };
    return startBooking(fresh.session_id, customer, { waitlistEntry: fresh, strict: false });
  }

  function leaveWaitlist(token) {
    const w = q.waitlistByToken.get(token);
    if (!w) throw new BookingError('Waiting list entry not found.', 404);
    if (!['waiting', 'offered'].includes(w.status)) throw new BookingError('You are not on the waiting list any more.', 409);
    db.prepare(`UPDATE waitlist SET status = 'removed' WHERE id = ?`).run(w.id);
    if (w.status === 'offered') processWaitlist(w.session_id);
    return waitlistView(token);
  }

  // ------------------------------------------------------------ maintenance

  // Expires unpaid holds and unclaimed offers, passing seats down the waiting list.
  async function sweep() {
    const stale = db.prepare(`SELECT * FROM bookings WHERE status = 'pending' AND hold_expires_at <= ?`).all(now());
    for (const b of stale) {
      if (b.checkout_id && payments.name !== 'demo') {
        try {
          const checkout = await payments.getCheckout(b.checkout_id);
          if (checkout.paid) {
            await confirmBooking(b.id, checkout.paymentRef);
            continue;
          }
          await payments.expireCheckout(b.checkout_id);
        } catch (err) {
          console.error(`Could not check payment for booking ${b.id}:`, err.message);
          continue; // try again next sweep rather than risk dropping a paid booking
        }
      }
      const current = q.booking.get(b.id);
      if (current.status !== 'pending') continue;
      releaseBooking(current, 'expired');
      if (current.payment_provider === 'transfer') {
        const s = getSession(current.session_id);
        mailer.send({
          to: current.email,
          subject: `Reservation expired: ${s.title}, ${formatClassTime(s.starts_at)}`,
          text: `Hi ${current.name},\n\nWe didn't receive your payment in time, so your reserved spot in ${s.title} on ` +
            `${formatClassTime(s.starts_at, s.duration_min)} has been released.\n\n` +
            `If you already paid, please reply to this email or contact ${config.studio.instructor || 'the studio'} and we'll sort it out.` + sign,
        });
      }
    }

    const lapsed = db.prepare(`SELECT * FROM waitlist WHERE status = 'offered' AND offer_expires_at <= ?`).all(now());
    for (const w of lapsed) {
      db.prepare(`UPDATE waitlist SET status = 'expired' WHERE id = ?`).run(w.id);
      const s = getSession(w.session_id);
      mailer.send({
        to: w.email,
        subject: `Waiting list offer expired: ${s.title}`,
        text: `Hi ${w.name},\n\nThe spot we held for you in ${s.title} on ${formatClassTime(s.starts_at)} has been passed on to the next person on the waiting list.` + sign,
      });
      processWaitlist(w.session_id);
    }
  }

  // ------------------------------------------------------------------ admin

  function adminSessions({ includePast = false } = {}) {
    const rows = includePast
      ? db.prepare(`SELECT * FROM class_sessions WHERE starts_at > ? ORDER BY starts_at DESC LIMIT 100`).all(localIn(-24 * 60))
      : db.prepare(`SELECT * FROM class_sessions WHERE starts_at > ? ORDER BY starts_at`).all(localIn(-3));
    return rows.map((s) => ({
      ...publicSession(s),
      booked: db.prepare(`SELECT COUNT(*) AS n FROM bookings WHERE session_id = ? AND status = 'confirmed'`).get(s.id).n,
      past: s.starts_at <= nowLocal(),
    }));
  }

  function adminSessionDetail(id) {
    const s = getSession(id);
    const bookings = db.prepare(`SELECT id, name, email, phone, first_time, notes, status, amount_minor, currency, payment_provider,
                                        refunded, created_at, hold_expires_at FROM bookings
                                 WHERE session_id = ? AND status IN ('confirmed', 'pending', 'cancelled', 'expired') ORDER BY id`).all(s.id)
      // Expired card checkouts are noise; expired transfers stay visible in case the money arrives late.
      .filter((b) => (b.status === 'pending' ? b.hold_expires_at > now() : b.status !== 'expired' || b.payment_provider === 'transfer'))
      .map((b) => ({ ...b, amount: formatMoney(b.amount_minor, b.currency), refunded: Boolean(b.refunded) }));
    const waitlist = db.prepare(`SELECT id, name, email, phone, first_time, notes, status, offer_expires_at, created_at FROM waitlist
                                 WHERE session_id = ? ORDER BY id`).all(s.id);
    return { session: { ...publicSession(s), past: s.starts_at <= nowLocal() }, bookings, waitlist };
  }

  async function adminCancelBooking(bookingId, { refund }) {
    const b = q.booking.get(bookingId);
    if (!b) throw new BookingError('Booking not found.', 404);
    if (b.status !== 'confirmed' && b.status !== 'pending') throw new BookingError('Booking is not active.', 409);
    if (b.status === 'pending' && b.checkout_id) await payments.expireCheckout(b.checkout_id);
    return cancelBooking(b, { refund, byStudio: true });
  }

  // A bank transfer / STC Pay arrived: confirm the reserved spot.
  async function adminMarkPaid(bookingId) {
    const b = q.booking.get(bookingId);
    if (!b) throw new BookingError('Booking not found.', 404);
    if (b.status === 'confirmed') return b;
    if (b.payment_provider !== 'transfer') throw new BookingError('Only bank-transfer bookings can be marked as paid.', 409);
    if (b.status !== 'pending') {
      // The hold lapsed but the money arrived: reinstate the booking if there is still room.
      if (seatsLeft(getSession(b.session_id)) === 0) {
        throw new BookingError('The reservation expired and the class is now full. Add her manually to over-book, or refund the transfer.', 409);
      }
    }
    return confirmBooking(b.id, null);
  }

  async function adminAddBooking(sessionId, input) {
    const customer = cleanCustomer(input, { strict: false });
    const s = getSession(sessionId);
    const b = transaction(db, () => {
      if (seatsLeft(s) === 0 && !input.overbook) throw new BookingError('Class is full.', 409, { full: true });
      const r = db.prepare(`
        INSERT INTO bookings (session_id, name, email, phone, first_time, notes, status, token, amount_minor, currency,
                              payment_provider, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, 0, ?, 'manual', ?)`)
        .run(s.id, customer.name, customer.email, customer.phone, customer.firstTime, customer.notes, newToken(), s.currency, now());
      return q.booking.get(r.lastInsertRowid);
    });
    return confirmBooking(b.id, null);
  }

  function adminSetCapacity(sessionId, capacity) {
    const cap = Number(capacity);
    if (!Number.isInteger(cap) || cap < 0 || cap > 500) throw new BookingError('Capacity must be a whole number.');
    getSession(sessionId);
    db.prepare('UPDATE class_sessions SET capacity = ? WHERE id = ?').run(cap, sessionId);
    processWaitlist(sessionId);
  }

  async function adminCancelSession(sessionId, { reason = '' } = {}) {
    const s = getSession(sessionId);
    db.prepare('UPDATE class_sessions SET cancelled = 1 WHERE id = ?').run(s.id);
    const active = db.prepare(`SELECT * FROM bookings WHERE session_id = ? AND status IN ('confirmed', 'pending')`).all(s.id);
    const failed = [];
    for (const b of active) {
      try {
        if (b.status === 'pending' && b.checkout_id) await payments.expireCheckout(b.checkout_id);
        await cancelBooking(b, { refund: true, byStudio: true, reason: reason || 'the class has been cancelled' });
      } catch (err) {
        failed.push(`${b.name} <${b.email}>`);
      }
    }
    const waiting = db.prepare(`SELECT * FROM waitlist WHERE session_id = ? AND status IN ('waiting', 'offered')`).all(s.id);
    for (const w of waiting) {
      db.prepare(`UPDATE waitlist SET status = 'removed' WHERE id = ?`).run(w.id);
      mailer.send({
        to: w.email,
        subject: `Class cancelled: ${s.title}, ${formatClassTime(s.starts_at)}`,
        text: `Hi ${w.name},\n\nThe class you were waiting for has been cancelled${reason ? `: ${reason}` : '.'}\n\n${describe(s)}` + sign,
      });
    }
    return { cancelledBookings: active.length - failed.length, failedRefunds: failed };
  }

  function adminRemoveWaitlist(id) {
    const w = q.waitlistById.get(id);
    if (!w) throw new BookingError('Not found.', 404);
    db.prepare(`UPDATE waitlist SET status = 'removed' WHERE id = ?`).run(w.id);
    if (w.status === 'offered') processWaitlist(w.session_id);
  }

  return {
    syncSessions,
    listUpcoming,
    startBooking,
    confirmBooking,
    completeCheckout,
    demoPay,
    refreshBooking,
    bookingView,
    cancelByCustomer,
    joinWaitlist,
    waitlistView,
    claimOffer,
    leaveWaitlist,
    processWaitlist,
    sweep,
    adminSessions,
    adminSessionDetail,
    adminCancelBooking,
    adminAddBooking,
    adminMarkPaid,
    adminSetCapacity,
    adminCancelSession,
    adminRemoveWaitlist,
    // Expire a checkout that Stripe told us has lapsed.
    async checkoutExpired(checkoutId) {
      const b = q.bookingByCheckout.get(checkoutId);
      if (b && b.status === 'pending') releaseBooking(b, 'expired');
    },
  };
}

module.exports = { createBookingService, BookingError };
