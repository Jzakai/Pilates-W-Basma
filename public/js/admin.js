let selected = null;
let studio = {};
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
loadStudio().then((s) => { studio = s; });

// ----------------------------------------------------------------- tabs

function showTab(name) {
  document.querySelectorAll('#admin-tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  document.querySelectorAll('[data-panel]').forEach((p) => (p.hidden = p.dataset.panel !== name));
  if (name === 'receipts') loadReceipts();
  if (name === 'schedule') loadTemplates();
  if (name === 'clients') loadClients();
  if (name === 'classes') loadList();
}
document.querySelectorAll('#admin-tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

const STATUS = {
  confirmed: ['Paid', ''],
  awaiting_payment: ['Payment due', 'low'],
  payment_review: ['Receipt to check', 'low'],
  cancelled: ['Cancelled', 'danger'],
  waiting: ['Waiting', 'full'],
  offered: ['Offered', 'low'],
  booked: ['Booked', ''],
  expired: ['Expired', 'full'],
  removed: ['Removed', 'full'],
};
const PAID_BY = { transfer: 'Transfer', credit: 'Credit', manual: 'Added by you', free: 'Free' };
const statusBadge = (st) => el('span', { class: `badge ${STATUS[st]?.[1] ?? ''}` }, STATUS[st]?.[0] ?? st);
const when = (ms) => new Date(ms).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
const classWhen = (b) => `${fmtDay(b.starts_at, { weekday: 'short', day: 'numeric', month: 'short' })} · ${fmtTime(b.starts_at)}`;

async function act(fn, after) {
  try {
    await fn();
  } catch (err) {
    alert(err.message);
  }
  after();
}

// -------------------------------------------------------------- classes

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
        el('div', { class: 'row2' }, s.title + ` · ${s.paid} paid` + (s.waitlistCount ? ` · ${s.waitlistCount} waiting` : '') + (s.past ? ' · past' : '')),
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

const refresh = () => { loadList(); loadDetail(); };

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
  const activeWaitlist = d.waitlist.filter((w) => ['waiting', 'offered'].includes(w.status));
  const person = (x) => [
    x.name,
    x.activity_level ? el('div', { class: 'sub' }, x.activity_level) : null,
    x.injuries ? el('div', { class: 'sub' }, `🩹 ${x.injuries}`) : null,
  ];

  const summary = el('div', { class: 'card' },
    el('h3', {}, `${s.title} — ${fmtClass(s)}`),
    s.cancelled ? el('div', { class: 'notice error' }, 'This class has been cancelled.') : null,
    el('div', { class: 'stats' },
      el('div', {}, el('strong', {}, active.filter((b) => b.status === 'confirmed').length), 'paid'),
      el('div', {}, el('strong', {}, active.filter((b) => b.status !== 'confirmed').length), 'awaiting payment'),
      el('div', {}, el('strong', {}, s.spotsLeft), 'spots left'),
      el('div', {}, el('strong', {}, activeWaitlist.length), 'waiting'),
      el('div', {}, el('strong', {}, s.price), 'per class')),
    s.cancelled || s.past ? null : el('p', { class: 'fine' }, `Unpaid spots are released ${s.payDeadline}.`),
    s.cancelled || s.past ? null : el('form', { class: 'inline-form', onsubmit: setCapacity },
      el('label', {}, 'Capacity', el('input', { name: 'capacity', type: 'number', min: 0, max: 500, value: s.capacity })),
      el('button', { class: 'btn secondary small', type: 'submit' }, 'Update'),
      el('button', { class: 'btn danger small', type: 'button', onclick: cancelClass }, 'Cancel class')),
  );

  const bookings = el('div', { class: 'card' },
    el('h3', {}, 'Bookings'),
    d.bookings.length ? el('div', { class: 'table-wrap' }, el('table', {},
      el('thead', {}, el('tr', {}, ['Name', 'Contact', 'Payment', 'Status', ''].map((t) => el('th', {}, t)))),
      el('tbody', {}, d.bookings.map((b) => el('tr', {},
        el('td', {}, person(b)),
        el('td', {}, el('a', { href: `mailto:${b.email}` }, b.email), b.phone ? el('div', { class: 'sub' }, b.phone) : null),
        el('td', {}, b.amount, el('div', { class: 'sub' }, PAID_BY[b.paid_with] ?? (b.status === 'cancelled' ? '' : 'Not paid yet'))),
        el('td', {}, statusBadge(b.status), b.cancel_reason ? el('div', { class: 'sub' }, b.cancel_reason) : null),
        el('td', {}, ['confirmed', 'awaiting_payment', 'payment_review'].includes(b.status) && !s.past
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
        el('td', {}, person(w), el('div', { class: 'sub' }, `joined ${when(w.created_at)}`)),
        el('td', {}, el('a', { href: `mailto:${w.email}` }, w.email), el('div', { class: 'sub' }, w.phone)),
        el('td', {}, statusBadge(w.status), w.status === 'offered' ? el('div', { class: 'sub' }, `until ${when(w.offer_expires_at)}`) : null),
        el('td', {}, ['waiting', 'offered'].includes(w.status)
          ? el('button', { class: 'btn secondary small', onclick: () => removeWaitlist(w) }, 'Remove') : null),
      ))),
    )) : el('p', { class: 'fine' }, 'Nobody is waiting.'),
  );

  const add = s.cancelled || s.past ? null : el('div', { class: 'card' },
    el('h3', {}, 'Add a booking manually'),
    el('p', { class: 'fine' }, 'For someone who paid you directly (e.g. cash). The booking is marked as paid and she gets a confirmation email.'),
    el('form', { class: 'inline-form', onsubmit: addBooking },
      el('label', {}, 'Name', el('input', { name: 'name', required: true })),
      el('label', {}, 'Email', el('input', { name: 'email', type: 'email', required: true })),
      el('label', {}, 'Phone', el('input', { name: 'phone', type: 'tel' })),
      el('button', { class: 'btn small', type: 'submit' }, 'Add')),
  );

  detail.replaceChildren(summary, bookings, waitlist, add ?? '');
}

function setCapacity(e) {
  e.preventDefault();
  act(() => api(`/api/admin/sessions/${selected}/capacity`, { body: { capacity: Number(e.target.capacity.value) } }), refresh);
}

function cancelClass() {
  const reason = prompt('Cancel this class?\n\nEveryone booked will be emailed. Clients who already paid get the class fee back as credit.\n\nOptional reason to include in the email:');
  if (reason === null) return;
  act(async () => {
    const r = await api(`/api/admin/sessions/${selected}/cancel`, { body: { reason } });
    alert(`${r.cancelledBookings} booking(s) cancelled. ${r.credited} returned as credit.`);
  }, refresh);
}

function cancelBooking(b) {
  if (!confirm(`Cancel ${b.name}'s booking? The next person on the waiting list will be offered the spot.`)) return;
  const credit = b.status === 'confirmed' && b.amount_minor > 0
    ? confirm(`Give ${b.name} ${b.amount} back as account credit?\n\nOK = give credit, Cancel = no credit`)
    : true;
  act(() => api(`/api/admin/bookings/${b.id}/cancel`, { body: { credit } }), refresh);
}

function removeWaitlist(w) {
  if (!confirm(`Remove ${w.name} from the waiting list?`)) return;
  act(() => api(`/api/admin/waitlist/${w.id}/remove`, { body: {} }), refresh);
}

function addBooking(e) {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(e.target));
  act(async () => {
    try {
      await api(`/api/admin/sessions/${selected}/bookings`, { body: data });
    } catch (err) {
      if (err.full && confirm('The class is full. Add her anyway (over capacity)?')) {
        await api(`/api/admin/sessions/${selected}/bookings`, { body: { ...data, overbook: true } });
      } else throw err;
    }
  }, refresh);
}

// ------------------------------------------------------------- receipts

const receiptFilter = document.getElementById('receipt-filter');
receiptFilter.addEventListener('change', loadReceipts);

async function updateReceiptCount() {
  try {
    const pending = await api('/api/admin/payments?status=pending_review');
    document.getElementById('receipt-count').textContent = pending.length ? `(${pending.length})` : '';
  } catch { /* ignore */ }
}

async function loadReceipts() {
  const box = document.getElementById('receipts');
  const status = receiptFilter.value;
  let list;
  try {
    list = await api(`/api/admin/payments?status=${status}`);
  } catch (err) {
    return box.replaceChildren(el('div', { class: 'empty' }, err.message));
  }
  updateReceiptCount();
  if (!list.length) {
    return box.replaceChildren(el('div', { class: 'empty' }, status === 'pending_review' ? 'No receipts waiting to be checked. 🎉' : 'Nothing here.'));
  }
  box.replaceChildren(...list.map((p) => {
    const url = `/api/admin/payments/${p.id}/receipt`;
    const preview = p.receiptType.startsWith('image/') && !/hei[cf]/.test(p.receiptType)
      ? el('a', { href: url, target: '_blank', rel: 'noopener' }, el('img', { src: url, alt: `Receipt from ${p.name}` }))
      : el('a', { class: 'btn secondary block', href: url, target: '_blank', rel: 'noopener' }, `Open ${p.receiptName}`);
    return el('div', { class: 'card receipt' },
      el('div', {}, preview),
      el('div', {},
        el('h3', {}, `${p.name} — ${p.amount}`),
        el('p', { class: 'fine' }, `${p.email} · ${p.phone} · uploaded ${when(p.createdAt)}`),
        el('table', {}, el('tbody', {}, p.bookings.map((b) => el('tr', {},
          el('td', {}, `${b.title}, ${classWhen(b)}`), el('td', {}, b.amount), el('td', {}, statusBadge(b.status)))))),
        p.rejectReason ? el('p', { class: 'fine' }, `Rejected: ${p.rejectReason}`) : null,
        p.status === 'pending_review' ? el('div', { class: 'inline-form', style: 'margin-top:14px' },
          el('button', { class: 'btn small', onclick: () => approve(p) }, 'Approve payment'),
          el('button', { class: 'btn danger small', onclick: () => reject(p) }, 'Reject receipt')) : null,
      ),
    );
  }));
}

function approve(p) {
  if (!confirm(`Confirm you received ${p.amount} from ${p.name}? Her booking(s) will be confirmed.`)) return;
  act(() => api(`/api/admin/payments/${p.id}/approve`, { body: {} }), loadReceipts);
}

function reject(p) {
  const reason = prompt(`Why is this receipt not valid? ${p.name} will see this and can upload a new one before the payment deadline.`, 'the amount does not match');
  if (reason === null) return;
  act(() => api(`/api/admin/payments/${p.id}/reject`, { body: { reason } }), loadReceipts);
}

// -------------------------------------------------------------- clients

let clientSearchTimer;
document.getElementById('client-search').addEventListener('input', () => {
  clearTimeout(clientSearchTimer);
  clientSearchTimer = setTimeout(loadClients, 250);
});

const joined = (ms) => new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const whatsapp = (phone) => `https://wa.me/${phone.replace(/[^\d]/g, '').replace(/^0/, '966')}`;
const stop = (e) => e.stopPropagation();

async function loadClients() {
  const box = document.getElementById('clients');
  const q = document.getElementById('client-search').value;
  let list;
  try {
    list = await api(`/api/admin/clients?q=${encodeURIComponent(q)}`);
  } catch (err) {
    return box.replaceChildren(el('p', { class: 'fine' }, err.message));
  }
  if (!q) document.getElementById('client-count').textContent = list.length ? `(${list.length})` : '';
  if (!list.length) return box.replaceChildren(el('p', { class: 'fine' }, q ? 'No clients match your search.' : 'No one has signed up yet.'));
  const rows = list.flatMap((c) => {
    const detail = el('tr', { class: 'client-detail', hidden: true }, el('td', { colspan: 6 }));
    const row = el('tr', { class: 'client-row', title: 'Show bookings and credit history', onclick: () => toggleClient(c, detail) },
      el('td', {}, el('strong', {}, c.name), el('div', { class: 'sub' }, `joined ${joined(c.created_at)}`)),
      el('td', {}, el('a', { href: `mailto:${c.email}`, onclick: stop }, c.email),
        el('div', { class: 'sub' }, el('a', { href: whatsapp(c.phone), target: '_blank', rel: 'noopener', onclick: stop }, c.phone))),
      el('td', {}, c.activity_level, c.injuries ? el('div', { class: 'sub' }, `🩹 ${c.injuries}`) : null),
      el('td', {}, `${c.upcoming} upcoming`, el('div', { class: 'sub' }, `${c.paid_classes} paid in total`),
        c.unpaid ? el('div', {}, el('span', { class: 'badge low' }, `${c.unpaid} unpaid`)) : null),
      el('td', {}, c.credit),
      el('td', { class: 'sub' }, '▾'),
    );
    return [row, detail];
  });
  box.replaceChildren(el('table', {},
    el('thead', {}, el('tr', {}, ['Client', 'Contact', 'Activity & injuries', 'Bookings', 'Credit', ''].map((t) => el('th', {}, t)))),
    el('tbody', {}, rows)));
}

async function toggleClient(c, detail) {
  detail.hidden = !detail.hidden;
  if (detail.hidden || detail.dataset.loaded) return;
  const cell = detail.firstChild;
  cell.textContent = 'Loading…';
  try {
    const d = await api(`/api/admin/clients/${c.id}`);
    detail.dataset.loaded = '1';
    cell.replaceChildren(
      el('strong', {}, 'Bookings'),
      d.bookings.length
        ? el('table', {}, el('tbody', {}, d.bookings.map((b) => el('tr', {},
          el('td', {}, `${b.title}, ${classWhen(b)}`),
          el('td', {}, b.amount, el('div', { class: 'sub' }, PAID_BY[b.paid_with] ?? '')),
          el('td', {}, statusBadge(b.status), b.cancel_reason ? el('div', { class: 'sub' }, b.cancel_reason) : null)))))
        : el('p', { class: 'fine' }, 'No bookings yet.'),
      el('strong', { style: 'display:block;margin-top:12px' }, 'Credit history'),
      d.ledger.length
        ? el('table', {}, el('tbody', {}, d.ledger.map((l) => el('tr', {},
          el('td', {}, new Date(l.at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })),
          el('td', {}, l.reason),
          el('td', {}, `${l.positive ? '+' : '−'}${l.amount.replace('-', '')}`)))))
        : el('p', { class: 'fine' }, 'No credit history.'),
    );
  } catch (err) {
    cell.textContent = err.message;
  }
}

