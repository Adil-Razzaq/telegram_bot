const { client } = require('../db/db');

/**
 * Every number in this app that a real operator would want to tune
 * without a code deploy lives here: point value, reward amounts, miner
 * timing. Cached for CACHE_MS so a settings change via the admin panel
 * takes up to that long to apply everywhere — a reasonable trade for not
 * hitting the database on every single spin/claim/miner-tick.
 */

const CACHE_MS = 15000;
let cache = null;
let cacheAt = 0;

const DEFAULTS = {
  points_per_usd: 10000, // 10,000 points = $1
  referral_reward: 100, // points granted to the referrer per successful ad-watched claim
  miner_daily_points: 150, // total points available from the miner per day, across all cycles
  miner_cycles_per_day: 4,
  miner_cycle_hours: 6, // 4 x 6 = a full 24h day, by design — see minerService.js
  spin_entry_fee: 100, // charged per spin once free spins are used up
  spin_free_spins: 3, // first N spins for a new user skip the entry fee (still requires watching an ad)
  spin_payout_1: 10,
  spin_payout_2: 20,
  spin_payout_3: 50,
  spin_payout_4: 100,
  spin_payout_5: 200,
  spin_payout_6: 500,
};

async function loadAll() {
  const res = await client.execute('SELECT key, value FROM settings');
  const fromDb = {};
  for (const row of res.rows) fromDb[row.key] = row.value;
  const merged = { ...DEFAULTS, ...fromDb };
  // Values from the DB arrive as TEXT; DEFAULTS are already numbers. Without
  // this, a setting that's never been edited stays a number while one
  // that HAS been edited becomes a string — inconsistent depending on
  // edit history, which is exactly the kind of thing that silently breaks
  // strict comparisons and JSON consumers downstream.
  const normalized = {};
  for (const [key, value] of Object.entries(merged)) normalized[key] = Number(value);
  return normalized;
}

async function getAllSettings({ forceRefresh = false } = {}) {
  if (!forceRefresh && cache && Date.now() - cacheAt < CACHE_MS) return cache;
  cache = await loadAll();
  cacheAt = Date.now();
  return cache;
}

async function getSetting(key) {
  const all = await getAllSettings();
  const raw = all[key];
  return raw === undefined ? undefined : Number(raw);
}

async function setSetting(key, value) {
  if (!(key in DEFAULTS)) {
    const err = new Error(`Unknown setting key: ${key}. Known keys: ${Object.keys(DEFAULTS).join(', ')}`);
    err.statusCode = 400;
    throw err;
  }
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) {
    const err = new Error(`Setting ${key} must be a positive number`);
    err.statusCode = 400;
    throw err;
  }
  await client.execute({
    sql: `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
    args: [key, String(num)],
  });
  await getAllSettings({ forceRefresh: true });
}

module.exports = { getAllSettings, getSetting, setSetting, DEFAULTS };
