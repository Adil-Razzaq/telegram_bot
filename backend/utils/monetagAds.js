const crypto = require('crypto');
const { client } = require('../db/db');

/**
 * How Monetag reward verification actually works (confirmed against
 * docs.monetag.com/docs/postbacks/ — this is a real server-to-server
 * confirmation, unlike Adsgram's client-only promise at this traffic
 * tier):
 *
 * 1. Before showing an ad, your backend creates a `pending_ad_events` row
 *    with a random nonce (startAdEvent below) and hands the nonce to the
 *    frontend.
 * 2. The frontend shows the Monetag ad, passing that nonce as `ymid`.
 * 3. Monetag's servers — independently of anything the frontend says —
 *    GET your postback URL (registered once in the Monetag dashboard,
 *    see routes/bot.js) with that same ymid plus `reward_event_type`,
 *    which is 'valued' only if the ad was genuinely watched and
 *    monetized. confirmAdEvent (below) marks the row confirmed.
 * 4. Only a confirmed nonce can be spent (consumeAdEvent) by the actual
 *    spin/claim endpoint — and it can only be spent once.
 *
 * The postback URL itself has no signature from Monetag, so the secret
 * path segment in routes/bot.js (same pattern as the Telegram webhook)
 * is what stops someone from hitting it directly — they'd need to guess
 * both a real nonce AND that secret.
 */

const NONCE_TTL_MINUTES = 15;

async function startAdEvent({ telegramId, action }) {
  const nonce = crypto.randomBytes(16).toString('hex');
  await client.execute({
    sql: 'INSERT INTO pending_ad_events (nonce, telegram_id, action) VALUES (?, ?, ?)',
    args: [nonce, telegramId, action],
  });
  return nonce;
}

async function confirmAdEvent({ nonce }) {
  const res = await client.execute({
    sql: `UPDATE pending_ad_events SET status = 'confirmed', confirmed_at = CURRENT_TIMESTAMP
          WHERE nonce = ? AND status = 'pending'`,
    args: [nonce],
  });
  return res.rowsAffected > 0;
}

// Called by the spin/claim service right before crediting anything.
// Consumes (spends) a confirmed nonce so it can never be reused, and
// verifies it actually belongs to this user and this action.
async function consumeAdEvent({ nonce, telegramId, action }) {
  if (!nonce) {
    const err = new Error('Missing ad verification token — watch the ad first');
    err.statusCode = 400;
    throw err;
  }

  const res = await client.execute({
    sql: `SELECT * FROM pending_ad_events
          WHERE nonce = ? AND telegram_id = ? AND action = ?
            AND created_at >= datetime('now', '-${NONCE_TTL_MINUTES} minutes')`,
    args: [nonce, telegramId, action],
  });
  const event = res.rows[0];
  if (!event) {
    const err = new Error('Ad verification token not found or expired — watch the ad again');
    err.statusCode = 400;
    throw err;
  }
  if (event.status === 'consumed') {
    const err = new Error('This ad verification token was already used');
    err.statusCode = 409;
    throw err;
  }
  if (event.status !== 'confirmed') {
    const err = new Error('Ad not yet confirmed by Monetag — wait a moment and try again');
    err.statusCode = 400;
    throw err;
  }

  const updateRes = await client.execute({
    sql: `UPDATE pending_ad_events SET status = 'consumed' WHERE nonce = ? AND status = 'confirmed'`,
    args: [nonce],
  });
  if (updateRes.rowsAffected === 0) {
    // Lost a race — someone/something already consumed it between our
    // SELECT and this UPDATE.
    const err = new Error('This ad verification token was already used');
    err.statusCode = 409;
    throw err;
  }
}

module.exports = { startAdEvent, confirmAdEvent, consumeAdEvent };
