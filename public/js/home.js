let sessions = [];
let activeWeek = null;
let studioInfo = {};
const selected = new Set(JSON.parse(sessionStorage.getItem('selectedClasses') || '[]'));

document.getElementById('year').textContent = new Date().getFullYear();

loadStudio().then((studio) => {
  studioInfo = studio;
  document.title = `${studio.name} — Book a class`;
  document.getElementById('eyebrow').textContent = studio.eyebrow;
  document.getElementById('tagline').textContent = studio.tagline;
  document.getElementById('location').textContent = studio.location ? `📍 ${studio.location}` : '';
  if (studio.notice) {
    const n = document.getElementById('hero-notice');
    n.textContent = studio.notice;
    n.hidden = false;
  }
  // Booking rules in the "How booking works" steps, e.g. 48 → "2 days".
  for (const b of document.querySelectorAll('[data-hours]')) {
    const h = studio[b.dataset.hours];
    if (h === undefined) continue;
    b.textContent = h % 24 === 0 ? `${h / 24} day${h === 24 ? '' : 's'}` : `${h} hour${h === 1 ? '' : 's'}`;
  }
  render();
});

// Monday of the week containing a "YYYY-MM-DD" date.
function weekStart(local) {
  const { date } = parseLocal(local);
  const offset = (date.getUTCDay() + 6) % 7;
  return new Date(date.getTime() - offset * 86400000).toISOString().slice(0, 10);
}

function weekLabel(start, index) {
  if (index === 0 && weekStart(new Date().toISOString().slice(0, 10) + 'T00:00') === start) return 'This week';
  return `Week of ${fmtDay(start + 'T00:00', { day: 'numeric', month: 'short' })}`;
}

function notify(message, kind = 'info') {
  let box = document.getElementById('schedule-notice');
  if (!box) {
    box = el('div', { id: 'schedule-notice' });
    document.getElementById('sessions').before(box);
  }
  box.replaceChildren(el('div', { class: `notice ${kind}` }, message));
  box.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function loadSessions() {
  try {
    sessions = await api('/api/sessions');
  } catch (err) {
    document.getElementById('sessions').replaceChildren(el('div', { class: 'empty' }, err.message));
    return;
  }
  // Drop selections that can no longer be booked.
  for (const id of [...selected]) {
    const s = sessions.find((x) => x.id === id);
    if (!s || !canBook(s)) selected.delete(id);
  }
  render();
}

const canBook = (s) => !s.cancelled && s.bookingOpen && !s.full && !s.myBooking;

function render() {
  const weeks = [...new Set(sessions.map((s) => weekStart(s.startsAt)))];
  if (!weeks.includes(activeWeek)) activeWeek = weeks[0] ?? null;

  document.getElementById('week-tabs').replaceChildren(
    ...weeks.map((w, i) =>
      el('button', { role: 'tab', 'aria-selected': String(w === activeWeek), onclick: () => { activeWeek = w; render(); } },
        weekLabel(w, i)),
    ),
  );

  const container = document.getElementById('sessions');
  const inWeek = sessions.filter((s) => weekStart(s.startsAt) === activeWeek);
  if (!inWeek.length) {
    container.replaceChildren(el('div', { class: 'empty' }, 'No classes are scheduled at the moment — check back soon.'));
  } else {
    const byDay = new Map();
    for (const s of inWeek) {
      const day = s.startsAt.slice(0, 10);
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day).push(s);
    }
    container.replaceChildren(...[...byDay].map(([day, list]) =>
      el('div', { class: 'day' }, el('p', { class: 'day-label' }, fmtDay(day + 'T00:00')), list.map(card))));
  }
  renderBar();
}

