const { Pool } = require('pg');

const url = process.env.DATABASE_URL || process.env.POSTGRES_URL || '';
const local = /localhost|127\.0\.0\.1/.test(url);
// Small pool: every serverless instance keeps its own, so keep it tiny. Use your host's POOLED connection string.
const pool = new Pool({ connectionString: url, max: 3, ssl: local ? false : { rejectUnauthorized: false } });

const q = (text, params) => pool.query(text, params);

// Runs fn inside one database transaction. fn receives a query function bound to that transaction,
// and MUST use it (never q) for everything inside.
async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await fn((text, params) => client.query(text, params));
    await client.query('COMMIT');
    return r;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    throw e;
  } finally { client.release(); }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS members(
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL, email TEXT NOT NULL, phone TEXT NOT NULL UNIQUE,
  network TEXT NOT NULL, pass_hash TEXT NOT NULL, code TEXT NOT NULL UNIQUE,
  parent_id INTEGER REFERENCES members(id),
  sponsor_id INTEGER REFERENCES members(id),
  side TEXT CHECK (side IN ('L','R')),
  active INTEGER NOT NULL DEFAULT 0,
  left_active INTEGER NOT NULL DEFAULT 0,
  right_active INTEGER NOT NULL DEFAULT 0,
  recipient_code TEXT, created TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_members_parent ON members(parent_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_members_slot ON members(parent_id, side);
CREATE TABLE IF NOT EXISTS signups(
  id SERIAL PRIMARY KEY, reference TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL, email TEXT NOT NULL, phone TEXT NOT NULL, network TEXT NOT NULL,
  pass_hash TEXT NOT NULL, ref_code TEXT, side TEXT, amount INTEGER NOT NULL,
  status TEXT NOT NULL, member_id INTEGER, created TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS purchases(
  id SERIAL PRIMARY KEY, member_id INTEGER NOT NULL REFERENCES members(id),
  reference TEXT NOT NULL UNIQUE, amount INTEGER NOT NULL, status TEXT NOT NULL, created TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ledger(
  id SERIAL PRIMARY KEY, member_id INTEGER NOT NULL REFERENCES members(id),
  kind TEXT NOT NULL, amount INTEGER NOT NULL, ref TEXT NOT NULL UNIQUE,
  src_id INTEGER, level INTEGER, created TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_ledger_member ON ledger(member_id);
CREATE TABLE IF NOT EXISTS payouts(
  id SERIAL PRIMARY KEY, member_id INTEGER NOT NULL REFERENCES members(id),
  amount INTEGER NOT NULL, fee INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL,
  reference TEXT UNIQUE, created TEXT NOT NULL);
`;

// Creates the tables the first time the app runs (and does nothing afterwards).
let ready = null;
function init() {
  if (!ready) {
    ready = tx(async (c) => {
      await c('SELECT pg_advisory_xact_lock(727001)'); // so two cold starts don't both create tables
      await c(SCHEMA);
    }).catch((e) => { ready = null; throw e; });
  }
  return ready;
}

module.exports = { q, tx, init, pool };