// ------------------------------------------------------------- schedule

function classFields(form, { oneOff = false, values = {} } = {}) {
  const v = { durationMinutes: 60, capacity: 10, price: 30, ...values };
  form.replaceChildren(...[
    el('label', {}, 'Class name', el('input', { name: 'title', required: true, value: v.title ?? 'Pilates' })),
    oneOff
      ? el('label', {}, 'Date', el('input', { name: 'date', type: 'date', required: true }))
      : el('label', {}, 'Day', el('select', { name: 'weekday' }, DAYS.map((d, i) => el('option', { value: i, selected: v.weekday === i }, d)))),
    el('label', {}, 'Start time', el('input', { name: 'time', type: 'time', required: true, value: v.time ?? '19:00' })),
    el('label', {}, 'Minutes', el('input', { name: 'durationMinutes', type: 'number', min: 15, max: 240, value: v.durationMinutes })),
    el('label', {}, 'Spots', el('input', { name: 'capacity', type: 'number', min: 1, max: 500, value: v.capacity })),
    el('label', {}, 'Price (SAR)', el('input', { name: 'price', type: 'number', min: 0, step: '0.5', value: v.price })),
    el('label', { class: 'wide' }, 'Description', el('input', { name: 'description', value: v.description ?? '' })),
    oneOff || values.id === undefined ? null : el('label', { class: 'wide', style: 'display:flex;gap:8px;align-items:center;font-weight:500' },
      el('input', { name: 'active', type: 'checkbox', checked: values.active !== false, style: 'width:auto;margin:0' }), 'Active (shown on the timetable)'),
    el('div', { class: 'wide inline-form' },
      el('button', { class: 'btn small', type: 'submit' }, values.id ? 'Save changes' : 'Add class'),
      values.id ? el('button', { class: 'btn secondary small', type: 'button', onclick: resetTemplateForm }, 'Cancel editing') : null),
  ].filter(Boolean));
}

