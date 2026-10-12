let account;
let studio;

const STATUS = {
  awaiting_payment: ['Payment due', 'low'],
  payment_review: ['Receipt being checked', 'low'],
  confirmed: ['Confirmed', ''],
  cancelled: ['Cancelled', 'danger'],
};
const badge = (status) => el('span', { class: `badge ${STATUS[status]?.[1] ?? ''}` }, STATUS[status]?.[0] ?? status);
const classLine = (b) => `${fmtDay(b.startsAt)} · ${fmtRange(b.startsAt, b.durationMinutes)}`;

function notice(target, message, kind = 'info') {
  document.getElementById(target).replaceChildren(message ? el('div', { class: `notice ${kind}` }, message) : '');
}

async function load() {
  try {
    [account, studio] = await Promise.all([api('/api/me'), loadStudio()]);
  } catch (err) {
    if (err.status === 401) return goToSignIn();
    return notice('result', err.message, 'error');
  }
  document.getElementById('hello').textContent = `Hi, ${account.user.name.split(' ')[0]}`;
  const due = account.upcoming.filter((b) => b.status === 'awaiting_payment').length;
  document.getElementById('count-payments').textContent = due || '';
  document.getElementById('count-bookings').textContent = account.upcoming.length || '';
  document.getElementById('count-waitlist').textContent = account.waitlist.filter((w) => w.status === 'offered').length || '';
  renderPayments();
  renderBookings();
  renderWaitlist();
  renderCredits();
  renderProfile();
  renderHistory();
}

// ------------------------------------------------------------ payments

function renderPayments() {
  const due = account.upcoming.filter((b) => b.status === 'awaiting_payment');
  const body = document.getElementById('pay-body');
  document.getElementById('pay-lead').textContent = due.length
    ? `Choose the classes you're paying for, transfer the total and upload the receipt. You can pay for several classes with one transfer. Unpaid spots are released ${studio.paymentDeadlineHours} hours before class.`
    : 'Nothing to pay right now.';
  if (!due.length) return body.replaceChildren();

  const form = el('form', { id: 'pay-form' });
  const checks = due.map((b) => el('div', { class: 'item' },
    el('label', { class: 'check' },
      el('input', { type: 'checkbox', name: 'bookingIds', value: b.id, checked: true, onchange: updateTotal }),
      el('span', { class: 'what' }, el('strong', {}, b.title), el('span', {}, `${classLine(b)} · pay by ${b.payBy}`))),
    el('span', {}, b.amount),
  ));
  const total = el('div', { class: 'pay-total' }, el('span', {}, 'Total'), el('span', { id: 'pay-total' }));
  const useCredit = account.creditMinor > 0
    ? el('label', { class: 'check', style: 'margin:8px 0 14px;display:flex;gap:10px;align-items:center;font-weight:500' },
      el('input', { type: 'checkbox', name: 'useCredits', checked: true, style: 'width:20px;height:20px;margin:0', onchange: updateTotal }),
      `Use my credit (${account.credit})`)
    : null;
  const instructions = el('div', { class: 'transfer-box', id: 'transfer-box' }, account.paymentInstructions);
  const file = el('label', { id: 'receipt-field' }, 'Transfer receipt ',
    el('span', { class: 'opt' }, `(photo or PDF, up to ${studio.maxUploadMb} MB)`),
    el('input', { type: 'file', name: 'receipt', accept: 'image/*,application/pdf' }));

  form.append(
    account.lastRejection ? el('div', { class: 'notice warn' }, `Your last receipt was not accepted: ${account.lastRejection}. Please upload a correct one.`) : '',
    ...checks, total, useCredit ?? '', instructions, file,
    el('div', { id: 'pay-notice' }),
    el('button', { class: 'btn block', type: 'submit', id: 'pay-submit' }, 'Upload receipt'),
  );
  form.addEventListener('submit', pay);
  body.replaceChildren(form);
  updateTotal();
}

// Mirrors the server: credit pays for whole classes (earliest first); the rest needs a receipt.
function paymentPlan() {
  const form = document.getElementById('pay-form');
  const ids = [...form.querySelectorAll('input[name=bookingIds]:checked')].map((i) => Number(i.value));
  const chosen = account.upcoming.filter((b) => ids.includes(b.id));
  let balance = form.useCredits?.checked ? account.creditMinor : 0;
  let byTransfer = 0;
  let byCredit = 0;
  for (const b of chosen) {
    if (balance >= b.amountMinor) { balance -= b.amountMinor; byCredit += b.amountMinor; } else byTransfer += b.amountMinor;
  }
  return { ids, byTransfer, byCredit };
}

