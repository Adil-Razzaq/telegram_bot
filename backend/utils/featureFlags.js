const { client } = require('../db/db');

/**
 * A named on/off switch with a free-text message attached — built first
 * for pausing withdrawals, but written generically so any future
 * feature can get the same "disable it, explain why, re-enable later"
 * treatment without new code. Add a key to KNOWN_FLAGS and it's
 * immediately manageable from the admin panel.
 *
 * The message is genuinely free text, not a fixed enum of reasons —
 * that's the point. "Coming Soon" today, "Maintenance" next month,
 * "Emergency Pause — investigating" during an actual incident, all the
 * same mechanism, changed from the admin panel with no deploy.
 */

const KNOWN_FLAGS = {
  withdrawals: {
    defaultEnabled: true,
    defaultMessage:
      "We're working on launching our own coin — withdrawals are paused for now and expected back within 2–3 weeks. Your balance is safe and untouched.",
  },
};

const CACHE_MS = 10000; // shorter than settings.js — a flag flip during an actual emergency shouldn't take 15s to propagate
let cache = null;
let cacheAt = 0;

async function loadAll() {
  const res = await client.execute('SELECT key, enabled, message FROM feature_flags');
  const fromDb = {};
  for (const row of res.rows) fromDb[row.key] = { enabled: !!row.enabled, message: row.message || '' };

  const merged = {};
  for (const [key, defaults] of Object.entries(KNOWN_FLAGS)) {
    merged[key] = fromDb[key] || { enabled: defaults.defaultEnabled, message: defaults.defaultMessage };
  }
  return merged;
}

async function getAllFlags({ forceRefresh = false } = {}) {
  if (!forceRefresh && cache && Date.now() - cacheAt < CACHE_MS) return cache;
  cache = await loadAll();
  cacheAt = Date.now();
  return cache;
}

async function getFlag(key) {
  const all = await getAllFlags();
  return all[key] || { enabled: true, message: '' };
}

async function setFlag(key, { enabled, message }) {
  if (!(key in KNOWN_FLAGS)) {
    const err = new Error(`Unknown flag: ${key}. Known flags: ${Object.keys(KNOWN_FLAGS).join(', ')}`);
    err.statusCode = 400;
    throw err;
  }
  await client.execute({
    sql: `INSERT INTO feature_flags (key, enabled, message, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(key) DO UPDATE SET enabled = excluded.enabled, message = excluded.message, updated_at = CURRENT_TIMESTAMP`,
    args: [key, enabled ? 1 : 0, message || ''],
  });
  await getAllFlags({ forceRefresh: true });
}

module.exports = { getAllFlags, getFlag, setFlag, KNOWN_FLAGS };