function card(s) {
  let badge;
  let action = null;
  if (s.cancelled) {
    badge = el('span', { class: 'badge danger' }, 'Cancelled');
  } else if (s.myBooking) {
    badge = el('span', { class: `badge${s.myBooking === 'confirmed' ? '' : ' low'}` },
      s.myBooking === 'confirmed' ? 'You’re booked' : s.myBooking === 'payment_review' ? 'Receipt being checked' : 'Booked · payment due');
    action = el('a', { class: 'btn secondary small', href: '/account.html#bookings' }, 'My bookings');
  } else if (s.myWaitlist) {
    badge = el('span', { class: 'badge low' }, s.myWaitlist === 'offered' ? 'Spot offered to you!' : 'On waiting list');
    action = el('a', { class: 'btn secondary small', href: '/account.html#waitlist' }, 'View');
  } else if (s.full) {
    badge = el('span', { class: 'badge full' }, s.waitlistCount ? `Full · ${s.waitlistCount} waiting` : 'Full');
    if (s.waitlistOpen) action = el('button', { class: 'btn clay small', onclick: () => joinWaitlist(s) }, 'Join waiting list');
  } else if (!s.bookingOpen) {
    badge = el('span', { class: 'badge full' }, 'Booking closed');
  } else {
    badge = el('span', { class: `badge${s.spotsLeft <= 3 ? ' low' : ''}` }, s.spotsLeft === 1 ? '1 spot left' : `${s.spotsLeft} spots left`);
    const on = selected.has(s.id);
    action = el('button', {
      class: `btn small${on ? '' : ' secondary'}`,
      'aria-pressed': String(on),
      onclick: () => toggle(s.id),
    }, on ? '✓ Selected' : 'Select');
  }

  return el('article', { class: `class-card${s.cancelled ? ' cancelled' : ''}${selected.has(s.id) ? ' selected' : ''}` },
    el('div', { class: 'time' }, fmtTime(s.startsAt).split(' ')[0],
      el('small', {}, `${fmtTime(s.startsAt).split(' ')[1]} · ${s.durationMinutes} min`)),
    el('div', {}, el('h3', {}, s.title), el('div', { class: 'meta' }, [s.description, s.price].filter(Boolean).join(' · '))),
    el('div', { class: 'actions' }, badge, action),
  );
}

function toggle(id) {
  selected.has(id) ? selected.delete(id) : selected.add(id);
  sessionStorage.setItem('selectedClasses', JSON.stringify([...selected]));
  render();
}

function renderBar() {
  const bar = document.getElementById('select-bar');
  const chosen = sessions.filter((s) => selected.has(s.id));
  bar.hidden = chosen.length === 0;
  if (!chosen.length) return;
  const total = chosen.reduce((sum, s) => sum + s.priceMinor, 0);
  document.getElementById('select-summary').textContent =
    `${chosen.length} class${chosen.length > 1 ? 'es' : ''} selected · ${money(total)}`;
  document.getElementById('select-book').textContent = `Book ${chosen.length > 1 ? 'classes' : 'class'}`;
}

document.getElementById('select-clear').addEventListener('click', () => {
  selected.clear();
  sessionStorage.removeItem('selectedClasses');
  render();
});

document.getElementById('select-book').addEventListener('click', async (e) => {
  const user = await loadMe();
  if (!user) return goToSignIn();
  const btn = e.currentTarget;
  btn.disabled = true;
  try {
    const result = await api('/api/bookings', { body: { sessionIds: [...selected] } });
    selected.clear();
    sessionStorage.removeItem('selectedClasses');
    sessionStorage.setItem('bookingResult', JSON.stringify(result));
    location.href = '/account.html#payments';
  } catch (err) {
    if (err.signIn) return goToSignIn();
    notify(err.message, 'error');
    btn.disabled = false;
  }
});

async function joinWaitlist(s) {
  const user = await loadMe();
  if (!user) return goToSignIn();
  try {
    const { position } = await api(`/api/sessions/${s.id}/waitlist`, { body: {} });
    notify(`You're number ${position} on the waiting list for ${s.title}, ${fmtClass(s)}. We'll email you if a spot opens up.`);
    loadSessions();
  } catch (err) {
    notify(err.message, 'error');
    loadSessions();
  }
}

loadSessions();
setInterval(loadSessions, 60_000);
