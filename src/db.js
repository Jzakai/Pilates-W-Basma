const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS class_sessions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  class_key       TEXT NOT NULL,
  title           TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  location        TEXT NOT NULL DEFAULT '',
  starts_at       TEXT NOT NULL,              -- local time in studio timezone, YYYY-MM-DDTHH:MM
  duration_min    INTEGER NOT NULL,
  capacity        INTEGER NOT NULL,
  price_minor     INTEGER NOT NULL,           -- price in the currency's smallest unit
  currency        TEXT NOT NULL,
  cancelled       INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  UNIQUE (class_key, starts_at)
);

CREATE TABLE IF NOT EXISTS bookings (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id          INTEGER NOT NULL REFERENCES class_sessions(id),
  name                TEXT NOT NULL,
  email               TEXT NOT NULL,
  phone               TEXT NOT NULL DEFAULT '',
  notes               TEXT NOT NULL DEFAULT '',
  status              TEXT NOT NULL,          -- pending | confirmed | cancelled | expired
  token               TEXT NOT NULL UNIQUE,   -- secret for the customer's manage-booking link
  amount_minor        INTEGER NOT NULL,
  currency            TEXT NOT NULL,
  hold_expires_at     INTEGER,                -- epoch ms, only while pending
  payment_provider    TEXT NOT NULL,          -- stripe | demo | free | manual
  checkout_id         TEXT,
  payment_ref         TEXT,                   -- Stripe PaymentIntent id
  refunded            INTEGER NOT NULL DEFAULT 0,
  waitlist_id         INTEGER REFERENCES waitlist(id),
  created_at          INTEGER NOT NULL,
  confirmed_at        INTEGER,
  cancelled_at        INTEGER
);
CREATE INDEX IF NOT EXISTS bookings_session ON bookings(session_id, status);

CREATE TABLE IF NOT EXISTS waitlist (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id          INTEGER NOT NULL REFERENCES class_sessions(id),
  name                TEXT NOT NULL,
  email               TEXT NOT NULL,
  phone               TEXT NOT NULL DEFAULT '',
  status              TEXT NOT NULL,          -- waiting | offered | claiming | booked | expired | removed
  token               TEXT NOT NULL UNIQUE,   -- secret for the claim / leave-waitlist link
  offer_expires_at    INTEGER,                -- epoch ms
  created_at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS waitlist_session ON waitlist(session_id, status);
`;

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
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
