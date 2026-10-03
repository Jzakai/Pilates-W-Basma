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

function fmtTime(local) {
  return parseLocal(local).time;
}

function fmtClass(session) {
  return `${fmtDay(session.startsAt)} · ${fmtTime(session.startsAt)} · ${session.durationMinutes} min`;
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
        'Demo mode — payments are simulated. Connect Stripe to take real payments.'));
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
