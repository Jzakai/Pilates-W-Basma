// Sign in, sign up and password reset pages.
loadStudio();

// Only allow same-site paths as the place to return to after signing in.
const next = (() => {
  const n = param('next');
  return n && n.startsWith('/') && !n.startsWith('//') ? n : '/account.html';
})();

function show(id, message, kind = 'error') {
  document.getElementById(id).replaceChildren(message ? el('div', { class: `notice ${kind}` }, message) : '');
}

function bind(formId, noticeId, submit) {
  const form = document.getElementById(formId);
  if (!form) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!form.reportValidity()) return;
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      await submit(Object.fromEntries(new FormData(form)), form);
    } catch (err) {
      show(noticeId, err.message);
    }
    btn.disabled = false;
  });
}

bind('signin-form', 'notice', async (data) => {
  await api('/api/auth/signin', { body: data });
  location.href = next;
});

bind('forgot-form', 'forgot-notice', async (data) => {
  await api('/api/auth/forgot', { body: data });
  show('forgot-notice', t('If an account exists for {email}, we\'ve emailed a reset link. It works for 1 hour.', { email: data.email }), 'info');
});

bind('signup-form', 'notice', async (data) => {
  await api('/api/auth/signup', { body: data });
  location.href = next;
});

bind('reset-form', 'notice', async (data) => {
  await api('/api/auth/reset', { body: { ...data, token: param('token') } });
  location.href = '/account.html';
});

// Keep the "come back to" page when switching between sign in and sign up.
for (const id of ['signup-link', 'signin-link']) {
  const a = document.getElementById(id);
  if (a && param('next')) a.href += `?next=${encodeURIComponent(next)}`;
}

const toggleForgot = (showForgot) => (e) => {
  e.preventDefault();
  document.getElementById('signin-form').hidden = showForgot;
  document.getElementById('forgot-form').hidden = !showForgot;
};
document.getElementById('show-forgot')?.addEventListener('click', toggleForgot(true));
document.getElementById('show-signin')?.addEventListener('click', toggleForgot(false));

const activity = document.getElementById('activity');
if (activity) {
  loadStudio().then((studio) => {
    activity.replaceChildren(el('option', { value: '' }, 'Choose…'), ...studio.activityLevels.map((l) => el('option', { value: l }, l)));
  });
}
if (param('next') && document.getElementById('signup-form')) {
  document.getElementById('signup-notice-text').textContent = t('Create an account to finish booking. Your details are saved for next time.');
}
