const { transaction } = require('./db');
const { localString, localToEpoch, upcomingDates } = require('./time');
const { toMinor, formatMoney, formatClassTime, minorUnitFactor } = require('./format');
const { bookingIcs } = require('./calendar');
const { BookingError } = require('./errors');

const HOUR = 3600_000;
const ACTIVE = ['awaiting_payment', 'payment_review', 'confirmed'];
const PAID_METHODS = ['transfer', 'credit', 'manual'];

function createBookingService({ db, config, mailer, now = () => Date.now() }) {
  const tz = config.studio.timezone;
  const currency = config.studio.currency;
  const nowLocal = () => localString(now(), tz);
  const startsMs = (s) => localToEpoch(s.starts_at, tz);
  const hoursBefore = (s, h) => startsMs(s) - h * HOUR;
  const money = (minor) => formatMoney(minor, currency);
  const when = (s) => formatClassTime(s.starts_at, s.duration_min);
  const deadlineText = (ms) => new Date(ms).toLocaleString('en-GB', {
    timeZone: tz, weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit', hour12: true,
  });
  const sign = `\n\nSee you on the mat,\n${config.studio.instructor || config.studio.name}`;
  const accountUrl = (section = '') => `${config.baseUrl}/account.html${section ? '#' + section : ''}`;

  const q = {
    session: db.prepare('SELECT * FROM class_sessions WHERE id = ?'),
    booking: db.prepare('SELECT * FROM bookings WHERE id = ?'),
    user: db.prepare('SELECT * FROM users WHERE id = ?'),
    payment: db.prepare('SELECT * FROM payments WHERE id = ?'),
    waitlistEntry: db.prepare('SELECT * FROM waitlist WHERE id = ?'),
    seatsTaken: db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM bookings WHERE session_id = :id
           AND status IN ('awaiting_payment', 'payment_review', 'confirmed'))
      + (SELECT COUNT(*) FROM waitlist WHERE session_id = :id
           AND status = 'offered' AND offer_expires_at > :now) AS taken`),
    waitingCount: db.prepare(`SELECT COUNT(*) AS n FROM waitlist WHERE session_id = ? AND status IN ('waiting', 'offered')`),
    nextWaiting: db.prepare(`SELECT * FROM waitlist WHERE session_id = ? AND status = 'waiting' ORDER BY id LIMIT 1`),
  };

  // ---------------------------------------------------------------- helpers

  function getSession(id) {
    const s = q.session.get(id);
    if (!s) throw new BookingError('Class not found.', 404);
    return s;
  }

  function seatsLeft(s) {
    return Math.max(0, s.capacity - q.seatsTaken.get({ id: s.id, now: now() }).taken);
  }

  const bookingOpen = (s) => !s.cancelled && hoursBefore(s, config.bookingCutoffHours) > now();
  const waitlistOpen = (s) => !s.cancelled && hoursBefore(s, config.paymentDeadlineHours) > now();
  const isActive = (b) => ACTIVE.includes(b.status);

  function describe(s) {
    return `${s.title}\n${when(s)}${s.location ? `\n${s.location}` : ''}`;
  }

  function addCredit(userId, amount, reason, bookingId = null) {
    if (!userId || !amount) return;
    db.prepare('UPDATE users SET credit_minor = credit_minor + ? WHERE id = ?').run(amount, userId);
    db.prepare('INSERT INTO credit_ledger (user_id, amount_minor, reason, booking_id, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(userId, amount, reason, bookingId, now());
  }

  async function sendConfirmation(b) {
    const s = getSession(b.session_id);
    const how = { credit: ' (paid with credit)', transfer: ' (bank transfer)', manual: '', free: '' }[b.paid_with] ?? '';
    await mailer.send({
      to: b.email,
      subject: `Booking confirmed: ${s.title}, ${formatClassTime(s.starts_at)}`,
      text: `Hi ${b.name},\n\nYour spot is confirmed${how}.\n\n${describe(s)}\n\n` +
        `A calendar invite is attached. Manage your bookings: ${accountUrl('bookings')}\n` +
        `(You can cancel online until ${config.cancellationHours} hours before class.)` + sign,
      icalEvent: { method: 'PUBLISH', filename: 'pilates-class.ics', content: bookingIcs({ booking: b, session: s, config }) },
    });
  }

  function publicSession(s, userId) {
    const left = seatsLeft(s);
    const out = {
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
      price: money(s.price_minor),
      priceMinor: s.price_minor,
      cancelled: Boolean(s.cancelled),
      bookingOpen: bookingOpen(s),
      waitlistOpen: waitlistOpen(s),
    };
    if (userId) {
      const mine = db.prepare(`SELECT status FROM bookings WHERE session_id = ? AND user_id = ? AND status != 'cancelled'`).get(s.id, userId);
      const wait = db.prepare(`SELECT status FROM waitlist WHERE session_id = ? AND user_id = ? AND status IN ('waiting', 'offered')`).get(s.id, userId);
      out.myBooking = mine?.status ?? null;
      out.myWaitlist = wait?.status ?? null;
    }
    return out;
  }

  // ------------------------------------------------------------- timetable

  // Loads the weekly classes from schedule.json the first time the site runs.
  function seedTemplates() {
    if (db.prepare('SELECT COUNT(*) AS n FROM class_templates').get().n > 0) return;
    const insert = db.prepare(`INSERT INTO class_templates (title, description, weekday, time, duration_min, capacity, price_minor, created_at)
                               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const c of config.classes) {
      insert.run(c.title, c.description, c.weekday, c.time, c.durationMinutes, c.capacity, toMinor(c.price, currency), now());
    }
  }

  // Creates dated classes for the coming weeks from the active weekly classes.
  function syncSessions() {
    const templates = db.prepare('SELECT * FROM class_templates WHERE active = 1').all();
    const insert = db.prepare(`
      INSERT OR IGNORE INTO class_sessions
        (template_id, title, description, location, starts_at, duration_min, capacity, price_minor, currency, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const current = nowLocal();
    let created = 0;
    transaction(db, () => {
      for (const { date, weekday } of upcomingDates(now(), tz, config.studio.weeksAhead * 7)) {
        for (const t of templates) {
          if (t.weekday !== weekday) continue;
          const startsAt = `${date}T${t.time}`;
          if (startsAt <= current) continue;
          created += Number(insert.run(t.id, t.title, t.description, config.studio.location, startsAt, t.duration_min,
            t.capacity, t.price_minor, currency, now()).changes);
        }
      }
    });
    return created;
  }

  function listUpcoming(user) {
    return db.prepare('SELECT * FROM class_sessions WHERE starts_at > ? ORDER BY starts_at, id')
      .all(nowLocal())
      .map((s) => publicSession(s, user?.id));
  }

  // --------------------------------------------------------------- booking

  async function bookClasses(user, sessionIds) {
    const ids = [...new Set((Array.isArray(sessionIds) ? sessionIds : [sessionIds]).map(Number))].filter(Boolean);
    if (!ids.length) throw new BookingError('Please choose at least one class.');
    if (ids.length > 20) throw new BookingError('Please book at most 20 classes at a time.');

    const booked = [];
    const failed = [];
    for (const id of ids) {
      try {
        booked.push(transaction(db, () => {
          const s = getSession(id);
          if (s.cancelled) throw new BookingError('This class has been cancelled.');
          if (!bookingOpen(s)) throw new BookingError(`Online booking closes ${config.bookingCutoffHours} hours before class.`);
          const dup = db.prepare(`SELECT 1 FROM bookings WHERE session_id = ? AND user_id = ? AND status != 'cancelled'`).get(s.id, user.id);
          if (dup) throw new BookingError('You are already booked into this class.');
          if (seatsLeft(s) === 0) throw new BookingError('This class is full.', 409, { full: true });
          const free = s.price_minor === 0;
          const r = db.prepare(`
            INSERT INTO bookings (session_id, user_id, name, email, phone, status, amount_minor, currency, paid_with, created_at, confirmed_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(s.id, user.id, user.name, user.email, user.phone, free ? 'confirmed' : 'awaiting_payment',
              s.price_minor, s.currency, free ? 'free' : null, now(), free ? now() : null);
          return q.booking.get(r.lastInsertRowid);
        }));
      } catch (err) {
        if (!(err instanceof BookingError)) throw err;
        failed.push({ sessionId: id, error: err.message, full: Boolean(err.full) });
      }
    }

    const unpaid = booked.filter((b) => b.status === 'awaiting_payment');
    for (const b of booked.filter((x) => x.status === 'confirmed')) await sendConfirmation(b);
    if (unpaid.length) {
      const lines = unpaid.map((b) => {
        const s = getSession(b.session_id);
        return `- ${s.title}, ${when(s)}: ${money(b.amount_minor)} (pay by ${deadlineText(hoursBefore(s, config.paymentDeadlineHours))})`;
      });
      await mailer.send({
        to: user.email,
        subject: `Spot${unpaid.length > 1 ? 's' : ''} reserved — payment needed`,
        text: `Hi ${user.name},\n\nWe've reserved your spot${unpaid.length > 1 ? 's' : ''} in:\n\n${lines.join('\n')}\n\n` +
          `To confirm, transfer the fee and upload your receipt in "Pending payments":\n${accountUrl('payments')}\n\n` +
          `${config.studio.paymentInstructions}\n\nUnpaid spots are released ${config.paymentDeadlineHours} hours before class.` + sign,
      });
    }
    if (booked.length && config.adminNotifyEmail) {
      await mailer.send({
        to: config.adminNotifyEmail,
        subject: `New booking: ${user.name} (${booked.length} class${booked.length > 1 ? 'es' : ''})`,
        text: `${user.name} (${user.email}, ${user.phone}) booked:\n` +
          booked.map((b) => { const s = getSession(b.session_id); return `- ${s.title}, ${when(s)}`; }).join('\n'),
      });
    }
    return { booked: booked.map((b) => b.id), failed };
  }

  // -------------------------------------------------------------- payments

  const payDeadline = (b) => hoursBefore(getSession(b.session_id), config.paymentDeadlineHours);

  // Pays for one or more bookings: credit first if asked, then one receipt for the rest.
  async function payBookings(user, { bookingIds, useCredits, file }) {
    const ids = [...new Set((Array.isArray(bookingIds) ? bookingIds : [bookingIds]).map(Number))].filter(Boolean);
    if (!ids.length) throw new BookingError('Please choose the classes you are paying for.');

    const result = transaction(db, () => {
      const fresh = q.user.get(user.id);
      const list = ids.map((id) => q.booking.get(id));
      for (const b of list) {
        if (!b || b.user_id !== user.id) throw new BookingError('Booking not found.', 404);
        if (b.status !== 'awaiting_payment') throw new BookingError('One of these classes is not waiting for payment any more. Please refresh.', 409);
        if (payDeadline(b) <= now()) throw new BookingError('The payment deadline for one of these classes has passed.', 409);
      }
      list.sort((a, b) => startsMs(getSession(a.session_id)) - startsMs(getSession(b.session_id)));

      let balance = useCredits ? fresh.credit_minor : 0;
      const byCredit = [];
      const byTransfer = [];
      for (const b of list) {
        if (balance >= b.amount_minor) {
          byCredit.push(b);
          balance -= b.amount_minor;
        } else {
          byTransfer.push(b);
        }
      }
      if (byTransfer.length && !file) {
        throw new BookingError('Please attach your bank transfer receipt.', 400, { needsReceipt: true });
      }

      for (const b of byCredit) {
        db.prepare(`UPDATE bookings SET status = 'confirmed', paid_with = 'credit', confirmed_at = ? WHERE id = ?`).run(now(), b.id);
        addCredit(user.id, -b.amount_minor, 'Paid for a class', b.id);
      }
      let paymentId = null;
      if (byTransfer.length) {
        const amount = byTransfer.reduce((sum, b) => sum + b.amount_minor, 0);
        paymentId = Number(db.prepare(`
          INSERT INTO payments (user_id, amount_minor, currency, receipt_file, receipt_name, receipt_type, status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, 'pending_review', ?)`)
          .run(user.id, amount, currency, file.filename, file.originalname.slice(0, 200), file.mimetype, now()).lastInsertRowid);
        for (const b of byTransfer) {
          db.prepare(`UPDATE bookings SET status = 'payment_review', payment_id = ? WHERE id = ?`).run(paymentId, b.id);
        }
      }
      return { byCredit: byCredit.map((b) => b.id), byTransfer: byTransfer.map((b) => b.id), paymentId };
    });

    for (const id of result.byCredit) await sendConfirmation(q.booking.get(id));
    if (result.paymentId) {
      const p = q.payment.get(result.paymentId);
      await mailer.send({
        to: user.email,
        subject: 'Receipt received — we will confirm shortly',
        text: `Hi ${user.name},\n\nThanks! We've received your receipt for ${money(p.amount_minor)} ` +
          `(${result.byTransfer.length} class${result.byTransfer.length > 1 ? 'es' : ''}). ` +
          `Your spot${result.byTransfer.length > 1 ? 's are' : ' is'} held while ${config.studio.instructor || 'the studio'} checks it, ` +
          `and you'll get a confirmation email once it's approved.` + sign,
      });
      if (config.adminNotifyEmail) {
        await mailer.send({
          to: config.adminNotifyEmail,
          subject: `Receipt to check: ${user.name}, ${money(p.amount_minor)}`,
          text: `${user.name} uploaded a transfer receipt for ${money(p.amount_minor)}.\nReview it: ${config.baseUrl}/admin`,
        });
      }
    }
    return result;
  }

  async function approvePayment(paymentId) {
    const changed = transaction(db, () => {
      const p = q.payment.get(paymentId);
      if (!p) throw new BookingError('Payment not found.', 404);
      if (p.status !== 'pending_review') throw new BookingError('This receipt has already been reviewed.', 409);
      db.prepare(`UPDATE payments SET status = 'approved', reviewed_at = ? WHERE id = ?`).run(now(), p.id);
      const list = db.prepare('SELECT * FROM bookings WHERE payment_id = ?').all(p.id);
      const confirmed = [];
      const credited = [];
      for (const b of list) {
        if (b.status === 'payment_review') {
          db.prepare(`UPDATE bookings SET status = 'confirmed', paid_with = 'transfer', confirmed_at = ? WHERE id = ?`).run(now(), b.id);
          confirmed.push(b.id);
        } else if (b.status === 'cancelled') {
          // Cancelled while the receipt was waiting: the money is real, so it becomes credit.
          addCredit(b.user_id, b.amount_minor, 'Payment for a cancelled class', b.id);
          credited.push(b);
        }
      }
      return { confirmed, credited, userId: p.user_id };
    });
    for (const id of changed.confirmed) await sendConfirmation(q.booking.get(id));
    if (changed.credited.length) {
      const u = q.user.get(changed.userId);
      const total = changed.credited.reduce((sum, b) => sum + b.amount_minor, 0);
      await mailer.send({
        to: u.email,
        subject: `${money(total)} added to your account credit`,
        text: `Hi ${u.name},\n\nYour transfer was approved, but ${changed.credited.length > 1 ? 'some of those classes were' : 'that class was'} ` +
          `cancelled, so ${money(total)} has been added to your account credit. You can use it for any other class: ${accountUrl('credits')}` + sign,
      });
    }
    return changed;
  }

  async function rejectPayment(paymentId, reason) {
    const why = String(reason || '').trim().slice(0, 300) || 'the receipt could not be matched to a transfer';
    const info = transaction(db, () => {
      const p = q.payment.get(paymentId);
      if (!p) throw new BookingError('Payment not found.', 404);
      if (p.status !== 'pending_review') throw new BookingError('This receipt has already been reviewed.', 409);
      db.prepare(`UPDATE payments SET status = 'rejected', reject_reason = ?, reviewed_at = ? WHERE id = ?`).run(why, now(), p.id);
      const list = db.prepare(`SELECT * FROM bookings WHERE payment_id = ? AND status = 'payment_review'`).all(p.id);
      for (const b of list) {
        db.prepare(`UPDATE bookings SET status = 'awaiting_payment', payment_id = NULL WHERE id = ?`).run(b.id);
      }
      return { userId: p.user_id, list };
    });
    if (info.list.length) {
      const u = q.user.get(info.userId);
      const lines = info.list.map((b) => {
        const s = getSession(b.session_id);
        return `- ${s.title}, ${when(s)} (pay by ${deadlineText(hoursBefore(s, config.paymentDeadlineHours))})`;
      });
      await mailer.send({
        to: u.email,
        subject: 'There was a problem with your payment receipt',
        text: `Hi ${u.name},\n\nYour receipt could not be accepted: ${why}.\n\nYour spot${lines.length > 1 ? 's are' : ' is'} still reserved:\n${lines.join('\n')}\n\n` +
          `Please upload a correct receipt in "Pending payments" before the deadline: ${accountUrl('payments')}\n` +
          `Unpaid spots are released ${config.paymentDeadlineHours} hours before class.` + sign,
      });
    }
    return info;
  }

  // --------------------------------------------------------- cancellation

  // Cancels a booking, turns money already paid into credit, and offers the spot on.
  function releaseBooking(b, reason, { credit = true } = {}) {
    let credited = 0;
    transaction(db, () => {
      db.prepare(`UPDATE bookings SET status = 'cancelled', cancel_reason = ?, cancelled_at = ? WHERE id = ?`).run(reason, now(), b.id);
      if (credit && b.status === 'confirmed' && PAID_METHODS.includes(b.paid_with) && b.user_id) {
        credited = b.amount_minor;
        addCredit(b.user_id, credited, reason === 'class cancelled' ? 'Class cancelled by the studio' : 'Cancelled a class', b.id);
      }
    });
    return credited;
  }

  async function sendCancellation(b, { credited, byStudio, why }) {
    const s = getSession(b.session_id);
    const msgs = {
      client: 'Your booking has been cancelled and your spot has been released.',
      studio: `Your booking has been cancelled by the studio${why ? `: ${why}` : '.'}`,
      unpaid: `We didn't receive payment ${config.paymentDeadlineHours} hours before class, so your reserved spot has been released.`,
    };
    await mailer.send({
      to: b.email,
      subject: `Booking cancelled: ${s.title}, ${formatClassTime(s.starts_at)}`,
      text: `Hi ${b.name},\n\n${msgs[byStudio]}\n\n${describe(s)}\n` +
        (credited ? `\n${money(credited)} has been added to your account credit for another class: ${accountUrl('credits')}\n` : '') +
        (b.status === 'payment_review' ? '\nIf your transfer receipt is approved, the amount will be added to your account credit.\n' : '') +
        (byStudio === 'unpaid' ? `\nIf you already paid, please contact ${config.studio.instructor || 'the studio'}.\n` : '') + sign,
      icalEvent: b.status === 'confirmed'
        ? { method: 'CANCEL', filename: 'cancelled.ics', content: bookingIcs({ booking: b, session: s, config, cancelled: true }) }
        : undefined,
    });
  }

  function canCancel(b, s) {
    return isActive(b) && !s.cancelled && hoursBefore(s, config.cancellationHours) > now();
  }

  async function cancelByUser(user, bookingId) {
    const b = q.booking.get(bookingId);
    if (!b || b.user_id !== user.id) throw new BookingError('Booking not found.', 404);
    const s = getSession(b.session_id);
    if (!isActive(b)) throw new BookingError('This booking is already cancelled.', 409);
    if (!canCancel(b, s)) {
      throw new BookingError(`Online cancellation closes ${config.cancellationHours} hours before class. Please contact the studio.`, 409);
    }
    const credited = releaseBooking(b, 'cancelled by client');
    await sendCancellation(b, { credited, byStudio: 'client' });
    if (config.adminNotifyEmail) {
      await mailer.send({
        to: config.adminNotifyEmail,
        subject: `Cancellation: ${b.name}, ${s.title} ${formatClassTime(s.starts_at)}`,
        text: `${b.name} (${b.phone}, ${b.email}) cancelled.` + (credited ? ` ${money(credited)} was added to her credit.` : ''),
      });
    }
    processWaitlist(s.id);
    return { credited };
  }

  // ---------------------------------------------------------------- waitlist

  function joinWaitlist(user, sessionId) {
    const entry = transaction(db, () => {
      const s = getSession(sessionId);
      if (!waitlistOpen(s)) throw new BookingError('This class is no longer taking waiting-list sign-ups.', 409);
      if (seatsLeft(s) > 0 && bookingOpen(s)) throw new BookingError('Good news — a spot is available, you can book it now!', 409, { available: true });
      if (db.prepare(`SELECT 1 FROM bookings WHERE session_id = ? AND user_id = ? AND status != 'cancelled'`).get(s.id, user.id)) {
        throw new BookingError('You are already booked into this class.', 409);
      }
      if (db.prepare(`SELECT 1 FROM waitlist WHERE session_id = ? AND user_id = ? AND status IN ('waiting', 'offered')`).get(s.id, user.id)) {
        throw new BookingError('You are already on the waiting list for this class.', 409);
      }
      const r = db.prepare(`INSERT INTO waitlist (session_id, user_id, status, created_at) VALUES (?, ?, 'waiting', ?)`).run(s.id, user.id, now());
      return q.waitlistEntry.get(r.lastInsertRowid);
    });
    const s = getSession(sessionId);
    const position = waitlistPosition(entry);
    mailer.send({
      to: user.email,
      subject: `You're on the waiting list: ${s.title}, ${formatClassTime(s.starts_at)}`,
      text: `Hi ${user.name},\n\nYou're number ${position} on the waiting list for:\n\n${describe(s)}\n\n` +
        `If a spot opens up we'll email you, and you'll have up to ${config.waitlistOfferHours} hours to claim it in your account: ${accountUrl('waitlist')}` + sign,
    });
    return { id: entry.id, position };
  }

  function waitlistPosition(w) {
    return db.prepare(`SELECT COUNT(*) AS n FROM waitlist WHERE session_id = ? AND status IN ('waiting', 'offered') AND id <= ?`)
      .get(w.session_id, w.id).n;
  }

  // Offers free spots to the people at the front of the waiting list.
  function processWaitlist(sessionId) {
    const offers = transaction(db, () => {
      const s = getSession(sessionId);
      if (!waitlistOpen(s)) return [];
      const made = [];
      let left = seatsLeft(s);
      while (left > 0) {
        const w = q.nextWaiting.get(s.id);
        if (!w) break;
        const expires = Math.min(now() + config.waitlistOfferHours * HOUR, hoursBefore(s, config.paymentDeadlineHours));
        db.prepare(`UPDATE waitlist SET status = 'offered', offer_expires_at = ? WHERE id = ?`).run(expires, w.id);
        made.push({ w: q.waitlistEntry.get(w.id), s });
        left--;
      }
      return made;
    });
    for (const { w, s } of offers) {
      const u = q.user.get(w.user_id);
      mailer.send({
        to: u.email,
        subject: `A spot opened up: ${s.title}, ${formatClassTime(s.starts_at)}`,
        text: `Hi ${u.name},\n\nGood news — a spot has opened up and it's being held for you:\n\n${describe(s)}\n\n` +
          `Claim it by ${deadlineText(w.offer_expires_at)} in your account: ${accountUrl('waitlist')}\n\n` +
          `If you don't claim it in time, it goes to the next person on the list.` + sign,
      });
    }
    return offers.length;
  }

  function claimOffer(user, waitlistId) {
    return transaction(db, () => {
      const w = q.waitlistEntry.get(waitlistId);
      if (!w || w.user_id !== user.id) throw new BookingError('Waiting list entry not found.', 404);
      if (w.status !== 'offered' || w.offer_expires_at <= now()) throw new BookingError('Sorry, this offer is no longer available.', 409);
      const s = getSession(w.session_id);
      // The offered seat passes straight to the new booking, so no capacity check is needed.
      db.prepare(`UPDATE waitlist SET status = 'booked' WHERE id = ?`).run(w.id);
      const r = db.prepare(`
        INSERT INTO bookings (session_id, user_id, name, email, phone, status, amount_minor, currency, waitlist_id, created_at)
        VALUES (?, ?, ?, ?, ?, 'awaiting_payment', ?, ?, ?, ?)`)
        .run(s.id, user.id, user.name, user.email, user.phone, s.price_minor, s.currency, w.id, now());
      return { bookingId: Number(r.lastInsertRowid) };
    });
  }

  function leaveWaitlist(user, waitlistId) {
    const w = q.waitlistEntry.get(waitlistId);
    if (!w || w.user_id !== user.id) throw new BookingError('Waiting list entry not found.', 404);
    if (!['waiting', 'offered'].includes(w.status)) throw new BookingError('You are not on this waiting list any more.', 409);
    db.prepare(`UPDATE waitlist SET status = 'removed' WHERE id = ?`).run(w.id);
    if (w.status === 'offered') processWaitlist(w.session_id);
  }

  // ----------------------------------------------------------------- account

  function myAccount(user) {
    const u = q.user.get(user.id);
    const bookings = db.prepare(`
      SELECT b.*, s.title, s.starts_at, s.duration_min, s.location, s.cancelled AS session_cancelled
      FROM bookings b JOIN class_sessions s ON s.id = b.session_id
      WHERE b.user_id = ? ORDER BY s.starts_at`).all(u.id);
    const current = nowLocal();
    const view = (b) => {
      const s = getSession(b.session_id);
      return {
        id: b.id,
        title: b.title,
        startsAt: b.starts_at,
        durationMinutes: b.duration_min,
        location: b.location,
        status: b.status,
        amount: money(b.amount_minor),
        amountMinor: b.amount_minor,
        paidWith: b.paid_with,
        cancelReason: b.cancel_reason,
        canCancel: canCancel(b, s),
        payBy: b.status === 'awaiting_payment' ? deadlineText(payDeadline(b)) : null,
        past: b.starts_at <= current,
      };
    };
    const waitlist = db.prepare(`
      SELECT w.*, s.title, s.starts_at, s.duration_min FROM waitlist w JOIN class_sessions s ON s.id = w.session_id
      WHERE w.user_id = ? AND w.status IN ('waiting', 'offered') AND s.starts_at > ? ORDER BY s.starts_at`).all(u.id, current);
    const ledger = db.prepare('SELECT amount_minor, reason, created_at FROM credit_ledger WHERE user_id = ? ORDER BY id DESC LIMIT 50').all(u.id);
    const rejected = db.prepare(`SELECT reject_reason, reviewed_at FROM payments WHERE user_id = ? AND status = 'rejected' ORDER BY id DESC LIMIT 1`).get(u.id);
    return {
      user: { email: u.email, name: u.name, phone: u.phone, injuries: u.injuries, activityLevel: u.activity_level },
      credit: money(u.credit_minor),
      creditMinor: u.credit_minor,
      upcoming: bookings.filter((b) => b.starts_at > current && b.status !== 'cancelled').map(view),
      history: bookings.filter((b) => b.starts_at <= current || b.status === 'cancelled').reverse().slice(0, 30).map(view),
      waitlist: waitlist.map((w) => ({
        id: w.id,
        title: w.title,
        startsAt: w.starts_at,
        durationMinutes: w.duration_min,
        status: w.offer_expires_at && w.offer_expires_at <= now() ? 'expired' : w.status,
        position: waitlistPosition(w),
        offerExpires: w.status === 'offered' ? deadlineText(w.offer_expires_at) : null,
      })),
      ledger: ledger.map((l) => ({ amount: money(l.amount_minor), positive: l.amount_minor > 0, reason: l.reason, at: l.created_at })),
      lastRejection: rejected ? rejected.reject_reason : null,
      paymentInstructions: config.studio.paymentInstructions,
    };
  }

  function bookingCalendar(user, bookingId) {
    const b = q.booking.get(bookingId);
    if (!b || b.user_id !== user.id || b.status !== 'confirmed') throw new BookingError('Booking not found.', 404);
    return bookingIcs({ booking: b, session: getSession(b.session_id), config });
  }

  // ----------------------------------------------------------- maintenance

  // Releases unpaid spots, sends payment reminders and passes on lapsed waitlist offers.
  async function sweep() {
    const pending = db.prepare(`
      SELECT b.* FROM bookings b JOIN class_sessions s ON s.id = b.session_id
      WHERE b.status = 'awaiting_payment' AND s.starts_at > ?`).all(localString(now() - 24 * HOUR, tz));
    for (const b of pending) {
      const s = getSession(b.session_id);
      if (hoursBefore(s, config.paymentDeadlineHours) <= now()) {
        releaseBooking(b, 'unpaid');
        await sendCancellation(b, { byStudio: 'unpaid' });
        processWaitlist(s.id);
      } else if (!b.reminder_sent && hoursBefore(s, config.paymentReminderHours) <= now()) {
        db.prepare('UPDATE bookings SET reminder_sent = 1 WHERE id = ?').run(b.id);
        await mailer.send({
          to: b.email,
          subject: `Reminder: payment needed for ${s.title}, ${formatClassTime(s.starts_at)}`,
          text: `Hi ${b.name},\n\nYour spot in ${s.title} on ${when(s)} is reserved but not paid yet.\n\n` +
            `Please upload your transfer receipt by ${deadlineText(payDeadline(b))}, or the spot will be released: ${accountUrl('payments')}\n\n` +
            `${config.studio.paymentInstructions}` + sign,
        });
      }
    }

    const lapsed = db.prepare(`SELECT * FROM waitlist WHERE status = 'offered' AND offer_expires_at <= ?`).all(now());
    for (const w of lapsed) {
      db.prepare(`UPDATE waitlist SET status = 'expired' WHERE id = ?`).run(w.id);
      const s = getSession(w.session_id);
      const u = q.user.get(w.user_id);
      mailer.send({
        to: u.email,
        subject: `Waiting list offer expired: ${s.title}`,
        text: `Hi ${u.name},\n\nThe spot we held for you in ${s.title} on ${when(s)} has been passed on to the next person on the waiting list.` + sign,
      });
      processWaitlist(w.session_id);
    }
  }

  // ------------------------------------------------------------------ admin

  function adminSessions({ includePast = false } = {}) {
    const rows = includePast
      ? db.prepare('SELECT * FROM class_sessions WHERE starts_at > ? ORDER BY starts_at DESC LIMIT 100').all(localString(now() - 60 * 86400_000, tz))
      : db.prepare('SELECT * FROM class_sessions WHERE starts_at > ? ORDER BY starts_at').all(localString(now() - 3 * HOUR, tz));
    return rows.map((s) => ({
      ...publicSession(s),
      booked: db.prepare(`SELECT COUNT(*) AS n FROM bookings WHERE session_id = ? AND status IN ('awaiting_payment', 'payment_review', 'confirmed')`).get(s.id).n,
      paid: db.prepare(`SELECT COUNT(*) AS n FROM bookings WHERE session_id = ? AND status = 'confirmed'`).get(s.id).n,
      past: s.starts_at <= nowLocal(),
    }));
  }

  function adminSessionDetail(id) {
    const s = getSession(id);
    const bookings = db.prepare(`
      SELECT b.id, b.name, b.email, b.phone, b.status, b.amount_minor, b.paid_with, b.payment_id, b.cancel_reason, b.created_at,
             u.injuries, u.activity_level
      FROM bookings b LEFT JOIN users u ON u.id = b.user_id
      WHERE b.session_id = ? ORDER BY b.id`).all(s.id)
      .map((b) => ({ ...b, amount: money(b.amount_minor) }));
    const waitlist = db.prepare(`
      SELECT w.id, w.status, w.offer_expires_at, w.created_at, u.name, u.email, u.phone, u.injuries, u.activity_level
      FROM waitlist w JOIN users u ON u.id = w.user_id WHERE w.session_id = ? ORDER BY w.id`).all(s.id);
    return {
      session: { ...publicSession(s), past: s.starts_at <= nowLocal(), payDeadline: deadlineText(hoursBefore(s, config.paymentDeadlineHours)) },
      bookings,
      waitlist,
    };
  }

  function adminPayments(status = 'pending_review') {
    return db.prepare(`
      SELECT p.*, u.name, u.email, u.phone FROM payments p JOIN users u ON u.id = p.user_id
      WHERE p.status = ? ORDER BY p.id ${status === 'pending_review' ? 'ASC' : 'DESC'} LIMIT 100`).all(status)
      .map((p) => ({
        id: p.id,
        name: p.name,
        email: p.email,
        phone: p.phone,
        amount: money(p.amount_minor),
        status: p.status,
        rejectReason: p.reject_reason,
        receiptName: p.receipt_name,
        receiptType: p.receipt_type,
        createdAt: p.created_at,
        bookings: db.prepare(`
          SELECT b.id, b.status, b.amount_minor, s.title, s.starts_at, s.duration_min
          FROM bookings b JOIN class_sessions s ON s.id = b.session_id WHERE b.payment_id = ? ORDER BY s.starts_at`).all(p.id)
          .map((b) => ({ ...b, amount: money(b.amount_minor) })),
      }));
  }

  function receiptFor(paymentId, user) {
    const p = q.payment.get(paymentId);
    if (!p || (user && p.user_id !== user.id)) throw new BookingError('Receipt not found.', 404);
    return p;
  }

  async function adminCancelBooking(bookingId, { credit = true, reason = '' } = {}) {
    const b = q.booking.get(bookingId);
    if (!b) throw new BookingError('Booking not found.', 404);
    if (!isActive(b)) throw new BookingError('Booking is not active.', 409);
    const credited = releaseBooking(b, 'cancelled by studio', { credit });
    await sendCancellation(b, { credited, byStudio: 'studio', why: String(reason || '').slice(0, 300) });
    processWaitlist(b.session_id);
    return { credited };
  }

  async function adminAddBooking(sessionId, input = {}) {
    const name = String(input.name || '').trim().slice(0, 100);
    const email = String(input.email || '').trim().toLowerCase().slice(0, 200);
    const phone = String(input.phone || '').trim().slice(0, 40);
    if (!name) throw new BookingError('Please enter a name.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new BookingError('Please enter a valid email address.');
    const b = transaction(db, () => {
      const s = getSession(sessionId);
      if (seatsLeft(s) === 0 && !input.overbook) throw new BookingError('Class is full.', 409, { full: true });
      const account = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
      const r = db.prepare(`
        INSERT INTO bookings (session_id, user_id, name, email, phone, status, amount_minor, currency, paid_with, created_at, confirmed_at)
        VALUES (?, ?, ?, ?, ?, 'confirmed', ?, ?, 'manual', ?, ?)`)
        .run(s.id, account?.id ?? null, name, email, phone, s.price_minor, s.currency, now(), now());
      return q.booking.get(r.lastInsertRowid);
    });
    await sendConfirmation(b);
    return b;
  }

  function adminSetCapacity(sessionId, capacity) {
    const cap = Number(capacity);
    if (!Number.isInteger(cap) || cap < 0 || cap > 500) throw new BookingError('Capacity must be a whole number.');
    getSession(sessionId);
    db.prepare('UPDATE class_sessions SET capacity = ? WHERE id = ?').run(cap, sessionId);
    processWaitlist(sessionId);
  }

  // Cancels a whole class: paid clients get credit, everyone is emailed.
  async function adminCancelClass(sessionId, { reason = '' } = {}) {
    const s = getSession(sessionId);
    const why = String(reason || '').slice(0, 300) || 'the class has been cancelled';
    db.prepare('UPDATE class_sessions SET cancelled = 1 WHERE id = ?').run(s.id);
    const active = db.prepare(`SELECT * FROM bookings WHERE session_id = ? AND status IN ('awaiting_payment', 'payment_review', 'confirmed')`).all(s.id);
    let creditedTotal = 0;
    for (const b of active) {
      const credited = releaseBooking(b, 'class cancelled');
      creditedTotal += credited;
      await sendCancellation(b, { credited, byStudio: 'studio', why });
    }
    const waiting = db.prepare(`
      SELECT w.*, u.name, u.email FROM waitlist w JOIN users u ON u.id = w.user_id
      WHERE w.session_id = ? AND w.status IN ('waiting', 'offered')`).all(s.id);
    for (const w of waiting) {
      db.prepare(`UPDATE waitlist SET status = 'removed' WHERE id = ?`).run(w.id);
      mailer.send({
        to: w.email,
        subject: `Class cancelled: ${s.title}, ${formatClassTime(s.starts_at)}`,
        text: `Hi ${w.name},\n\nThe class you were waiting for has been cancelled: ${why}.\n\n${describe(s)}` + sign,
      });
    }
    return { cancelledBookings: active.length, credited: money(creditedTotal) };
  }

  function adminRemoveWaitlist(id) {
    const w = q.waitlistEntry.get(id);
    if (!w) throw new BookingError('Not found.', 404);
    db.prepare(`UPDATE waitlist SET status = 'removed' WHERE id = ?`).run(w.id);
    if (w.status === 'offered') processWaitlist(w.session_id);
  }

  // ---------------------------------------------------------------- clients

  function adminClients(search = '') {
    const term = `%${String(search).trim().toLowerCase().slice(0, 100)}%`;
    return db.prepare(`
      SELECT u.id, u.email, u.name, u.phone, u.injuries, u.activity_level, u.credit_minor, u.created_at,
        (SELECT COUNT(*) FROM bookings b WHERE b.user_id = u.id AND b.status = 'confirmed') AS paid_classes,
        (SELECT COUNT(*) FROM bookings b JOIN class_sessions s ON s.id = b.session_id
           WHERE b.user_id = u.id AND b.status IN ('awaiting_payment', 'payment_review', 'confirmed') AND s.starts_at > :now) AS upcoming,
        (SELECT COUNT(*) FROM bookings b WHERE b.user_id = u.id AND b.status = 'awaiting_payment') AS unpaid
      FROM users u
      WHERE lower(u.name) LIKE :term OR lower(u.email) LIKE :term OR u.phone LIKE :term
      ORDER BY u.created_at DESC LIMIT 500`).all({ term, now: nowLocal() })
      .map((u) => ({ ...u, credit: money(u.credit_minor) }));
  }

  function adminClientDetail(id) {
    const u = q.user.get(id);
    if (!u) throw new BookingError('Client not found.', 404);
    const bookings = db.prepare(`
      SELECT b.id, b.status, b.paid_with, b.amount_minor, b.cancel_reason, s.title, s.starts_at, s.duration_min
      FROM bookings b JOIN class_sessions s ON s.id = b.session_id
      WHERE b.user_id = ? ORDER BY s.starts_at DESC LIMIT 100`).all(u.id)
      .map((b) => ({ ...b, amount: money(b.amount_minor), past: b.starts_at <= nowLocal() }));
    const ledger = db.prepare('SELECT amount_minor, reason, created_at FROM credit_ledger WHERE user_id = ? ORDER BY id DESC LIMIT 50').all(u.id)
      .map((l) => ({ amount: money(l.amount_minor), positive: l.amount_minor > 0, reason: l.reason, at: l.created_at }));
    return { bookings, ledger };
  }

  // ------------------------------------------------------- class schedules

  function cleanClass(input = {}, { oneOff = false } = {}) {
    const title = String(input.title || '').trim().slice(0, 80);
    const description = String(input.description || '').trim().slice(0, 300);
    const time = String(input.time || '');
    const durationMin = Number(input.durationMinutes);
    const capacity = Number(input.capacity);
    const price = Number(input.price);
    if (!title) throw new BookingError('Please enter a class name.');
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new BookingError('Please enter a start time.');
    if (!(durationMin >= 15 && durationMin <= 240)) throw new BookingError('Duration must be between 15 and 240 minutes.');
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 500) throw new BookingError('Capacity must be a whole number.');
    if (!(price >= 0)) throw new BookingError('Please enter a price.');
    const out = { title, description, time, durationMin, capacity, priceMinor: toMinor(price, currency) };
    if (oneOff) {
      const date = String(input.date || '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new BookingError('Please choose a date.');
      if (`${date}T${time}` <= nowLocal()) throw new BookingError('That date and time is in the past.');
      out.date = date;
    } else {
      const weekday = Number(input.weekday);
      if (!(weekday >= 0 && weekday <= 6)) throw new BookingError('Please choose a day of the week.');
      out.weekday = weekday;
    }
    return out;
  }

  function listTemplates() {
    return db.prepare('SELECT * FROM class_templates ORDER BY active DESC, weekday, time').all().map((t) => ({
      id: t.id,
      title: t.title,
      description: t.description,
      weekday: t.weekday,
      time: t.time,
      durationMinutes: t.duration_min,
      capacity: t.capacity,
      price: t.price_minor / minorUnitFactor(currency),
      active: Boolean(t.active),
    }));
  }

  function addTemplate(input) {
    const c = cleanClass(input);
    db.prepare(`INSERT INTO class_templates (title, description, weekday, time, duration_min, capacity, price_minor, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(c.title, c.description, c.weekday, c.time, c.durationMin, c.capacity, c.priceMinor, now());
    syncSessions();
  }

  // Future dates of a weekly class that nobody has booked or waitlisted are rebuilt from the new
  // details; dates that already have bookings keep their original time so nobody is moved silently.
  function editTemplate(id, input) {
    const t = db.prepare('SELECT * FROM class_templates WHERE id = ?').get(id);
    if (!t) throw new BookingError('Class not found.', 404);
    const active = input.active === undefined ? Boolean(t.active) : Boolean(input.active);
    const c = cleanClass(input);
    let kept = 0;
    transaction(db, () => {
      db.prepare(`UPDATE class_templates SET title = ?, description = ?, weekday = ?, time = ?, duration_min = ?, capacity = ?,
                  price_minor = ?, active = ? WHERE id = ?`)
        .run(c.title, c.description, c.weekday, c.time, c.durationMin, c.capacity, c.priceMinor, active ? 1 : 0, id);
      const future = db.prepare('SELECT * FROM class_sessions WHERE template_id = ? AND starts_at > ? AND cancelled = 0').all(id, nowLocal());
      for (const s of future) {
        const used = db.prepare('SELECT (SELECT COUNT(*) FROM bookings WHERE session_id = ?) + (SELECT COUNT(*) FROM waitlist WHERE session_id = ?) AS n')
          .get(s.id, s.id).n;
        if (used) {
          kept++;
          db.prepare('UPDATE class_sessions SET title = ?, description = ? WHERE id = ?').run(c.title, c.description, s.id);
        } else {
          db.prepare('DELETE FROM class_sessions WHERE id = ?').run(s.id);
        }
      }
    });
    syncSessions();
    return { keptWithBookings: kept };
  }

  function addOneOffClass(input) {
    const c = cleanClass(input, { oneOff: true });
    db.prepare(`INSERT INTO class_sessions (template_id, title, description, location, starts_at, duration_min, capacity, price_minor, currency, created_at)
                VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(c.title, c.description, config.studio.location, `${c.date}T${c.time}`, c.durationMin, c.capacity, c.priceMinor, currency, now());
  }

  return {
    seedTemplates,
    syncSessions,
    listUpcoming,
    bookClasses,
    payBookings,
    approvePayment,
    rejectPayment,
    cancelByUser,
    joinWaitlist,
    claimOffer,
    leaveWaitlist,
    processWaitlist,
    myAccount,
    bookingCalendar,
    sweep,
    adminSessions,
    adminSessionDetail,
    adminPayments,
    receiptFor,
    adminCancelBooking,
    adminAddBooking,
    adminSetCapacity,
    adminCancelClass,
    adminRemoveWaitlist,
    adminClients,
    adminClientDetail,
    listTemplates,
    addTemplate,
    editTemplate,
    addOneOffClass,
  };
}

module.exports = { createBookingService, BookingError };