function updateTotal() {
  const { ids, byTransfer, byCredit } = paymentPlan();
  document.getElementById('pay-total').textContent = byCredit
    ? `${money(byTransfer)} to transfer (+ ${money(byCredit)} from credit)`
    : money(byTransfer);
  const needsReceipt = byTransfer > 0;
  document.getElementById('receipt-field').hidden = !needsReceipt;
  document.getElementById('transfer-box').hidden = !needsReceipt;
  const btn = document.getElementById('pay-submit');
  btn.disabled = ids.length === 0;
  btn.textContent = needsReceipt ? 'Upload receipt' : 'Pay with credit';
}

async function pay(e) {
  e.preventDefault();
  const form = e.target;
  const { ids, byTransfer } = paymentPlan();
  const file = form.receipt.files[0];
  if (byTransfer > 0 && !file) return notice('pay-notice', 'Please attach your transfer receipt.', 'error');
  if (file && file.size > studio.maxUploadMb * 1024 * 1024) return notice('pay-notice', `The receipt must be smaller than ${studio.maxUploadMb} MB.`, 'error');

  const data = new FormData();
  data.append('bookingIds', ids.join(','));
  data.append('useCredits', String(Boolean(form.useCredits?.checked)));
  if (byTransfer > 0) data.append('receipt', file);
  const btn = document.getElementById('pay-submit');
  btn.disabled = true;
  btn.textContent = 'Uploading…';
  try {
    const r = await api('/api/payments', { body: data });
    const parts = [];
    if (r.byCredit.length) parts.push(`${r.byCredit.length} class${r.byCredit.length > 1 ? 'es' : ''} paid with credit and confirmed.`);
    if (r.byTransfer.length) parts.push(`Receipt uploaded — ${studio.instructor || 'the studio'} will check it and you'll get a confirmation email.`);
    notice('result', parts.join(' '));
    await load();
    showSection(account.upcoming.some((b) => b.status === 'awaiting_payment') ? 'payments' : 'bookings');
  } catch (err) {
    notice('pay-notice', err.message, 'error');
    btn.disabled = false;
    updateTotal();
  }
}

// ------------------------------------------------------------ bookings

function renderBookings() {
  const list = account.upcoming;
  document.getElementById('bookings-lead').textContent =
    `You can cancel online up to ${studio.cancellationHours} hours before class. Paid classes are returned to you as credit.`;
  document.getElementById('bookings-body').replaceChildren(...(list.length ? list.map((b) => el('div', { class: 'item' },
    el('span', { class: 'what' }, el('strong', {}, b.title), el('span', {}, `${classLine(b)} · ${b.amount}`)),
    el('span', { class: 'acts' },
      badge(b.status),
      b.status === 'confirmed' ? el('a', { class: 'btn secondary small', href: `/api/bookings/${b.id}/calendar.ics` }, 'Add to calendar') : null,
      b.canCancel ? el('button', { class: 'btn danger small', onclick: () => cancel(b) }, 'Cancel') : null),
  )) : [el('p', { class: 'fine' }, 'No upcoming classes. ', el('a', { href: '/#schedule' }, 'Book a class'))]));
}

async function cancel(b) {
  const paid = b.status === 'confirmed' && b.paidWith !== 'free';
  const msg = `Cancel ${b.title} on ${classLine(b)}?` + (paid ? `\n\n${b.amount} will be added to your account credit.` : '');
  if (!confirm(msg)) return;
  try {
    await api(`/api/bookings/${b.id}/cancel`, { body: {} });
    notice('result', 'Your booking has been cancelled.');
    load();
  } catch (err) {
    alert(err.message);
  }
}

// ------------------------------------------------------------ waitlist

function renderWaitlist() {
  const list = account.waitlist;
  document.getElementById('waitlist-body').replaceChildren(...(list.length ? list.map((w) => el('div', { class: 'item' },
    el('span', { class: 'what' }, el('strong', {}, w.title),
      el('span', {}, w.status === 'offered' ? `${classLine(w)} · a spot is held for you until ${w.offerExpires}` : `${classLine(w)} · number ${w.position} in line`)),
    el('span', { class: 'acts' },
      w.status === 'offered' ? el('button', { class: 'btn small', onclick: () => claim(w) }, 'Claim spot') : el('span', { class: 'badge full' }, 'Waiting'),
      el('button', { class: 'btn secondary small', onclick: () => leave(w) }, 'Leave')),
  )) : [el('p', { class: 'fine' }, "You're not on any waiting lists.")]));
}