const formData = (form) => {
  const d = Object.fromEntries(new FormData(form));
  for (const k of ['weekday', 'durationMinutes', 'capacity', 'price']) if (k in d) d[k] = Number(d[k]);
  if (form.active) d.active = form.active.checked;
  return d;
};

let editing = null;
const templateForm = document.getElementById('template-form');
function resetTemplateForm() {
  editing = null;
  document.getElementById('template-form-title').textContent = 'Add a weekly class';
  classFields(templateForm);
}
templateForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const data = formData(templateForm);
  act(async () => {
    if (editing) {
      const r = await api(`/api/admin/templates/${editing}`, { body: data });
      if (r.keptWithBookings) alert(`Saved. ${r.keptWithBookings} upcoming date(s) already have bookings, so they keep their original time — cancel them separately if needed.`);
    } else {
      await api('/api/admin/templates', { body: data });
    }
    resetTemplateForm();
  }, loadTemplates);
});

const oneOffForm = document.getElementById('oneoff-form');
classFields(oneOffForm, { oneOff: true });
oneOffForm.addEventListener('submit', (e) => {
  e.preventDefault();
  act(async () => {
    await api('/api/admin/classes', { body: formData(oneOffForm) });
    alert('Class added to the timetable.');
    classFields(oneOffForm, { oneOff: true });
  }, () => {});
});

