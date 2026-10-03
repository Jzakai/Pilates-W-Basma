let selected = null;
loadStudio();

const showPast = document.getElementById('show-past');
showPast.addEventListener('change', loadList);

async function loadList() {
  const list = document.getElementById('session-list');
  try {
    const sessions = await api(`/api/admin/sessions${showPast.checked ? '?past=1' : ''}`);
    if (!sessions.length) return list.replaceChildren(el('p', { style: 'padding:16px' }, 'No classes.'));
    list.replaceChildren(...sessions.map((s) =>
      el('button', { 'aria-current': String(s.id === selected), onclick: () => select(s.id) },
        el('div', { class: 'row1' }, el('span', {}, `${fmtDay(s.startsAt, { weekday: 'short', day: 'numeric', month: 'short' })} · ${fmtTime(s.startsAt)}`),
          s.cancelled ? el('span', { class: 'badge danger' }, 'Cancelled')
            : el('span', { class: `badge${s.full ? ' full' : ''}` }, `${s.booked}/${s.capacity}`)),
        el('div', { class: 'row2' }, s.title + (s.waitlistCount ? ` · ${s.waitlistCount} waiting` : '') + (s.past ? ' · past' : '')),
      )));
  } catch (err) {
    list.replaceChildren(el('p', { style: 'padding:16px' }, err.message));
  }
}

function select(id) {
  selected = id;
  loadList();
  loadDetail();
}

const STATUS = {
  confirmed: ['Confirmed', ''],
  pending: ['Paying…', 'low'],
  transfer: ['Awaiting transfer', 'low'],
  cancelled: ['Cancelled', 'danger'],
  waiting: ['Waiting', 'full'],
  offered: ['Offered', 'low'],
  claiming: ['Paying…', 'low'],
  booked: ['Booked', ''],
  expired: ['Expired', 'full'],
  removed: ['Removed', 'full'],
};
const PAID_BY = { moyasar: 'Online', stripe: 'Online', demo: 'Online (demo)', transfer: 'Transfer', manual: 'At studio', free: 'Free' };
const statusBadge = (st) => el('span', { class: `badge ${STATUS[st]?.[1] ?? ''}` }, STATUS[st]?.[0] ?? st);
const when = (ms) => new Date(ms).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });

