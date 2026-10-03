const token = param('token');
const panel = document.getElementById('panel');
loadStudio();

function details(b) {
  const s = b.session;
  return el('div', { class: 'details' },
    el('div', {}, el('span', {}, 'Class'), el('strong', {}, s.title)),
    el('div', {}, el('span', {}, 'When'), el('span', {}, fmtClass(s))),
    s.location ? el('div', {}, el('span', {}, 'Where'), el('span', {}, s.location)) : null,
    el('div', {}, el('span', {}, 'Name'), el('span', {}, b.name)),
    el('div', {}, el('span', {}, 'Paid'), el('span', {}, b.status === 'confirmed' || b.refunded ? b.amount : '—')),
  );
}

async function load(attempt = 0) {
  if (!token) return panel.replaceChildren(el('p', {}, 'Booking link is missing.'));
  let b;
  try {
    b = await api(`/api/bookings/${encodeURIComponent(token)}`);
  } catch (err) {
    return panel.replaceChildren(el('h2', {}, 'Booking not found'), el('p', {}, err.message));
  }

  // Just back from the payment page, waiting for the gateway to confirm.
  if (b.status === 'pending' && param('new') && attempt < 10) {
    panel.replaceChildren(el('div', { class: 'icon muted' }, '…'), el('h2', {}, 'Confirming your payment'),
      el('p', {}, 'This only takes a moment.'));
    return setTimeout(() => load(attempt + 1), 2000);
  }

  const nodes = [];
  if (b.status === 'confirmed') {
    nodes.push(el('div', { class: 'icon' }, '✓'), el('h2', {}, param('new') ? "You're booked!" : 'Your booking'),
      el('p', {}, `A confirmation has been sent to ${b.email}. See you on the mat!`), details(b));
    if (b.canCancel) {
      nodes.push(el('button', { class: 'btn danger block', onclick: () => cancel(b) }, 'Cancel my booking'),
        el('p', { class: 'fine', style: 'margin-top:10px' },
          `You can cancel online up to ${b.cancellationHours} hours before class` +
          (b.refundOnCancel ? ' and you will receive a full refund.' : '.')));
    } else if (!b.session.cancelled) {
      nodes.push(el('p', { class: 'fine' }, `Online cancellation closes ${b.cancellationHours} hours before class — please contact the studio if you can't make it.`));
    }
  } else if (b.status === 'cancelled') {
    nodes.push(el('div', { class: 'icon muted' }, '×'), el('h2', {}, 'Booking cancelled'),
      el('p', {}, b.refunded ? 'Your payment has been refunded. It can take 5–10 days to appear on your statement.' : 'This booking has been cancelled.'),
      details(b), el('a', { class: 'btn secondary block', href: '/#schedule' }, 'Book another class'));
  } else if (b.status === 'pending') {
    nodes.push(el('div', { class: 'icon warn' }, '!'), el('h2', {}, param('cancelled_checkout') ? 'Payment not completed' : 'Waiting for payment'),
      el('p', {}, param('cancelled_checkout')
        ? 'Your payment was not completed, so the spot has not been booked yet. It is held for you for a few more minutes.'
        : "We haven't received confirmation of your payment yet. If you were charged, you'll get a confirmation email shortly."),
      details(b), el('a', { class: 'btn block', href: '/#schedule' }, 'Back to the timetable'));
  } else {
    nodes.push(el('div', { class: 'icon muted' }, '×'), el('h2', {}, 'Booking expired'),
      el('p', {}, 'The payment was not completed in time, so the spot was released. You were not charged.'),
      details(b), el('a', { class: 'btn block', href: '/#schedule' }, 'Try booking again'));
  }
  panel.replaceChildren(...nodes);
}

async function cancel(b) {
  if (!confirm(`Cancel your booking for ${b.session.title} on ${fmtClass(b.session)}?`)) return;
  try {
    await api(`/api/bookings/${encodeURIComponent(token)}/cancel`, { body: {} });
    history.replaceState(null, '', `?token=${encodeURIComponent(token)}`);
    load();
  } catch (err) {
    alert(err.message);
  }
}

load();
