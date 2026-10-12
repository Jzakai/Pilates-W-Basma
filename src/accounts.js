const crypto = require('node:crypto');
const { BookingError } = require('./errors');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ACTIVITY_LEVELS = ['Not very active', 'Somewhat active', 'Very active'];
const SESSION_DAYS = 60;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const newToken = () => crypto.randomBytes(32).toString('base64url');

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
  const [scheme, salt, hash] = String(stored).split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(salt, 'base64'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

function cleanProfile(input = {}) {
  const name = String(input.name || '').trim().slice(0, 100);
  const phone = String(input.phone || '').trim().slice(0, 40);
  const injuries = String(input.injuries || '').trim().slice(0, 1000);
  const activityLevel = String(input.activityLevel || '').trim();
  if (!name) throw new BookingError('Please enter your name.');
  if (!/^\+?[\d\s()-]{7,}$/.test(phone)) throw new BookingError('Please enter your phone / WhatsApp number.');
  if (!ACTIVITY_LEVELS.includes(activityLevel)) throw new BookingError('Please choose your activity level.');
  return { name, phone, injuries, activityLevel };
}

function checkPassword(password) {
  if (typeof password !== 'string' || password.length < 8) {
    throw new BookingError('Password must be at least 8 characters.');
  }
  if (password.length > 200) throw new BookingError('Password is too long.');
}

function createAccountService({ db, config, mailer, now = () => Date.now() }) {
  const byEmail = db.prepare('SELECT * FROM users WHERE email = ?');
  const byId = db.prepare('SELECT * FROM users WHERE id = ?');

  function startSession(userId) {
    const token = newToken();
    db.prepare('INSERT INTO user_sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
      .run(sha256(token), userId, now() + SESSION_DAYS * 86400_000);
    return token;
  }

  function publicUser(u) {
    return {
      id: u.id,
      email: u.email,
      name: u.name,
      phone: u.phone,
      injuries: u.injuries,
      activityLevel: u.activity_level,
      creditMinor: u.credit_minor,
    };
  }

  function signUp(input = {}) {
    const email = String(input.email || '').trim().toLowerCase().slice(0, 200);
    if (!EMAIL_RE.test(email)) throw new BookingError('Please enter a valid email address.');
    const profile = cleanProfile(input);
    checkPassword(input.password);
    if (byEmail.get(email)) throw new BookingError('An account with this email already exists. Please sign in.', 409);
    const r = db.prepare(`INSERT INTO users (email, name, phone, injuries, activity_level, password_hash, created_at)
                          VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(email, profile.name, profile.phone, profile.injuries, profile.activityLevel, hashPassword(input.password), now());
    const user = byId.get(r.lastInsertRowid);
    console.log(`New account: ${user.name} <${user.email}> (#${user.id})`);
    return { user: publicUser(user), token: startSession(user.id) };
  }

  function signIn({ email, password } = {}) {
    const user = byEmail.get(String(email || '').trim().toLowerCase());
    // Hash anyway so response time does not reveal whether the email exists.
    const ok = user ? verifyPassword(String(password || ''), user.password_hash) : (hashPassword('x'), false);
    if (!ok) throw new BookingError('Email or password is incorrect.', 401);
    return { user: publicUser(user), token: startSession(user.id) };
  }

  function userFromToken(token) {
    if (!token) return null;
    const row = db.prepare(`SELECT u.* FROM user_sessions s JOIN users u ON u.id = s.user_id
                            WHERE s.token_hash = ? AND s.expires_at > ?`).get(sha256(token), now());
    return row || null;
  }

  function signOut(token) {
    if (token) db.prepare('DELETE FROM user_sessions WHERE token_hash = ?').run(sha256(token));
  }

  function updateProfile(userId, input) {
    const profile = cleanProfile(input);
    db.prepare('UPDATE users SET name = ?, phone = ?, injuries = ?, activity_level = ? WHERE id = ?')
      .run(profile.name, profile.phone, profile.injuries, profile.activityLevel, userId);
    return publicUser(byId.get(userId));
  }

  async function requestPasswordReset(email) {
    const user = byEmail.get(String(email || '').trim().toLowerCase());
    if (!user) return; // Same response either way, so emails cannot be probed.
    const token = newToken();
    db.prepare('INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
      .run(sha256(token), user.id, now() + 3600_000);
    await mailer.send({
      to: user.email,
      subject: `Reset your ${config.studio.name} password`,
      text: `Hi ${user.name},\n\nUse this link within 1 hour to choose a new password:\n${config.baseUrl}/reset.html?token=${token}\n\nIf you did not ask for this, you can ignore this email.`,
    });
  }

  function resetPassword(token, password) {
    checkPassword(password);
    const row = db.prepare('SELECT * FROM password_resets WHERE token_hash = ? AND used = 0 AND expires_at > ?')
      .get(sha256(String(token || '')), now());
    if (!row) throw new BookingError('This reset link has expired. Please request a new one.', 410);
    db.prepare('UPDATE password_resets SET used = 1 WHERE token_hash = ?').run(row.token_hash);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), row.user_id);
    db.prepare('DELETE FROM user_sessions WHERE user_id = ?').run(row.user_id);
    return { user: publicUser(byId.get(row.user_id)), token: startSession(row.user_id) };
  }

  return { signUp, signIn, signOut, userFromToken, updateProfile, requestPasswordReset, resetPassword, publicUser };
}

module.exports = { createAccountService, ACTIVITY_LEVELS, hashPassword };