async function loadTemplates() {
  const box = document.getElementById('templates');
  const list = await api('/api/admin/templates').catch((err) => { box.textContent = err.message; return null; });
  if (!list) return;
  box.replaceChildren(list.length ? el('table', {},
    el('thead', {}, el('tr', {}, ['Class', 'When', 'Spots', 'Price', ''].map((t) => el('th', {}, t)))),
    el('tbody', {}, list.map((t) => el('tr', { style: t.active ? '' : 'opacity:.55' },
      el('td', {}, t.title, t.active ? null : el('div', { class: 'sub' }, 'inactive')),
      el('td', {}, `${DAYS[t.weekday]} ${fmtRange(`2000-01-01T${t.time}`, t.durationMinutes)}`),
      el('td', {}, t.capacity),
      el('td', {}, `SAR ${t.price}`),
      el('td', {}, el('button', { class: 'btn secondary small', onclick: () => editTemplate(t) }, 'Edit')),
    )))) : el('p', { class: 'fine' }, 'No weekly classes yet.'));
}

function editTemplate(t) {
  editing = t.id;
  document.getElementById('template-form-title').textContent = `Edit ${t.title} (${DAYS[t.weekday]})`;
  classFields(templateForm, { values: t });
  templateForm.scrollIntoView({ behavior: 'smooth' });
}

resetTemplateForm();
loadList();
updateReceiptCount();
api('/api/admin/clients').then((list) => { document.getElementById('client-count').textContent = list.length ? `(${list.length})` : ''; }).catch(() => {});

document.getElementById('admin-logout').addEventListener('click', async (e) => {
  e.preventDefault();
  await api('/api/admin/logout', { body: {} }).catch(() => {});
  location.href = '/admin/login';
});
