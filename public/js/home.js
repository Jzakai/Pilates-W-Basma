const dialog = document.getElementById('book-dialog');
const form = document.getElementById('book-form');
let sessions = [];
let activeWeek = null;
let current = null; // { session, mode: 'book' | 'waitlist' }
let studioInfo = {};

document.getElementById('year').textContent = new Date().getFullYear();

loadStudio().then((studio) => {
  document.title = `${studio.name} — Book a class`;
  studioInfo = studio;
  document.getElementById('eyebrow').textContent = studio.eyebrow;
  document.getElementById('tagline').textContent = studio.tagline;
  if (studio.notice) {
    const n = document.getElementById('hero-notice');
    n.textContent = studio.notice;
    n.hidden = false;
  }
  document.getElementById('about-text').textContent = studio.about;
  document.getElementById('location').textContent = studio.location ? `📍 ${studio.location}` : '';
  if (studio.cancellationHours > 0) {
    document.getElementById('cancel-policy').textContent =
      `Cancel online up to ${studio.cancellationHours} hours before class using the link in your confirmation email.`;
  }
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

async function loadSessions() {
  try {
    sessions = await api('/api/sessions');
  } catch (err) {
    document.getElementById('sessions').replaceChildren(el('div', { class: 'empty' }, err.message));
    return;
  }
  render();
}

function render() {
  const weeks = [...new Set(sessions.map((s) => weekStart(s.startsAt)))];
  if (!weeks.includes(activeWeek)) activeWeek = weeks[0] ?? null;

  document.getElementById('week-tabs').replaceChildren(
    ...weeks.map((w, i) =>
      el('button', {
        role: 'tab',
        'aria-selected': String(w === activeWeek),
        onclick: () => { activeWeek = w; render(); },
      }, weekLabel(w, i)),
    ),
  );

  const container = document.getElementById('sessions');
  const inWeek = sessions.filter((s) => weekStart(s.startsAt) === activeWeek);
  if (!inWeek.length) {
    container.replaceChildren(el('div', { class: 'empty' }, 'No classes are scheduled at the moment — check back soon.'));
    return;
  }

  const byDay = new Map();
  for (const s of inWeek) {
    const day = s.startsAt.slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(s);
  }

  container.replaceChildren(
    ...[...byDay].map(([day, list]) =>
      el('div', { class: 'day' },
        el('p', { class: 'day-label' }, fmtDay(day + 'T00:00')),
        list.map(card),
      ),
    ),
  );
}

function card(s) {
  let badge;
  let action;
  if (s.cancelled) {
    badge = el('span', { class: 'badge danger' }, 'Cancelled');
  } else if (s.full) {
    badge = el('span', { class: 'badge full' }, s.waitlistCount ? `Full · ${s.waitlistCount} waiting` : 'Full');
    action = el('button', { class: 'btn clay small', onclick: () => open(s, 'waitlist') }, 'Join waiting list');
  } else {
    badge = el('span', { class: `badge${s.spotsLeft <= 3 ? ' low' : ''}` },
      s.spotsLeft === 1 ? '1 spot left' : `${s.spotsLeft} spots left`);
    action = el('button', { class: 'btn small', onclick: () => open(s, 'book') }, 'Book');
  }

  return el('article', { class: `class-card${s.cancelled ? ' cancelled' : ''}` },
    el('div', { class: 'time' }, fmtTime(s.startsAt).split(' ')[0],
      el('small', {}, `${fmtTime(s.startsAt).split(' ')[1]} · ${s.durationMinutes} min`)),
    el('div', {},
      el('h3', {}, s.title),
      el('div', { class: 'meta' }, [s.description, s.price].filter(Boolean).join(' · ')),
    ),
    el('div', { class: 'actions' }, badge, action),
  );
}

function open(session, mode) {
  current = { session, mode };
  document.getElementById('dialog-title').textContent = mode === 'book' ? 'Book your spot' : 'Join the waiting list';
  document.getElementById('dialog-class').replaceChildren(
    el('strong', {}, session.title),
    fmtClass(session),
    mode === 'book' ? el('div', {}, session.price) : null,
  );
  document.getElementById('dialog-notice').replaceChildren(
    mode === 'waitlist'
      ? el('div', { class: 'notice warn' },
        `This class is full. Join the waiting list and we'll email you if a spot opens up — you won't be charged unless you claim it.`)
      : '',
  );
  document.getElementById('pay-field').hidden = mode !== 'book' || !studioInfo.bankTransfer;
  document.getElementById('dialog-submit').textContent = submitLabel(mode);
  document.getElementById('dialog-submit').disabled = false;
  document.getElementById('dialog-fine').textContent = [
    studioInfo.notice,
    mode === 'book' ? 'Online payments are processed securely by our payment provider.' : '',
  ].filter(Boolean).join(' ');
  if (!dialog.open) dialog.showModal();
  form.elements.name.focus();
}

function submitLabel(mode) {
  if (mode === 'waitlist') return 'Join waiting list';
  return form.elements.paymentMethod.value === 'transfer' ? 'Reserve my spot' : 'Continue to payment';
}

form.addEventListener('change', (e) => {
  if (e.target.name === 'paymentMethod') document.getElementById('dialog-submit').textContent = submitLabel(current.mode);
});

function showError(message) {
  document.getElementById('dialog-notice').replaceChildren(el('div', { class: 'notice error' }, message));
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!form.reportValidity()) return;
  const data = Object.fromEntries(new FormData(form));
  const submit = document.getElementById('dialog-submit');
  submit.disabled = true;
  submit.textContent = 'Please wait…';
  const { session, mode } = current;

  try {
    if (mode === 'book') {
      const { redirectUrl } = await api(`/api/sessions/${session.id}/book`, { body: data });
      location.href = redirectUrl;
      return;
    }
    const { position } = await api(`/api/sessions/${session.id}/waitlist`, { body: data });
    document.getElementById('dialog-notice').replaceChildren(
      el('div', { class: 'notice info' },
        `You're number ${position} on the waiting list. We've sent a confirmation to ${data.email}.`),
    );
    submit.textContent = 'Done';
    submit.disabled = false;
    submit.onclick = (e) => { e.preventDefault(); dialog.close(); submit.onclick = null; };
    loadSessions();
  } catch (err) {
    if (err.full) {
      // Someone took the last spot while the form was open.
      const refreshed = { ...session, full: true };
      open(refreshed, 'waitlist');
      Object.entries(data).forEach(([k, v]) => form.elements[k] && (form.elements[k].value = v));
      showError('Sorry — the last spot was just taken. You can join the waiting list instead.');
      loadSessions();
      return;
    }
    if (err.available) {
      open({ ...session, full: false }, 'book');
      Object.entries(data).forEach(([k, v]) => form.elements[k] && (form.elements[k].value = v));
      showError(err.message);
      loadSessions();
      return;
    }
    showError(err.message);
    submit.disabled = false;
    submit.textContent = submitLabel(mode);
  }
});

dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());
dialog.addEventListener('close', () => form.reset());

loadSessions();
setInterval(loadSessions, 60_000);
