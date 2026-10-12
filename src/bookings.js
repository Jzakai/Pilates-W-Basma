const { localString, localToEpoch, upcomingDates } = require('./time');
const { toMinor, formatMoney, formatClassTime, minorUnitFactor } = require('./format');
const { bookingIcs } = require('./calendar');
const { BookingError } = require('./errors');

const HOUR = 3600_000;
const ACTIVE = ['awaiting_payment', 'payment_review', 'confirmed'];
const PAID_METHODS = ['transfer', 'credit', 'manual'];

// Functions that read or write the database take `x`: the database itself, or the transaction
// handle when called inside db.tx(). Inside a transaction always pass the handle.
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

  const byId = (table) => (x, id) => x.get(`SELECT * FROM ${table} WHERE id = $1`, [id]);
  const findSession = byId('class_sessions');
  const findBooking = byId('bookings');
  const findUser = byId('users');
  const findPayment = byId('payments');
  const findWaitlist = byId('waitlist');

  // ---------------------------------------------------------------- helpers

  async function getSession(x, id) {
    const s = await findSession(x, id);
    if (!s) throw new BookingError('Class not found.', 404);
    return s;
  }

  async function seatsLeft(x, s) {
    const { taken } = await x.get(`
      SELECT
        (SELECT COUNT(*) FROM bookings WHERE session_id = $1
           AND status IN ('awaiting_payment', 'payment_review', 'confirmed'))
      + (SELECT COUNT(*) FROM waitlist WHERE session_id = $1
           AND status = 'offered' AND offer_expires_at > $2) AS taken`, [s.id, now()]);
    return Math.max(0, s.capacity - Number(taken));
  }

  const waitingCount = async (x, sessionId) => Number((await x.get(
    `SELECT COUNT(*) AS n FROM waitlist WHERE session_id = $1 AND status IN ('waiting', 'offered')`, [sessionId])).n);

  const bookingOpen = (s) => !s.cancelled && hoursBefore(s, config.bookingCutoffHours) > now();
  const waitlistOpen = (s) => !s.cancelled && hoursBefore(s, config.paymentDeadlineHours) > now();
  const isActive = (b) => ACTIVE.includes(b.status);

  function describe(s) {
    return `${s.title}\n${when(s)}${s.location ? `\n${s.location}` : ''}`;
  }

  async function addCredit(x, userId, amount, reason, bookingId = null) {
    if (!userId || !amount) return;
    await x.run('UPDATE users SET credit_minor = credit_minor + $1 WHERE id = $2', [amount, userId]);
    await x.run('INSERT INTO credit_ledger (user_id, amount_minor, reason, booking_id, created_at) VALUES ($1, $2, $3, $4, $5)',
      [userId, amount, reason, bookingId, now()]);
  }

  async function sendConfirmation(b) {
    const s = await getSession(db, b.session_id);
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

  async function publicSession(s, userId) {
    const left = await seatsLeft(db, s);
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
      waitlistCount: await waitingCount(db, s.id),
      price: money(s.price_minor),
      priceMinor: s.price_minor,
      cancelled: Boolean(s.cancelled),
      bookingOpen: bookingOpen(s),
      waitlistOpen: waitlistOpen(s),
    };
    if (userId) {
      const mine = await db.get(`SELECT status FROM bookings WHERE session_id = $1 AND user_id = $2 AND status != 'cancelled'`, [s.id, userId]);
      const wait = await db.get(`SELECT status FROM waitlist WHERE session_id = $1 AND user_id = $2 AND status IN ('waiting', 'offered')`, [s.id, userId]);
      out.myBooking = mine?.status ?? null;
      out.myWaitlist = wait?.status ?? null;
    }
    return out;
  }

  // ------------------------------------------------------------- timetable

  // Loads the weekly classes from schedule.json the first time the site runs.
  async function seedTemplates() {
    if (Number((await db.get('SELECT COUNT(*) AS n FROM class_templates')).n) > 0) return;
    for (const c of config.classes) {
      await db.run(`INSERT INTO class_templates (title, description, weekday, "time", duration_min, capacity, price_minor, created_at)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [c.title, c.description, c.weekday, c.time, c.durationMinutes, c.capacity, toMinor(c.price, currency), now()]);
    }
  }

  // Creates dated classes for the coming weeks from the active weekly classes.
  async function syncSessions() {
    const templates = await db.all('SELECT * FROM class_templates WHERE active = 1');
    const current = nowLocal();
    let created = 0;
    for (const { date, weekday } of upcomingDates(now(), tz, config.studio.weeksAhead * 7)) {
      for (const t of templates) {
        if (t.weekday !== weekday) continue;
        const startsAt = `${date}T${t.time}`;
        if (startsAt <= current) continue;
        const r = await db.run(`
          INSERT INTO class_sessions
            (template_id, title, description, location, starts_at, duration_min, capacity, price_minor, currency, created_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          ON CONFLICT DO NOTHING`,
        [t.id, t.title, t.description, config.studio.location, startsAt, t.duration_min, t.capacity, t.price_minor, currency, now()]);
        created += r.changes;
      }
    }
    return created;
  }

  async function listUpcoming(user) {
    const rows = await db.all('SELECT * FROM class_sessions WHERE starts_at > $1 ORDER BY starts_at, id', [nowLocal()]);
    const out = [];
    for (const s of rows) out.push(await publicSession(s, user?.id));
    return out;
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
        booked.push(await db.tx(async (t) => {
          await t.lock('class_sessions', id);
          const s = await getSession(t, id);
          if (s.cancelled) throw new BookingError('This class has been cancelled.');
          if (!bookingOpen(s)) throw new BookingError(`Online booking closes ${config.bookingCutoffHours} hours before class.`);
          const dup = await t.get(`SELECT 1 AS x FROM bookings WHERE session_id = $1 AND user_id = $2 AND status != 'cancelled'`, [s.id, user.id]);
          if (dup) throw new BookingError('You are already booked into this class.');
          if (await seatsLeft(t, s) === 0) throw new BookingError('This class is full.', 409, { full: true });
          const free = s.price_minor === 0;
          const r = await t.run(`
            INSERT INTO bookings (session_id, user_id, name, email, phone, status, amount_minor, currency, paid_with, created_at, confirmed_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
          [s.id, user.id, user.name, user.email, user.phone, free ? 'confirmed' : 'awaiting_payment',
            s.price_minor, s.currency, free ? 'free' : null, now(), free ? now() : null]);
          return findBooking(t, r.id);
        }));
      } catch (err) {
        if (!(err instanceof BookingError)) throw err;
        failed.push({ sessionId: id, error: err.message, full: Boolean(err.full) });
      }
    }

    const unpaid = booked.filter((b) => b.status === 'awaiting_payment');
    for (const b of booked.filter((x) => x.status === 'confirmed')) await sendConfirmation(b);
    if (unpaid.length) {
      const lines = [];
      for (const b of unpaid) {
        const s = await getSession(db, b.session_id);
        lines.push(`- ${s.title}, ${when(s)}: ${money(b.amount_minor)} (pay by ${deadlineText(hoursBefore(s, config.paymentDeadlineHours))})`);
      }
      await mailer.send({
        to: user.email,
        subject: `Spot${unpaid.length > 1 ? 's' : ''} reserved — payment needed`,
        text: `Hi ${user.name},\n\nWe've reserved your spot${unpaid.length > 1 ? 's' : ''} in:\n\n${lines.join('\n')}\n\n` +
          `To confirm, transfer the fee and upload your receipt in "Pending payments":\n${accountUrl('payments')}\n\n` +
          `${config.studio.paymentInstructions}\n\nUnpaid spots are released ${config.paymentDeadlineHours} hours before class.` + sign,
      });
    }
    if (booked.length && config.adminNotifyEmail) {
      const lines = [];
      for (const b of booked) {
        const s = await getSession(db, b.session_id);
        lines.push(`- ${s.title}, ${when(s)}`);
      }
      await mailer.send({
        to: config.adminNotifyEmail,
        subject: `New booking: ${user.name} (${booked.length} class${booked.length > 1 ? 'es' : ''})`,
        text: `${user.name} (${user.email}, ${user.phone}) booked:\n${lines.join('\n')}`,
      });
    }
    return { booked: booked.map((b) => b.id), failed };
  }

  // -------------------------------------------------------------- payments

  const payDeadline = async (x, b) => hoursBefore(await getSession(x, b.session_id), config.paymentDeadlineHours);

  // Pays for one or more bookings: credit first if asked, then one receipt for the rest.
  // `file` is an already stored receipt: { key, originalname, mimetype }.
  async function payBookings(user, { bookingIds, useCredits, file }) {
    const ids = [...new Set((Array.isArray(bookingIds) ? bookingIds : [bookingIds]).map(Number))].filter(Boolean);
    if (!ids.length) throw new BookingError('Please choose the classes you are paying for.');

    const result = await db.tx(async (t) => {
      await t.lock('users', user.id);
      const fresh = await findUser(t, user.id);
      const list = [];
      for (const id of ids) {
        await t.lock('bookings', id);
        const b = await findBooking(t, id);
        if (!b || b.user_id !== user.id) throw new BookingError('Booking not found.', 404);
        if (b.status !== 'awaiting_payment') throw new BookingError('One of these classes is not waiting for payment any more. Please refresh.', 409);
        if (await payDeadline(t, b) <= now()) throw new BookingError('The payment deadline for one of these classes has passed.', 409);
        list.push({ b, start: startsMs(await getSession(t, b.session_id)) });
      }
      list.sort((a, b) => a.start - b.start);

      let balance = useCredits ? fresh.credit_minor : 0;
      const byCredit = [];
      const byTransfer = [];
      for (const { b } of list) {
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
        await t.run(`UPDATE bookings SET status = 'confirmed', paid_with = 'credit', confirmed_at = $1 WHERE id = $2`, [now(), b.id]);
        await addCredit(t, user.id, -b.amount_minor, 'Paid for a class', b.id);
      }
      let paymentId = null;
      if (byTransfer.length) {
        const amount = byTransfer.reduce((sum, b) => sum + b.amount_minor, 0);
        paymentId = (await t.run(`
          INSERT INTO payments (user_id, amount_minor, currency, receipt_file, receipt_name, receipt_type, status, created_at)
          VALUES ($1, $2, $3, $4, $5, $6, 'pending_review', $7) RETURNING id`,
        [user.id, amount, currency, file.key, String(file.originalname || 'receipt').slice(0, 200), file.mimetype, now()])).id;
        for (const b of byTransfer) {
          await t.run(`UPDATE bookings SET status = 'payment_review', payment_id = $1 WHERE id = $2`, [paymentId, b.id]);
        }
      }
      return { byCredit: byCredit.map((b) => b.id), byTransfer: byTransfer.map((b) => b.id), paymentId };
    });

    for (const id of result.byCredit) await sendConfirmation(await findBooking(db, id));
    if (result.paymentId) {
      const p = await findPayment(db, result.paymentId);
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
    const changed = await db.tx(async (t) => {
      await t.lock('payments', paymentId);
      const p = await findPayment(t, paymentId);
      if (!p) throw new BookingError('Payment not found.', 404);
      if (p.status !== 'pending_review') throw new BookingError('This receipt has already been reviewed.', 409);
      await t.run(`UPDATE payments SET status = 'approved', reviewed_at = $1 WHERE id = $2`, [now(), p.id]);
      const list = await t.all('SELECT * FROM bookings WHERE payment_id = $1 ORDER BY id', [p.id]);
      const confirmed = [];
      const credited = [];
      for (const b of list) {
        if (b.status === 'payment_review') {
          await t.run(`UPDATE bookings SET status = 'confirmed', paid_with = 'transfer', confirmed_at = $1 WHERE id = $2`, [now(), b.id]);
          confirmed.push(b.id);
        } else if (b.status === 'cancelled') {
          // Cancelled while the receipt was waiting: the money is real, so it becomes credit.
          await addCredit(t, b.user_id, b.amount_minor, 'Payment for a cancelled class', b.id);
          credited.push(b);
        }
      }
      return { confirmed, credited, userId: p.user_id };
    });
    for (const id of changed.confirmed) await sendConfirmation(await findBooking(db, id));
    if (changed.credited.length) {
      const u = await findUser(db, changed.userId);
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
    const info = await db.tx(async (t) => {
      await t.lock('payments', paymentId);
      const p = await findPayment(t, paymentId);
      if (!p) throw new BookingError('Payment not found.', 404);
      if (p.status !== 'pending_review') throw new BookingError('This receipt has already been reviewed.', 409);
      await t.run(`UPDATE payments SET status = 'rejected', reject_reason = $1, reviewed_at = $2 WHERE id = $3`, [why, now(), p.id]);
      const list = await t.all(`SELECT * FROM bookings WHERE payment_id = $1 AND status = 'payment_review' ORDER BY id`, [p.id]);
      for (const b of list) {
        await t.run(`UPDATE bookings SET status = 'awaiting_payment', payment_id = NULL WHERE id = $1`, [b.id]);
      }
      return { userId: p.user_id, list };
    });
    if (info.list.length) {
      const u = await findUser(db, info.userId);
      const lines = [];
      for (const b of info.list) {
        const s = await getSession(db, b.session_id);
        lines.push(`- ${s.title}, ${when(s)} (pay by ${deadlineText(hoursBefore(s, config.paymentDeadlineHours))})`);
      }
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

  // Cancels a booking and turns money already paid into credit. Returns the amount credited,
  // or null if the booking was no longer active (someone else got there first).
  async function releaseBooking(bookingId, reason, { credit = true } = {}) {
    return db.tx(async (t) => {
      await t.lock('bookings', bookingId);
      const b = await findBooking(t, bookingId);
      if (!b || !isActive(b)) return null;
      await t.run(`UPDATE bookings SET status = 'cancelled', cancel_reason = $1, cancelled_at = $2 WHERE id = $3`, [reason, now(), b.id]);
      let credited = 0;
      if (credit && b.status === 'confirmed' && PAID_METHODS.includes(b.paid_with) && b.user_id) {
        credited = b.amount_minor;
        await addCredit(t, b.user_id, credited, reason === 'class cancelled' ? 'Class cancelled by the studio' : 'Cancelled a class', b.id);
      }
      return { credited, before: b };
    });
  }

  async function sendCancellation(b, { credited, byStudio, why }) {
    const s = await getSession(db, b.session_id);
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
    const b = await findBooking(db, bookingId);
    if (!b || b.user_id !== user.id) throw new BookingError('Booking not found.', 404);
    const s = await getSession(db, b.session_id);
    if (!isActive(b)) throw new BookingError('This booking is already cancelled.', 409);
    if (!canCancel(b, s)) {
      throw new BookingError(`Online cancellation closes ${config.cancellationHours} hours before class. Please contact the studio.`, 409);
    }
    const released = await releaseBooking(b.id, 'cancelled by client');
    if (!released) throw new BookingError('This booking is already cancelled.', 409);
    const { credited, before } = released;
    await sendCancellation(before, { credited, byStudio: 'client' });
    if (config.adminNotifyEmail) {
      await mailer.send({
        to: config.adminNotifyEmail,
        subject: `Cancellation: ${b.name}, ${s.title} ${formatClassTime(s.starts_at)}`,
        text: `${b.name} (${b.phone}, ${b.email}) cancelled.` + (credited ? ` ${money(credited)} was added to her credit.` : ''),
      });
    }
    await processWaitlist(s.id);
    return { credited };
  }

  // ---------------------------------------------------------------- waitlist

  async function joinWaitlist(user, sessionId) {
    const entry = await db.tx(async (t) => {
      await t.lock('class_sessions', sessionId);
      const s = await getSession(t, sessionId);
      if (!waitlistOpen(s)) throw new BookingError('This class is no longer taking waiting-list sign-ups.', 409);
      if (await seatsLeft(t, s) > 0 && bookingOpen(s)) throw new BookingError('Good news — a spot is available, you can book it now!', 409, { available: true });
      if (await t.get(`SELECT 1 AS x FROM bookings WHERE session_id = $1 AND user_id = $2 AND status != 'cancelled'`, [s.id, user.id])) {
        throw new BookingError('You are already booked into this class.', 409);
      }
      if (await t.get(`SELECT 1 AS x FROM waitlist WHERE session_id = $1 AND user_id = $2 AND status IN ('waiting', 'offered')`, [s.id, user.id])) {
        throw new BookingError('You are already on the waiting list for this class.', 409);
      }
      const r = await t.run(`INSERT INTO waitlist (session_id, user_id, status, created_at) VALUES ($1, $2, 'waiting', $3) RETURNING id`,
        [s.id, user.id, now()]);
      return findWaitlist(t, r.id);
    });
    const s = await getSession(db, sessionId);
    const position = await waitlistPosition(db, entry);
    await mailer.send({
      to: user.email,
      subject: `You're on the waiting list: ${s.title}, ${formatClassTime(s.starts_at)}`,
      text: `Hi ${user.name},\n\nYou're number ${position} on the waiting list for:\n\n${describe(s)}\n\n` +
        `If a spot opens up we'll email you, and you'll have up to ${config.waitlistOfferHours} hours to claim it in your account: ${accountUrl('waitlist')}` + sign,
    });
    return { id: entry.id, position };
  }

  async function waitlistPosition(x, w) {
    return Number((await x.get(`SELECT COUNT(*) AS n FROM waitlist WHERE session_id = $1 AND status IN ('waiting', 'offered') AND id <= $2`,
      [w.session_id, w.id])).n);
  }

  // Offers free spots to the people at the front of the waiting list.
  async function processWaitlist(sessionId) {
    const offers = await db.tx(async (t) => {
      await t.lock('class_sessions', sessionId);
      const s = await getSession(t, sessionId);
      if (!waitlistOpen(s)) return [];
      const made = [];
      let left = await seatsLeft(t, s);
      while (left > 0) {
        const w = await t.get(`SELECT * FROM waitlist WHERE session_id = $1 AND status = 'waiting' ORDER BY id LIMIT 1`, [s.id]);
        if (!w) break;
        const expires = Math.min(now() + config.waitlistOfferHours * HOUR, hoursBefore(s, config.paymentDeadlineHours));
        await t.run(`UPDATE waitlist SET status = 'offered', offer_expires_at = $1 WHERE id = $2`, [expires, w.id]);
        made.push({ w: { ...w, offer_expires_at: expires }, s });
        left--;
      }
      return made;
    });
    for (const { w, s } of offers) {
      const u = await findUser(db, w.user_id);
      await mailer.send({
        to: u.email,
        subject: `A spot opened up: ${s.title}, ${formatClassTime(s.starts_at)}`,
        text: `Hi ${u.name},\n\nGood news — a spot has opened up and it's being held for you:\n\n${describe(s)}\n\n` +
          `Claim it by ${deadlineText(w.offer_expires_at)} in your account: ${accountUrl('waitlist')}\n\n` +
          `If you don't claim it in time, it goes to the next person on the list.` + sign,
      });
    }
    return offers.length;
  }

  async function claimOffer(user, waitlistId) {
    return db.tx(async (t) => {
      await t.lock('waitlist', waitlistId);
      const w = await findWaitlist(t, waitlistId);
      if (!w || w.user_id !== user.id) throw new BookingError('Waiting list entry not found.', 404);
      if (w.status !== 'offered' || w.offer_expires_at <= now()) throw new BookingError('Sorry, this offer is no longer available.', 409);
      const s = await getSession(t, w.session_id);
      // The offered seat passes straight to the new booking, so no capacity check is needed.
      await t.run(`UPDATE waitlist SET status = 'booked' WHERE id = $1`, [w.id]);
      const r = await t.run(`
        INSERT INTO bookings (session_id, user_id, name, email, phone, status, amount_minor, currency, waitlist_id, created_at)
        VALUES ($1, $2, $3, $4, $5, 'awaiting_payment', $6, $7, $8, $9) RETURNING id`,
      [s.id, user.id, user.name, user.email, user.phone, s.price_minor, s.currency, w.id, now()]);
      return { bookingId: r.id };
    });
  }

  async function leaveWaitlist(user, waitlistId) {
    const w = await findWaitlist(db, waitlistId);
    if (!w || w.user_id !== user.id) throw new BookingError('Waiting list entry not found.', 404);
    if (!['waiting', 'offered'].includes(w.status)) throw new BookingError('You are not on this waiting list any more.', 409);
    await db.run(`UPDATE waitlist SET status = 'removed' WHERE id = $1`, [w.id]);
    if (w.status === 'offered') await processWaitlist(w.session_id);
  }

  // ----------------------------------------------------------------- account

  async function myAccount(user) {
    const u = await findUser(db, user.id);
    const bookings = await db.all(`
      SELECT b.*, s.title, s.starts_at, s.duration_min, s.location, s.cancelled AS session_cancelled
      FROM bookings b JOIN class_sessions s ON s.id = b.session_id
      WHERE b.user_id = $1 ORDER BY s.starts_at`, [u.id]);
    const current = nowLocal();
    const view = (b) => {
      const s = { starts_at: b.starts_at, cancelled: b.session_cancelled };
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
        payBy: b.status === 'awaiting_payment' ? deadlineText(hoursBefore(s, config.paymentDeadlineHours)) : null,
        past: b.starts_at <= current,
      };
    };
    const waitRows = await db.all(`
      SELECT w.*, s.title, s.starts_at, s.duration_min FROM waitlist w JOIN class_sessions s ON s.id = w.session_id
      WHERE w.user_id = $1 AND w.status IN ('waiting', 'offered') AND s.starts_at > $2 ORDER BY s.starts_at`, [u.id, current]);
    const waitlist = [];
    for (const w of waitRows) {
      waitlist.push({
        id: w.id,
        title: w.title,
        startsAt: w.starts_at,
        durationMinutes: w.duration_min,
        status: w.offer_expires_at && w.offer_expires_at <= now() ? 'expired' : w.status,
        position: await waitlistPosition(db, w),
        offerExpires: w.status === 'offered' ? deadlineText(w.offer_expires_at) : null,
      });
    }
    const ledger = await db.all('SELECT amount_minor, reason, created_at FROM credit_ledger WHERE user_id = $1 ORDER BY id DESC LIMIT 50', [u.id]);
    const rejected = await db.get(`SELECT reject_reason FROM payments WHERE user_id = $1 AND status = 'rejected' ORDER BY id DESC LIMIT 1`, [u.id]);
    return {
      user: { email: u.email, name: u.name, phone: u.phone, injuries: u.injuries, activityLevel: u.activity_level },
      credit: money(u.credit_minor),
      creditMinor: u.credit_minor,
      upcoming: bookings.filter((b) => b.starts_at > current && b.status !== 'cancelled').map(view),
      history: bookings.filter((b) => b.starts_at <= current || b.status === 'cancelled').reverse().slice(0, 30).map(view),
      waitlist,
      ledger: ledger.map((l) => ({ amount: money(l.amount_minor), positive: l.amount_minor > 0, reason: l.reason, at: l.created_at })),
      lastRejection: rejected ? rejected.reject_reason : null,
      paymentInstructions: config.studio.paymentInstructions,
    };
  }

  async function bookingCalendar(user, bookingId) {
    const b = await findBooking(db, bookingId);
    if (!b || b.user_id !== user.id || b.status !== 'confirmed') throw new BookingError('Booking not found.', 404);
    return bookingIcs({ booking: b, session: await getSession(db, b.session_id), config });
  }

  // ----------------------------------------------------------- maintenance

  // Releases unpaid spots, sends payment reminders and passes on lapsed waitlist offers.
  async function sweep() {
    const pending = await db.all(`
      SELECT b.* FROM bookings b JOIN class_sessions s ON s.id = b.session_id
      WHERE b.status = 'awaiting_payment' AND s.starts_at > $1 ORDER BY b.id`, [localString(now() - 24 * HOUR, tz)]);
    for (const b of pending) {
      const s = await getSession(db, b.session_id);
      if (hoursBefore(s, config.paymentDeadlineHours) <= now()) {
        const released = await releaseBooking(b.id, 'unpaid');
        if (!released) continue;
        await sendCancellation(released.before, { byStudio: 'unpaid' });
        await processWaitlist(s.id);
      } else if (!b.reminder_sent && hoursBefore(s, config.paymentReminderHours) <= now()) {
        const r = await db.run('UPDATE bookings SET reminder_sent = 1 WHERE id = $1 AND reminder_sent = 0', [b.id]);
        if (!r.changes) continue;
        await mailer.send({
          to: b.email,
          subject: `Reminder: payment needed for ${s.title}, ${formatClassTime(s.starts_at)}`,
          text: `Hi ${b.name},\n\nYour spot in ${s.title} on ${when(s)} is reserved but not paid yet.\n\n` +
            `Please upload your transfer receipt by ${deadlineText(hoursBefore(s, config.paymentDeadlineHours))}, or the spot will be released: ${accountUrl('payments')}\n\n` +
            `${config.studio.paymentInstructions}` + sign,
        });
      }
    }

    const lapsed = await db.all(`SELECT * FROM waitlist WHERE status = 'offered' AND offer_expires_at <= $1 ORDER BY id`, [now()]);
    for (const w of lapsed) {
      const r = await db.run(`UPDATE waitlist SET status = 'expired' WHERE id = $1 AND status = 'offered'`, [w.id]);
      if (!r.changes) continue;
      const s = await getSession(db, w.session_id);
      const u = await findUser(db, w.user_id);
      await mailer.send({
        to: u.email,
        subject: `Waiting list offer expired: ${s.title}`,
        text: `Hi ${u.name},\n\nThe spot we held for you in ${s.title} on ${when(s)} has been passed on to the next person on the waiting list.` + sign,
      });
      await processWaitlist(w.session_id);
    }
  }

  // ------------------------------------------------------------------ admin

  async function adminSessions({ includePast = false } = {}) {
    const rows = includePast
      ? await db.all('SELECT * FROM class_sessions WHERE starts_at > $1 ORDER BY starts_at DESC LIMIT 100', [localString(now() - 60 * 86400_000, tz)])
      : await db.all('SELECT * FROM class_sessions WHERE starts_at > $1 ORDER BY starts_at', [localString(now() - 3 * HOUR, tz)]);
    const out = [];
    for (const s of rows) {
      const counts = await db.get(`
        SELECT
          (SELECT COUNT(*) FROM bookings WHERE session_id = $1 AND status IN ('awaiting_payment', 'payment_review', 'confirmed')) AS booked,
          (SELECT COUNT(*) FROM bookings WHERE session_id = $1 AND status = 'confirmed') AS paid`, [s.id]);
      out.push({ ...(await publicSession(s)), booked: Number(counts.booked), paid: Number(counts.paid), past: s.starts_at <= nowLocal() });
    }
    return out;
  }

  async function adminSessionDetail(id) {
    const s = await getSession(db, id);
    const bookings = (await db.all(`
      SELECT b.id, b.name, b.email, b.phone, b.status, b.amount_minor, b.paid_with, b.payment_id, b.cancel_reason, b.created_at,
             u.injuries, u.activity_level
      FROM bookings b LEFT JOIN users u ON u.id = b.user_id
      WHERE b.session_id = $1 ORDER BY b.id`, [s.id]))
      .map((b) => ({ ...b, amount: money(b.amount_minor) }));
    const waitlist = await db.all(`
      SELECT w.id, w.status, w.offer_expires_at, w.created_at, u.name, u.email, u.phone, u.injuries, u.activity_level
      FROM waitlist w JOIN users u ON u.id = w.user_id WHERE w.session_id = $1 ORDER BY w.id`, [s.id]);
    return {
      session: { ...(await publicSession(s)), past: s.starts_at <= nowLocal(), payDeadline: deadlineText(hoursBefore(s, config.paymentDeadlineHours)) },
      bookings,
      waitlist,
    };
  }

  async function adminPayments(status = 'pending_review') {
    const rows = await db.all(`
      SELECT p.*, u.name, u.email, u.phone FROM payments p JOIN users u ON u.id = p.user_id
      WHERE p.status = $1 ORDER BY p.id ${status === 'pending_review' ? 'ASC' : 'DESC'} LIMIT 100`, [status]);
    const out = [];
    for (const p of rows) {
      const bookings = (await db.all(`
        SELECT b.id, b.status, b.amount_minor, s.title, s.starts_at, s.duration_min
        FROM bookings b JOIN class_sessions s ON s.id = b.session_id WHERE b.payment_id = $1 ORDER BY s.starts_at`, [p.id]))
        .map((b) => ({ ...b, amount: money(b.amount_minor) }));
      out.push({
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
        bookings,
      });
    }
    return out;
  }

  async function receiptFor(paymentId, user) {
    const p = await findPayment(db, paymentId);
    if (!p || (user && p.user_id !== user.id)) throw new BookingError('Receipt not found.', 404);
    return p;
  }

  async function adminCancelBooking(bookingId, { credit = true, reason = '' } = {}) {
    const b = await findBooking(db, bookingId);
    if (!b) throw new BookingError('Booking not found.', 404);
    if (!isActive(b)) throw new BookingError('Booking is not active.', 409);
    const released = await releaseBooking(b.id, 'cancelled by studio', { credit });
    if (!released) throw new BookingError('Booking is not active.', 409);
    await sendCancellation(released.before, { credited: released.credited, byStudio: 'studio', why: String(reason || '').slice(0, 300) });
    await processWaitlist(b.session_id);
    return { credited: released.credited };
  }

  async function adminAddBooking(sessionId, input = {}) {
    const name = String(input.name || '').trim().slice(0, 100);
    const email = String(input.email || '').trim().toLowerCase().slice(0, 200);
    const phone = String(input.phone || '').trim().slice(0, 40);
    if (!name) throw new BookingError('Please enter a name.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new BookingError('Please enter a valid email address.');
    const b = await db.tx(async (t) => {
      await t.lock('class_sessions', sessionId);
      const s = await getSession(t, sessionId);
      if (await seatsLeft(t, s) === 0 && !input.overbook) throw new BookingError('Class is full.', 409, { full: true });
      const account = await t.get('SELECT id FROM users WHERE email = $1', [email]);
      const r = await t.run(`
        INSERT INTO bookings (session_id, user_id, name, email, phone, status, amount_minor, currency, paid_with, created_at, confirmed_at)
        VALUES ($1, $2, $3, $4, $5, 'confirmed', $6, $7, 'manual', $8, $9) RETURNING id`,
      [s.id, account?.id ?? null, name, email, phone, s.price_minor, s.currency, now(), now()]);
      return findBooking(t, r.id);
    });
    await sendConfirmation(b);
    return b;
  }

  async function adminSetCapacity(sessionId, capacity) {
    const cap = Number(capacity);
    if (!Number.isInteger(cap) || cap < 0 || cap > 500) throw new BookingError('Capacity must be a whole number.');
    await getSession(db, sessionId);
    await db.run('UPDATE class_sessions SET capacity = $1 WHERE id = $2', [cap, sessionId]);
    await processWaitlist(sessionId);
  }

  // Cancels a whole class: paid clients get credit, everyone is emailed.
  async function adminCancelClass(sessionId, { reason = '' } = {}) {
    const s = await getSession(db, sessionId);
    const why = String(reason || '').slice(0, 300) || 'the class has been cancelled';
    await db.run('UPDATE class_sessions SET cancelled = 1 WHERE id = $1', [s.id]);
    const active = await db.all(`SELECT id FROM bookings WHERE session_id = $1 AND status IN ('awaiting_payment', 'payment_review', 'confirmed') ORDER BY id`, [s.id]);
    let creditedTotal = 0;
    let cancelled = 0;
    for (const { id } of active) {
      const released = await releaseBooking(id, 'class cancelled');
      if (!released) continue;
      cancelled++;
      creditedTotal += released.credited;
      await sendCancellation(released.before, { credited: released.credited, byStudio: 'studio', why });
    }
    const waiting = await db.all(`
      SELECT w.id, u.name, u.email FROM waitlist w JOIN users u ON u.id = w.user_id
      WHERE w.session_id = $1 AND w.status IN ('waiting', 'offered')`, [s.id]);
    for (const w of waiting) {
      await db.run(`UPDATE waitlist SET status = 'removed' WHERE id = $1`, [w.id]);
      await mailer.send({
        to: w.email,
        subject: `Class cancelled: ${s.title}, ${formatClassTime(s.starts_at)}`,
        text: `Hi ${w.name},\n\nThe class you were waiting for has been cancelled: ${why}.\n\n${describe(s)}` + sign,
      });
    }
    return { cancelledBookings: cancelled, credited: money(creditedTotal) };
  }

  async function adminRemoveWaitlist(id) {
    const w = await findWaitlist(db, id);
    if (!w) throw new BookingError('Not found.', 404);
    await db.run(`UPDATE waitlist SET status = 'removed' WHERE id = $1`, [w.id]);
    if (w.status === 'offered') await processWaitlist(w.session_id);
  }

  // ---------------------------------------------------------------- clients

  async function adminClients(search = '') {
    const term = `%${String(search).trim().toLowerCase().slice(0, 100)}%`;
    const rows = await db.all(`
      SELECT u.id, u.email, u.name, u.phone, u.injuries, u.activity_level, u.credit_minor, u.created_at,
        (SELECT COUNT(*) FROM bookings b WHERE b.user_id = u.id AND b.status = 'confirmed') AS paid_classes,
        (SELECT COUNT(*) FROM bookings b JOIN class_sessions s ON s.id = b.session_id
           WHERE b.user_id = u.id AND b.status IN ('awaiting_payment', 'payment_review', 'confirmed') AND s.starts_at > $2) AS upcoming,
        (SELECT COUNT(*) FROM bookings b WHERE b.user_id = u.id AND b.status = 'awaiting_payment') AS unpaid
      FROM users u
      WHERE lower(u.name) LIKE $1 OR lower(u.email) LIKE $1 OR u.phone LIKE $1
      ORDER BY u.created_at DESC, u.id DESC LIMIT 500`, [term, nowLocal()]);
    return rows.map((u) => ({
      ...u,
      paid_classes: Number(u.paid_classes),
      upcoming: Number(u.upcoming),
      unpaid: Number(u.unpaid),
      credit: money(u.credit_minor),
    }));
  }

  async function adminClientDetail(id) {
    const u = await findUser(db, id);
    if (!u) throw new BookingError('Client not found.', 404);
    const bookings = (await db.all(`
      SELECT b.id, b.status, b.paid_with, b.amount_minor, b.cancel_reason, s.title, s.starts_at, s.duration_min
      FROM bookings b JOIN class_sessions s ON s.id = b.session_id
      WHERE b.user_id = $1 ORDER BY s.starts_at DESC LIMIT 100`, [u.id]))
      .map((b) => ({ ...b, amount: money(b.amount_minor), past: b.starts_at <= nowLocal() }));
    const ledger = (await db.all('SELECT amount_minor, reason, created_at FROM credit_ledger WHERE user_id = $1 ORDER BY id DESC LIMIT 50', [u.id]))
      .map((l) => ({ amount: money(l.amount_minor), positive: l.amount_minor > 0, reason: l.reason, at: l.created_at }));
    return { bookings, ledger };
  }

  // ------------------------------------------------------- class schedules

  async function cleanClass(input = {}, { oneOff = false } = {}) {
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

  async function listTemplates() {
    return (await db.all('SELECT * FROM class_templates ORDER BY active DESC, weekday, "time"')).map((t) => ({
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

  async function addTemplate(input) {
    const c = await cleanClass(input);
    await db.run(`INSERT INTO class_templates (title, description, weekday, "time", duration_min, capacity, price_minor, created_at)
                  VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [c.title, c.description, c.weekday, c.time, c.durationMin, c.capacity, c.priceMinor, now()]);
    await syncSessions();
  }

  // Future dates of a weekly class that nobody has booked or waitlisted are rebuilt from the new
  // details; dates that already have bookings keep their original time so nobody is moved silently.
  async function editTemplate(id, input) {
    const t0 = await db.get('SELECT * FROM class_templates WHERE id = $1', [id]);
    if (!t0) throw new BookingError('Class not found.', 404);
    const active = input.active === undefined ? Boolean(t0.active) : Boolean(input.active);
    const c = await cleanClass(input);
    const kept = await db.tx(async (t) => {
      await t.run(`UPDATE class_templates SET title = $1, description = $2, weekday = $3, "time" = $4, duration_min = $5, capacity = $6,
                   price_minor = $7, active = $8 WHERE id = $9`,
      [c.title, c.description, c.weekday, c.time, c.durationMin, c.capacity, c.priceMinor, active ? 1 : 0, id]);
      const future = await t.all('SELECT * FROM class_sessions WHERE template_id = $1 AND starts_at > $2 AND cancelled = 0', [id, nowLocal()]);
      let n = 0;
      for (const s of future) {
        const { used } = await t.get(`SELECT (SELECT COUNT(*) FROM bookings WHERE session_id = $1)
                                           + (SELECT COUNT(*) FROM waitlist WHERE session_id = $1) AS used`, [s.id]);
        if (Number(used)) {
          n++;
          await t.run('UPDATE class_sessions SET title = $1, description = $2 WHERE id = $3', [c.title, c.description, s.id]);
        } else {
          await t.run('DELETE FROM class_sessions WHERE id = $1', [s.id]);
        }
      }
      return n;
    });
    await syncSessions();
    return { keptWithBookings: kept };
  }

  async function addOneOffClass(input) {
    const c = await cleanClass(input, { oneOff: true });
    await db.run(`INSERT INTO class_sessions (template_id, title, description, location, starts_at, duration_min, capacity, price_minor, currency, created_at)
                  VALUES (NULL, $1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [c.title, c.description, config.studio.location, `${c.date}T${c.time}`, c.durationMin, c.capacity, c.priceMinor, currency, now()]);
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