async function claim(w) {
  try {
    await api(`/api/waitlist/${w.id}/claim`, { body: {} });
    notice('result', `The spot is yours! Please pay for it below to confirm.`);
    await load();
    showSection('payments');
  } catch (err) {
    alert(err.message);
    load();
  }
}

async function leave(w) {
  if (!confirm(`Leave the waiting list for ${w.title}?`)) return;
  try {
    await api(`/api/waitlist/${w.id}/leave`, { body: {} });
    load();
  } catch (err) {
    alert(err.message);
  }
}

// ------------------------------------------------------------- credits

function renderCredits() {
  document.getElementById('credits-body').replaceChildren(
    el('div', { class: 'credit-big' }, account.credit),
    account.ledger.length
      ? el('div', { class: 'ledger' }, account.ledger.map((l) => el('div', {},
        el('span', {}, `${new Date(l.at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} · ${l.reason}`),
        el('span', { class: l.positive ? 'plus' : 'minus' }, `${l.positive ? '+' : '−'}${l.amount.replace('-', '')}`))))
      : el('p', { class: 'fine' }, 'No credit history yet.'),
  );
}

// ------------------------------------------------------------- profile

function renderProfile() {
  const form = document.getElementById('profile-form');
  form.activityLevel.replaceChildren(...studio.activityLevels.map((l) => el('option', { value: l }, l)));
  for (const [k, v] of Object.entries({ ...account.user })) if (form[k]) form[k].value = v;
}

document.getElementById('profile-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/me/profile', { body: Object.fromEntries(new FormData(e.target)) });
    notice('profile-notice', 'Saved.');
  } catch (err) {
    notice('profile-notice', err.message, 'error');
  }
});

function renderHistory() {
  const list = account.history;
  document.getElementById('history-body').replaceChildren(...(list.length ? list.map((b) => el('div', { class: 'item' },
    el('span', { class: 'what' }, el('strong', {}, b.title),
      el('span', {}, `${classLine(b)}${b.cancelReason ? ` · ${b.cancelReason}` : ''}`)),
    badge(b.past && b.status === 'confirmed' ? 'confirmed' : b.status),
  )) : [el('p', { class: 'fine' }, 'Nothing here yet.')]));
}

document.getElementById('signout').addEventListener('click', async () => {
  await api('/api/auth/signout', { body: {} });
  location.href = '/';
});

// Message carried over from booking on the timetable.
const booked = JSON.parse(sessionStorage.getItem('bookingResult') || 'null');
sessionStorage.removeItem('bookingResult');
if (booked) {
  const lines = [];
  if (booked.booked.length) lines.push(`${booked.booked.length} class${booked.booked.length > 1 ? 'es' : ''} reserved. Pay below now, or come back later before the deadline.`);
  for (const f of booked.failed) lines.push(`One class could not be booked: ${f.error}`);
  notice('result', lines.join(' '), booked.booked.length ? 'info' : 'error');
}

// ---------------------------------------------------- one page per menu item

const SECTIONS = ['payments', 'bookings', 'waitlist', 'credits', 'history', 'profile'];

function showSection(name, { push = true } = {}) {
  if (!SECTIONS.includes(name)) name = 'payments';
  for (const sec of document.querySelectorAll('[data-section]')) sec.hidden = sec.id !== name;
  for (const a of document.querySelectorAll('.account-nav a')) a.setAttribute('aria-selected', String(a.dataset.tab === name));
  if (push && location.hash !== `#${name}`) history.replaceState(null, '', `#${name}`);
  window.scrollTo({ top: 0 });
}

document.querySelectorAll('.account-nav a').forEach((a) => a.addEventListener('click', (e) => {
  e.preventDefault();
  showSection(a.dataset.tab);
}));
// Links inside the page (e.g. "Book a class") and from emails use #section.
window.addEventListener('hashchange', () => showSection(location.hash.slice(1), { push: false }));

load().then(() => {
  const wanted = location.hash.slice(1);
  if (SECTIONS.includes(wanted)) return showSection(wanted, { push: false });
  // No section asked for: open whatever needs attention first.
  const due = account?.upcoming.some((b) => b.status === 'awaiting_payment');
  const offered = account?.waitlist.some((w) => w.status === 'offered');
  showSection(due ? 'payments' : offered ? 'waitlist' : 'bookings');
});
