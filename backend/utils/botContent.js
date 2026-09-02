const { client } = require('../db/db');

/**
 * Everything text-editable about the bot's /start welcome message —
 * caption, the Start Mining button's label, and the three link
 * buttons' labels + URLs. Previously these were hardcoded (labels) or
 * env vars (URLs), both requiring a deploy to change. Now all of it is
 * one admin-panel save away — see the Bot Message section in admin.html.
 *
 * Deliberately a separate table/module from settings.js (numeric) and
 * featureFlags.js (bool+message) rather than overloading either — this
 * is plain text content, no numeric coercion or validation beyond "is
 * it a string", so mixing it into settings.js's Number()-everywhere
 * logic would've been the wrong fit.
 */

const DEFAULTS = {
  welcome_caption: [
    '👋 Welcome to ADLX Miner!',
    '',
    '⛏️ Mine ADLX tokens directly to your Pool Wallet.',
    '⚡ Watch a quick ad to start or restart your mining cycle.',
    '🔗 Connect your TON wallet — right from the Mine tab.',
    '🎡 Spin the wheel, complete tasks, and invite friends for more ADLX.',
    '',
    'Tap below to start.',
  ].join('\n'),
  start_button_label: '🚀 Start Mining',
  pay_button_label: 'ADLX PAY',
  pay_button_url: 'https://t.me/adlxpay',
  official_button_label: 'ADLX OFFICIAL',
  official_button_url: 'https://t.me/ADLX_AIRDROP',
  support_button_label: 'ADLX SUPPORT',
  support_button_url: 'https://t.me/adlxsupport',
};

const CACHE_MS = 15000;
let cache = null;
let cacheAt = 0;

async function loadAll() {
  const res = await client.execute('SELECT key, value FROM bot_content');
  const fromDb = {};
  for (const row of res.rows) fromDb[row.key] = row.value;
  return { ...DEFAULTS, ...fromDb };
}

async function getAllBotContent({ forceRefresh = false } = {}) {
  if (!forceRefresh && cache && Date.now() - cacheAt < CACHE_MS) return cache;
  cache = await loadAll();
  cacheAt = Date.now();
  return cache;
}

async function setBotContent(key, value) {
  if (!(key in DEFAULTS)) {
    const err = new Error(`Unknown bot_content key: ${key}. Known keys: ${Object.keys(DEFAULTS).join(', ')}`);
    err.statusCode = 400;
    throw err;
  }
  await client.execute({
    sql: `INSERT INTO bot_content (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
    args: [key, String(value ?? '')],
  });
  await getAllBotContent({ forceRefresh: true });
}

module.exports = { getAllBotContent, setBotContent, DEFAULTS };
