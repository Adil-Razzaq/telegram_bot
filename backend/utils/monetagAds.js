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
 *    see routes/bot.js) with that same ymid plus `reward_event_type`
 *    (their dashboard shows this as "yes"/"no"; their docs elsewhere
 *    say "valued"/"not_valued" — both are accepted defensively) and
 *    `estimated_price`, Monetag's own real revenue estimate for that
 *    exact ad view. confirmAdEvent (below) marks the row confirmed and
 *    stores that price — see ad_postback_log in schema.sql for the full
 *    raw record of every postback, independent of this table.
 * 4. Only a confirmed nonce can be spent (consumeAdEvent) by the actual
 *    spin/claim endpoint — and it can only be spent once. It returns the
 *    full event row (including estimated_price) so a caller like
 *    bonusAdService can size a reward off the ad's real value.
 *
 * The postback URL itself has no signature from Monetag, so the secret
 * path segment in routes/bot.js (same pattern as the Telegram webhook)
 * is what stops someone from hitting it directly — they'd need to guess
 * both a real nonce AND that secret.
 */

const NONCE_TTL_MINUTES = 15;

async function startAdEvent({ telegramId, action }) {
  const nonce = crypto.randomBytes(16).toString('hex');
  // Retire any earlier still-'pending' row for this exact telegram_id +
  // action first. Harmless for Monetag (it confirms by exact ymid, so a
  // stale row here was never going to match anything anyway), but
  // required for Adsgram's dedicated-block flows (daily_watch:adsgram,
  // adsgram_task_banner), which confirm by "oldest pending FOR THIS
  // ACTION" — an abandoned earlier attempt would otherwise sit ahead of
  // the new nonce and steal its confirmation. See startAdEventIfRequired
  // below for the analogous cross-action fix on the shared-block flows.
  await client.execute({
    sql: `DELETE FROM pending_ad_events WHERE telegram_id = ? AND action = ? AND status = 'pending'`,
    args: [telegramId, action],
  });

  await client.execute({
    sql: 'INSERT INTO pending_ad_events (nonce, telegram_id, action) VALUES (?, ?, ?)',
    args: [nonce, telegramId, action],
  });
  return nonce;
}

