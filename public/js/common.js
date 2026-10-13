// Small helpers shared by every page.

// JSON by default; pass a FormData as body for file uploads.
async function api(path, options = {}) {
  const isForm = typeof FormData !== 'undefined' && options.body instanceof FormData;
  const res = await fetch(path, {
    method: options.body ? 'POST' : options.method || 'GET',
    headers: options.body && !isForm ? { 'Content-Type': 'application/json' } : {},
    body: options.body ? (isForm ? options.body : JSON.stringify(options.body)) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (data.adminSignIn) location.href = '/admin/login';
    const err = new Error(data.error || 'Something went wrong. Please try again.');
    Object.assign(err, data, { status: res.status });
    throw err;
  }
  return data;
}

// The signed-in client (or null), fetched once per page.
let mePromise;
function loadMe() {
  mePromise ||= api('/api/auth/me').then((r) => r.user).catch(() => null);
  return mePromise;
}

// Adds "Sign in" or "My account" to the header.
async function renderAccountNav() {
  const nav = document.querySelector('.site-header .nav');
  if (!nav || nav.querySelector('[data-account]') || document.body.hasAttribute('data-no-account')) return;
  const user = await loadMe();
  nav.append(user
    ? el('a', { href: '/account.html', 'data-account': true, class: 'nav-strong' }, 'My account')
    : el('a', { href: `/login.html?next=${encodeURIComponent(location.pathname + location.hash)}`, 'data-account': true, class: 'nav-strong' }, 'Sign in'));
}

function goToSignIn() {
  location.href = `/login.html?next=${encodeURIComponent(location.pathname + location.search + location.hash)}`;
}

function money(minor) {
  return `SAR ${(minor / 100).toFixed(minor % 100 ? 2 : 0)}`;
}

// el('div', { class: 'x', onclick: fn }, 'text', childNode) — text is always escaped.
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === false || value == null) continue;
    if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key === 'class') node.className = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

// Class times arrive as "YYYY-MM-DDTHH:MM" in the studio's local time.
function parseLocal(local) {
  const [date, time] = local.split('T');
  const [y, m, d] = date.split('-').map(Number);
  return { date: new Date(Date.UTC(y, m - 1, d)), time };
}

function fmtDay(local, opts = { weekday: 'long', day: 'numeric', month: 'long' }) {
  return new Intl.DateTimeFormat('en-GB', { ...opts, timeZone: 'UTC' }).format(parseLocal(local).date);
}

function clock12(minutes) {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return { text: `${h % 12 || 12}${m ? ':' + String(m).padStart(2, '0') : ''}`, ampm: h >= 12 ? 'pm' : 'am' };
}

// "2026-10-04T19:15" -> "7:15 pm"
function fmtTime(local) {
  const [h, m] = parseLocal(local).time.split(':').map(Number);
  const t = clock12(h * 60 + m);
  return `${t.text} ${t.ampm}`;
}

// "2026-10-04T19:15", 60 -> "7:15–8:15 pm"
function fmtRange(local, durationMinutes) {
  const [h, m] = parseLocal(local).time.split(':').map(Number);
  const a = clock12(h * 60 + m);
  const b = clock12(h * 60 + m + durationMinutes);
  return a.ampm === b.ampm ? `${a.text}–${b.text} ${b.ampm}` : `${a.text} ${a.ampm}–${b.text} ${b.ampm}`;
}

function fmtClass(session) {
  return `${fmtDay(session.startsAt)} · ${fmtRange(session.startsAt, session.durationMinutes)}`;
}

function param(name) {
  return new URLSearchParams(location.search).get(name);
}

let studioPromise;
renderAccountNav();
function loadStudio() {
  studioPromise ||= api('/api/studio').then((studio) => {
    document.querySelectorAll('[data-studio-name]').forEach((n) => (n.textContent = studio.name));
    const footer = document.querySelector('footer .contact');
    if (footer) {
      const bits = [];
      if (studio.contactEmail) bits.push(el('a', { href: `mailto:${studio.contactEmail}` }, studio.contactEmail));
      if (studio.contactPhone) bits.push(el('a', { href: `tel:${studio.contactPhone.replace(/\s/g, '')}` }, studio.contactPhone));
      if (studio.instagram) {
        const handle = studio.instagram.replace(/^@/, '').replace(/^https?:\/\/(www\.)?instagram\.com\//, '').replace(/\/$/, '');
        bits.push(el('a', { href: `https://instagram.com/${handle}`, target: '_blank', rel: 'noopener' }, `@${handle}`));
      }
      bits.forEach((b, i) => footer.append(i ? ' · ' : '', b));
    }
    return studio;
  });
  return studioPromise;
}
