// Stand-in for the payment gateway while the site runs without Stripe keys.
const token = param('token');
const panel = document.getElementById('panel');
loadStudio();

panel.replaceChildren(
  el('div', { class: 'icon warn' }, '$'),
  el('h2', {}, 'Demo payment'),
  el('p', {}, 'The site is running in demo mode, so no real payment is taken. In production this page is replaced by the secure Stripe checkout.'),
  el('div', { class: 'stack' },
    el('button', { class: 'btn block', id: 'pay', onclick: pay }, 'Simulate successful payment'),
    el('a', { class: 'btn secondary block', href: `/booking.html?token=${encodeURIComponent(token)}&cancelled_checkout=1` }, 'Cancel')),
);

async function pay() {
  document.getElementById('pay').disabled = true;
  try {
    await api(`/api/demo-pay/${encodeURIComponent(token)}`, { body: {} });
    location.href = `/booking.html?token=${encodeURIComponent(token)}&new=1`;
  } catch (err) {
    alert(err.message);
    document.getElementById('pay').disabled = false;
  }
}