async function confirmAdEvent({ nonce, estimatedPrice }) {
  const price = Number(estimatedPrice);
  const safePrice = Number.isFinite(price) && price > 0 ? price : 0;
  const res = await client.execute({
    sql: `UPDATE pending_ad_events
          SET status = 'confirmed', confirmed_at = CURRENT_TIMESTAMP, estimated_price = ?
          WHERE nonce = ? AND status = 'pending'`,
    args: [safePrice, nonce],
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
    const err = new Error('Ad not yet confirmed — wait a moment and try again');
    err.statusCode = 400;
    throw err;
  }

  const updateRes = await client.execute({
    sql: `UPDATE pending_ad_events SET status = 'consumed' WHERE nonce = ? AND status = 'confirmed'`,
    args: [nonce],
  });
  if (updateRes.rowsAffected === 0) {
    const err = new Error('This ad verification token was already used');
    err.statusCode = 409;
    throw err;
  }

  return event;
}

// Adsgram's server-side "Reward Url" has no nonce/custom-param support —
// per their docs it's a plain GET with only the Telegram user ID
// substituted in. So instead of matching an exact nonce (confirmAdEvent
// above), this confirms the OLDEST still-pending event for this exact
// user (+ action, when given). Safe under normal single-tab use (a user
// only has one truly pending Adsgram ad-watch at a time); the tradeoff,
// same class as the one already noted in playSpin, is a user
// rapid-firing multiple tabs could in theory confirm out of order — not
// exploitable for extra reward, just a possible UX mixup, so acceptable
// here.
//
// `action` is OPTIONAL: pass it for the two dedicated task-bar watch-ad
// slots (each gets its own Adsgram block, so each has its own Reward
// Url with a distinct :action path segment — see routes/bot.js).
// Omit it for the shared action_ads_network='adsgram' case (spin, miner
// start/claim, referral claim all reuse ONE adsgram_block_id, and
// Adsgram only allows ONE Reward Url per block — so there's no way to
// route by action there; matching "oldest pending for this user, any
// action" is the correct behavior since a user can only be mid-flow on
// one of these at a time in practice).
async function confirmOldestPendingByUser({ telegramId, action, estimatedPrice = 0 }) {
  const sql = action
    ? `SELECT nonce FROM pending_ad_events
       WHERE telegram_id = ? AND action = ? AND status = 'pending'
         AND created_at >= datetime('now', '-${NONCE_TTL_MINUTES} minutes')
       ORDER BY created_at ASC LIMIT 1`
    : `SELECT nonce FROM pending_ad_events
       WHERE telegram_id = ? AND status = 'pending'
         AND created_at >= datetime('now', '-${NONCE_TTL_MINUTES} minutes')
       ORDER BY created_at ASC LIMIT 1`;
  const args = action ? [telegramId, action] : [telegramId];
  const res = await client.execute({ sql, args });
  const row = res.rows[0];
  if (!row) return false;
  return confirmAdEvent({ nonce: row.nonce, estimatedPrice });
}

const { getAllSettings } = require('./settings');

// The four actions that share ONE adsgram_block_id / one no-action
// Reward Url when action_ads_network === 'adsgram' (see the big comment
// on confirmOldestPendingByUser above and routes/bot.js). Adsgram's
// postback for any of these confirms whichever row is the OLDEST still
// 'pending' for that telegram_id, with zero regard for which action it
// belongs to.
const SHARED_ADSGRAM_ACTIONS = new Set(['spin', 'miner_start', 'miner_claim', 'referral_claim']);

// Every reward-gated action (spin, miner start/claim, referral claim,
// task claim, watch-ad tasks) goes through these two instead of calling
// startAdEvent/consumeAdEvent directly, so the admin's single
// action_ads_enabled switch (Settings panel) affects all of them at
// once. When off, prepare returns null (frontend skips showRewardedAd
// entirely — see each component's handleX function) and consume is a
// no-op (nothing to verify, the ad requirement is off).
async function startAdEventIfRequired({ telegramId, action }) {
  const settings = await getAllSettings();
  if (!settings.action_ads_enabled) return null;

  // Bug fix: an abandoned/failed earlier attempt (user backed out, the
  // ad SDK errored, a previous withConfirmationRetry timed out, etc.)
  // leaves its nonce sitting in 'pending' — it doesn't expire for
  // NONCE_TTL_MINUTES. Because the shared-block postback matches
  // "oldest pending, any action" rather than a specific nonce, that
  // leftover row jumps the queue: the NEXT ad watched (for a totally
  // different attempt, possibly a different one of these four actions)
  // gets its confirmation stolen by the stale row instead of the nonce
  // the frontend is actually polling on — which is exactly the "Ad not
  // yet confirmed" loop reported in production. Since a user can only
  // be genuinely mid-flow on one of these four at a time, it's always
  // correct to retire any older pending rows among them before minting
  // a new one, so "oldest pending" is always the one just created.
  if (settings.action_ads_network === 'adsgram' && SHARED_ADSGRAM_ACTIONS.has(action)) {
    await client.execute({
      sql: `DELETE FROM pending_ad_events
            WHERE telegram_id = ? AND status = 'pending'
              AND action IN ('spin', 'miner_start', 'miner_claim', 'referral_claim')`,
      args: [telegramId],
    });
  }

  return startAdEvent({ telegramId, action });
}

async function consumeAdEventIfRequired({ nonce, telegramId, action }) {
  const { action_ads_enabled } = await getAllSettings();
  if (!action_ads_enabled) return null;
  return consumeAdEvent({ nonce, telegramId, action });
}

module.exports = {
  startAdEvent,
  confirmAdEvent,
  confirmOldestPendingByUser,
  consumeAdEvent,
  startAdEventIfRequired,
  consumeAdEventIfRequired,
};