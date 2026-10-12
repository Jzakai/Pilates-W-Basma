const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

// Bump when the schema changes in a way that cannot be migrated in place.
const SCHEMA_VERSION = 2;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  email           TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  phone           TEXT NOT NULL,
  injuries        TEXT NOT NULL DEFAULT '',
  activity_level  TEXT NOT NULL DEFAULT '',
  password_hash   TEXT NOT NULL,
  credit_minor    INTEGER NOT NULL DEFAULT 0,   -- credit balance in the currency's smallest unit
  created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS user_sessions (
  token_hash      TEXT PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id),
  expires_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS password_resets (
  token_hash      TEXT PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id),
  expires_at      INTEGER NOT NULL,
  used            INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS credit_ledger (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL REFERENCES users(id),
  amount_minor    INTEGER NOT NULL,             -- + credit added, - credit spent
  reason          TEXT NOT NULL,
  booking_id      INTEGER,
  created_at      INTEGER NOT NULL
);

-- Weekly recurring classes the instructor manages from the dashboard.
CREATE TABLE IF NOT EXISTS class_templates (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  title           TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  weekday         INTEGER NOT NULL,             -- 0 = Sunday
  time            TEXT NOT NULL,                -- HH:MM, studio timezone
  duration_min    INTEGER NOT NULL,
  capacity        INTEGER NOT NULL,
  price_minor     INTEGER NOT NULL,
  active          INTEGER NOT NULL DEFAULT 1,
  created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS class_sessions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  template_id     INTEGER REFERENCES class_templates(id),   -- NULL for one-off classes
  title           TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  location        TEXT NOT NULL DEFAULT '',
  starts_at       TEXT NOT NULL,                -- local time in studio timezone, YYYY-MM-DDTHH:MM
  duration_min    INTEGER NOT NULL,
  capacity        INTEGER NOT NULL,
  price_minor     INTEGER NOT NULL,
  currency        TEXT NOT NULL,
  cancelled       INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  UNIQUE (template_id, starts_at)
);

-- One uploaded bank-transfer receipt, covering one or more bookings.
CREATE TABLE IF NOT EXISTS payments (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL REFERENCES users(id),
  amount_minor    INTEGER NOT NULL,             -- amount the receipt should show
  currency        TEXT NOT NULL,
  receipt_file    TEXT NOT NULL,                -- file name inside the uploads directory
  receipt_name    TEXT NOT NULL,                -- original file name
  receipt_type    TEXT NOT NULL,
  status          TEXT NOT NULL,                -- pending_review | approved | rejected
  reject_reason   TEXT NOT NULL DEFAULT '',
  created_at      INTEGER NOT NULL,
  reviewed_at     INTEGER
);

CREATE TABLE IF NOT EXISTS bookings (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id      INTEGER NOT NULL REFERENCES class_sessions(id),
  user_id         INTEGER REFERENCES users(id), -- NULL for bookings the instructor added for a guest
  name            TEXT NOT NULL,
  email           TEXT NOT NULL,
  phone           TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL,                -- awaiting_payment | payment_review | confirmed | cancelled
  amount_minor    INTEGER NOT NULL,
  currency        TEXT NOT NULL,
  paid_with       TEXT,                         -- transfer | credit | manual | free
  payment_id      INTEGER REFERENCES payments(id),
  waitlist_id     INTEGER REFERENCES waitlist(id),
  reminder_sent   INTEGER NOT NULL DEFAULT 0,
  cancel_reason   TEXT NOT NULL DEFAULT '',
  created_at      INTEGER NOT NULL,
  confirmed_at    INTEGER,
  cancelled_at    INTEGER
);
CREATE INDEX IF NOT EXISTS bookings_session ON bookings(session_id, status);
CREATE INDEX IF NOT EXISTS bookings_user ON bookings(user_id, status);

CREATE TABLE IF NOT EXISTS waitlist (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id      INTEGER NOT NULL REFERENCES class_sessions(id),
  user_id         INTEGER NOT NULL REFERENCES users(id),
  status          TEXT NOT NULL,                -- waiting | offered | booked | expired | removed
  offer_expires_at INTEGER,                     -- epoch ms
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS waitlist_session ON waitlist(session_id, status);
`;

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  const { user_version: version } = db.prepare('PRAGMA user_version').get();
  if (version !== SCHEMA_VERSION) {
    // Earlier versions only ever held demo data, so they are rebuilt rather than migrated.
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all();
    db.exec('PRAGMA foreign_keys = OFF;');
    for (const { name } of tables) db.exec(`DROP TABLE IF EXISTS "${name}"`);
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec(SCHEMA);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  } else {
    db.exec(SCHEMA);
  }
  return db;
}

// Runs fn inside a transaction. Nested calls join the outer transaction.
function transaction(db, fn) {
  if (db.isTransaction) return fn();
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { openDb, transaction };