async function loadDetail() {
  const detail = document.getElementById('detail');
  let d;
  try {
    d = await api(`/api/admin/sessions/${selected}`);
  } catch (err) {
    return detail.replaceChildren(el('div', { class: 'empty' }, err.message));
  }
  const s = d.session;
  const active = d.bookings.filter((b) => b.status !== 'cancelled');
  const activeWaitlist = d.waitlist.filter((w) => ['waiting', 'offered', 'claiming'].includes(w.status));

  const summary = el('div', { class: 'card' },
    el('h3', {}, `${s.title} — ${fmtClass(s)}`),
    s.cancelled ? el('div', { class: 'notice error' }, 'This class has been cancelled.') : null,
    el('div', { class: 'stats' },
      el('div', {}, el('strong', {}, active.filter((b) => b.status === 'confirmed').length), 'booked'),
      el('div', {}, el('strong', {}, s.spotsLeft), 'spots left'),
      el('div', {}, el('strong', {}, activeWaitlist.length), 'on waiting list'),
      el('div', {}, el('strong', {}, s.price), 'per class')),
    s.cancelled || s.past ? null : el('form', { class: 'inline-form', onsubmit: setCapacity },
      el('label', {}, 'Capacity', el('input', { name: 'capacity', type: 'number', min: 0, max: 500, value: s.capacity })),
      el('button', { class: 'btn secondary small', type: 'submit' }, 'Update'),
      el('button', { class: 'btn danger small', type: 'button', onclick: cancelClass }, 'Cancel class')),
  );

  const bookings = el('div', { class: 'card' },
    el('h3', {}, 'Bookings'),
    d.bookings.length ? el('div', { class: 'table-wrap' }, el('table', {},
      el('thead', {}, el('tr', {}, ['Name', 'Contact', 'Paid', 'Status', ''].map((t) => el('th', {}, t)))),
      el('tbody', {}, d.bookings.map((b) => el('tr', {},
        el('td', {}, b.name,
          b.first_time === 'yes' ? el('div', {}, el('span', { class: 'badge low' }, 'First time')) : null,
          b.notes ? el('div', { class: 'sub' }, `📝 ${b.notes}`) : null),
        el('td', {}, el('a', { href: `mailto:${b.email}` }, b.email), b.phone ? el('div', { class: 'sub' }, b.phone) : null),
        el('td', {}, ['manual', 'free'].includes(b.payment_provider) ? '—' : b.amount,
          el('div', { class: 'sub' }, PAID_BY[b.payment_provider] ?? b.payment_provider),
          b.refunded ? el('div', { class: 'sub' }, 'refunded') : null),
        el('td', {}, statusBadge(b.status === 'pending' && b.payment_provider === 'transfer' ? 'transfer' : b.status),
          b.status === 'pending' && b.payment_provider === 'transfer' ? el('div', { class: 'sub' }, `until ${when(b.hold_expires_at)}`) : null),
        el('td', { style: 'white-space:nowrap' },
          b.payment_provider === 'transfer' && ['pending', 'expired'].includes(b.status)
            ? el('button', { class: 'btn small', onclick: () => markPaid(b) }, 'Mark paid') : null,
          ' ',
          ['confirmed', 'pending'].includes(b.status) && !s.past
            ? el('button', { class: 'btn danger small', onclick: () => cancelBooking(b) }, 'Cancel') : null),
      ))),
    )) : el('p', { class: 'fine' }, 'No bookings yet.'),
  );

  const waitlist = el('div', { class: 'card' },
    el('h3', {}, 'Waiting list'),
    d.waitlist.length ? el('div', { class: 'table-wrap' }, el('table', {},
      el('thead', {}, el('tr', {}, ['#', 'Name', 'Contact', 'Status', ''].map((t) => el('th', {}, t)))),
      el('tbody', {}, d.waitlist.map((w, i) => el('tr', {},
        el('td', {}, i + 1),
        el('td', {}, w.name, el('div', { class: 'sub' }, `joined ${when(w.created_at)}`),
          w.first_time === 'yes' ? el('div', {}, el('span', { class: 'badge low' }, 'First time')) : null,
          w.notes ? el('div', { class: 'sub' }, `📝 ${w.notes}`) : null),
        el('td', {}, el('a', { href: `mailto:${w.email}` }, w.email), w.phone ? el('div', { class: 'sub' }, w.phone) : null),
        el('td', {}, statusBadge(w.status),
          w.status === 'offered' ? el('div', { class: 'sub' }, `until ${when(w.offer_expires_at)}`) : null),
        el('td', {}, ['waiting', 'offered'].includes(w.status)
          ? el('button', { class: 'btn secondary small', onclick: () => removeWaitlist(w) }, 'Remove') : null),
      ))),
    )) : el('p', { class: 'fine' }, 'Nobody is waiting.'),
  );

  const add = s.cancelled || s.past ? null : el('div', { class: 'card' },
    el('h3', {}, 'Add a booking manually'),
    el('p', { class: 'fine' }, 'For clients who booked with you directly. They will get a confirmation email.'),
    el('form', { class: 'inline-form', onsubmit: addBooking },
      el('label', {}, 'Name', el('input', { name: 'name', required: true })),
      el('label', {}, 'Email', el('input', { name: 'email', type: 'email', required: true })),
      el('label', {}, 'Phone', el('input', { name: 'phone', type: 'tel' })),
      el('button', { class: 'btn small', type: 'submit' }, 'Add')),
  );

  detail.replaceChildren(summary, bookings, waitlist, add ?? '');
}

async function act(fn) {
  try {
    await fn();
  } catch (err) {
    alert(err.message);
  }
  loadList();
  loadDetail();
}

function setCapacity(e) {
  e.preventDefault();
  act(() => api(`/api/admin/sessions/${selected}/capacity`, { body: { capacity: Number(e.target.capacity.value) } }));
}

function cancelClass() {
  const reason = prompt('Cancel this class? Everyone booked will be refunded and emailed.\n\nOptional reason to include in the email:');
  if (reason === null) return;
  act(async () => {
    const r = await api(`/api/admin/sessions/${selected}/cancel`, { body: { reason } });
    if (r.failedRefunds.length) alert(`Some refunds failed — please refund these manually:\n${r.failedRefunds.join('\n')}`);
  });
}

function cancelBooking(b) {
  if (!confirm(`Cancel ${b.name}'s booking? The next person on the waiting list will be offered the spot.`)) return;
  const refund = b.amount_minor > 0 && b.status === 'confirmed' && !['manual', 'transfer'].includes(b.payment_provider)
    ? confirm(`Refund ${b.amount} to ${b.name}?\n\nOK = refund, Cancel = no refund`)
    : false;
  act(() => api(`/api/admin/bookings/${b.id}/cancel`, { body: { refund } }));
}

function markPaid(b) {
  if (!confirm(`Confirm you received ${b.amount} from ${b.name}? She will get a confirmation email.`)) return;
  act(() => api(`/api/admin/bookings/${b.id}/paid`, { body: {} }));
}

function removeWaitlist(w) {
  if (!confirm(`Remove ${w.name} from the waiting list?`)) return;
  act(() => api(`/api/admin/waitlist/${w.id}/remove`, { body: {} }));
}

function addBooking(e) {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(e.target));
  act(async () => {
    try {
      await api(`/api/admin/sessions/${selected}/bookings`, { body: data });
    } catch (err) {
      if (err.full && confirm('The class is full. Add them anyway (over capacity)?')) {
        await api(`/api/admin/sessions/${selected}/bookings`, { body: { ...data, overbook: true } });
      } else throw err;
    }
  });
}

loadList();
