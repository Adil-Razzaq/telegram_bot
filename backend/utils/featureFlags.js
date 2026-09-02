const { client } = require('../db/db');

const CACHE_MS = 15000;
let cache = null;
let cacheAt = 0;

async function loadAll() {
  const res = await client.execute('SELECT key, enabled, message FROM feature_flags');
  const flags = {};
  for (const row of res.rows) {
    flags[row.key] = { enabled: !!row.enabled, message: row.message || '' };
  }
  return flags;
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

async function setFlag(key, enabled, message) {
  await client.execute({
    sql: `INSERT INTO feature_flags (key, enabled, message, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(key) DO UPDATE SET enabled = excluded.enabled, message = excluded.message, updated_at = CURRENT_TIMESTAMP`,
    args: [key, enabled ? 1 : 0, message || null],
  });
  await getAllFlags({ forceRefresh: true });
}

module.exports = { getAllFlags, getFlag, setFlag };
