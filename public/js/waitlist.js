const token = param('token');
const panel = document.getElementById('panel');
loadStudio();

function classInfo(s) {
  return el('div', { class: 'details' },
    el('div', {}, el('span', {}, 'Class'), el('strong', {}, s.title)),
    el('div', {}, el('span', {}, 'When'), el('span', {}, fmtClass(s))),
    el('div', {}, el('span', {}, 'Price'), el('span', {}, s.price)),
  );
}

function remaining(ms) {
  const mins = Math.max(0, Math.round((ms - Date.now()) / 60000));
  return mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins} minutes`;
}

async function load() {
  if (!token) return panel.replaceChildren(el('p', {}, 'Link is missing.'));
  let w;
  try {
    w = await api(`/api/waitlist/${encodeURIComponent(token)}`);
  } catch (err) {
    return panel.replaceChildren(el('h2', {}, 'Not found'), el('p', {}, err.message));
  }

  const leave = el('button', { class: 'btn danger block', onclick: leaveList }, 'Leave the waiting list');
  const nodes = [];
  if (w.session.cancelled) {
    nodes.push(el('div', { class: 'icon muted' }, '×'), el('h2', {}, 'Class cancelled'),
      el('p', {}, 'Sorry, this class has been cancelled.'), classInfo(w.session));
  } else if (w.status === 'offered') {
    nodes.push(el('div', { class: 'icon' }, '★'), el('h2', {}, 'A spot is waiting for you'),
      el('p', {}, `Hi ${w.name}, a spot opened up and it's being held for you for another ${remaining(w.offerExpiresAt)}.`),
      classInfo(w.session),
      el('div', { class: 'stack' },
        el('button', { class: 'btn block claim', onclick: () => claim('online') }, 'Pay online & confirm my spot'),
        (await loadStudio()).bankTransfer
          ? el('button', { class: 'btn secondary block claim', onclick: () => claim('transfer') }, 'Reserve & pay by bank transfer / STC Pay')
          : null,
        el('button', { class: 'btn secondary block', onclick: leaveList }, "No thanks, I can't make it")));
  } else if (w.status === 'waiting') {
    nodes.push(el('div', { class: 'icon warn' }, w.position), el('h2', {}, "You're on the waiting list"),
      el('p', {}, `You're number ${w.position} in line. If a spot opens up we'll email ${w.email} with a link to claim it.`),
      classInfo(w.session), leave);
  } else if (w.status === 'booked') {
    nodes.push(el('div', { class: 'icon' }, '✓'), el('h2', {}, "You're booked"),
      el('p', {}, 'You claimed your spot — check your email for the confirmation.'), classInfo(w.session));
  } else if (w.status === 'expired') {
    nodes.push(el('div', { class: 'icon muted' }, '×'), el('h2', {}, 'Offer expired'),
      el('p', {}, 'The spot was not claimed in time and has been offered to the next person.'), classInfo(w.session),
      el('a', { class: 'btn secondary block', href: '/#schedule' }, 'See other classes'));
  } else {
    nodes.push(el('div', { class: 'icon muted' }, '×'), el('h2', {}, 'Removed from waiting list'),
      el('p', {}, "You're no longer on the waiting list for this class."), classInfo(w.session),
      el('a', { class: 'btn secondary block', href: '/#schedule' }, 'See other classes'));
  }
  panel.replaceChildren(...nodes);
}

async function claim(paymentMethod) {
  document.querySelectorAll('.claim').forEach((btn) => (btn.disabled = true));
  try {
    const { redirectUrl } = await api(`/api/waitlist/${encodeURIComponent(token)}/claim`, { body: { paymentMethod } });
    location.href = redirectUrl;
  } catch (err) {
    alert(err.message);
    load();
  }
}

async function leaveList() {
  if (!confirm('Leave the waiting list for this class?')) return;
  try {
    await api(`/api/waitlist/${encodeURIComponent(token)}/leave`, { body: {} });
  } catch (err) {
    alert(err.message);
  }
  load();
}

load();
