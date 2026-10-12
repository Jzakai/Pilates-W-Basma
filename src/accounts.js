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
  const byEmail = (email) => db.get('SELECT * FROM users WHERE email = $1', [email]);
  const byId = (id) => db.get('SELECT * FROM users WHERE id = $1', [id]);

  async function startSession(userId) {
    const token = newToken();
    await db.run('INSERT INTO user_sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)',
      [sha256(token), userId, now() + SESSION_DAYS * 86400_000]);
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

  async function signUp(input = {}) {
    const email = String(input.email || '').trim().toLowerCase().slice(0, 200);
    if (!EMAIL_RE.test(email)) throw new BookingError('Please enter a valid email address.');
    const profile = cleanProfile(input);
    checkPassword(input.password);
    const taken = () => new BookingError('An account with this email already exists. Please sign in.', 409);
    if (await byEmail(email)) throw taken();
    const r = await db.run(`INSERT INTO users (email, name, phone, injuries, activity_level, password_hash, created_at)
                            VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (email) DO NOTHING RETURNING id`,
    [email, profile.name, profile.phone, profile.injuries, profile.activityLevel, hashPassword(input.password), now()]);
    if (!r.id) throw taken(); // signed up twice at the same moment
    const user = await byId(r.id);
    console.log(`New account: ${user.name} <${user.email}> (#${user.id})`);
    return { user: publicUser(user), token: await startSession(user.id) };
  }

  async function signIn({ email, password } = {}) {
    const user = await byEmail(String(email || '').trim().toLowerCase());
    // Hash anyway so response time does not reveal whether the email exists.
    const ok = user ? verifyPassword(String(password || ''), user.password_hash) : (hashPassword('x'), false);
    if (!ok) throw new BookingError('Email or password is incorrect.', 401);
    return { user: publicUser(user), token: await startSession(user.id) };
  }

  async function userFromToken(token) {
    if (!token) return null;
    const row = await db.get(`SELECT u.* FROM user_sessions s JOIN users u ON u.id = s.user_id
                              WHERE s.token_hash = $1 AND s.expires_at > $2`, [sha256(token), now()]);
    return row || null;
  }

  async function signOut(token) {
    if (token) await db.run('DELETE FROM user_sessions WHERE token_hash = $1', [sha256(token)]);
  }

  async function updateProfile(userId, input) {
    const profile = cleanProfile(input);
    await db.run('UPDATE users SET name = $1, phone = $2, injuries = $3, activity_level = $4 WHERE id = $5',
      [profile.name, profile.phone, profile.injuries, profile.activityLevel, userId]);
    return publicUser(await byId(userId));
  }

  async function requestPasswordReset(email) {
    const user = await byEmail(String(email || '').trim().toLowerCase());
    if (!user) return; // Same response either way, so emails cannot be probed.
    const token = newToken();
    await db.run('INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES ($1, $2, $3)',
      [sha256(token), user.id, now() + 3600_000]);
    await mailer.send({
      to: user.email,
      subject: `Reset your ${config.studio.name} password`,
      text: `Hi ${user.name},\n\nUse this link within 1 hour to choose a new password:\n${config.baseUrl}/reset.html?token=${token}\n\nIf you did not ask for this, you can ignore this email.`,
    });
  }

  async function resetPassword(token, password) {
    checkPassword(password);
    const userId = await db.tx(async (t) => {
      // Marking the link used in the same statement that checks it means it works only once.
      const row = await t.get(`UPDATE password_resets SET used = 1
                               WHERE token_hash = $1 AND used = 0 AND expires_at > $2 RETURNING user_id`,
      [sha256(String(token || '')), now()]);
      if (!row) throw new BookingError('This reset link has expired. Please request a new one.', 410);
      await t.run('UPDATE users SET password_hash = $1 WHERE id = $2', [hashPassword(password), row.user_id]);
      await t.run('DELETE FROM user_sessions WHERE user_id = $1', [row.user_id]);
      return row.user_id;
    });
    return { user: publicUser(await byId(userId)), token: await startSession(userId) };
  }

  return { signUp, signIn, signOut, userFromToken, updateProfile, requestPasswordReset, resetPassword, publicUser };
}

module.exports = { createAccountService, ACTIVITY_LEVELS, hashPassword };
