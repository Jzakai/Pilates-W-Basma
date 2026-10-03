// Small helpers shared by every page.

async function api(path, options = {}) {
  const res = await fetch(path, {
    method: options.body ? 'POST' : options.method || 'GET',
    headers: options.body ? { 'Content-Type': 'application/json' } : {},
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || 'Something went wrong. Please try again.');
    Object.assign(err, data, { status: res.status });
    throw err;
  }
  return data;
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
function loadStudio() {
  studioPromise ||= api('/api/studio').then((studio) => {
    document.querySelectorAll('[data-studio-name]').forEach((n) => (n.textContent = studio.name));
    if (studio.demoPayments && !document.querySelector('.demo-banner')) {
      document.body.prepend(el('div', { class: 'demo-banner' },
        'Demo mode — online payments are simulated until the payment gateway is connected.'));
    }
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
