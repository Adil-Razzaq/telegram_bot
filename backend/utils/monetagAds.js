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

const TASK_BANNER_ACTION = 'adsgram_task_banner';

async function startAdEvent({ telegramId, action }) {
  const nonce = crypto.randomBytes(16).toString('hex');

  // Retire stale still-'pending' rows for this user before minting a new
  // one. This matters for every Adsgram flow, because there are only
  // TWO physical Adsgram blocks in this app — adsgram_block_id (shared
  // by spin, miner start/claim/boost, referral claim, withdrawal
  // request, the streak tab, and the daily_watch:adsgram slot — every
  // one of those calls showActionAd/showStreakAd/showAdsgramRewardedAd
  // with that same block id) and adsgram_task_banner_block_id (used only
  // by the task banner). Adsgram allows exactly ONE Reward Url per
  // block, so ALL actions sharing a block are confirmed by the SAME
  // postback, matched as "oldest still-pending row for this user" (see
  // confirmOldestPendingByUser below) — action-blind for the shared
  // block, action-scoped only for the task banner's own block.
  //
  // An abandoned/failed earlier attempt (closed tab, SDK error, a
  // previous withConfirmationRetry timing out) leaves its row sitting in
  // 'pending' for up to NONCE_TTL_MINUTES. Left alone, that stale row
  // sits ahead of the new one in the queue and steals the next ad's
  // confirmation instead of the nonce actually being waited on — the
  // "Ad not yet confirmed" loop. So: retire the whole shared-block queue
  // whenever a shared-block action starts a new attempt, and retire only
  // same-action rows for the task banner's own independent queue.
  // Harmless for Monetag either way — it confirms by exact ymid, so a
  // cleared stale row was never going to match anything.
  const sql =
    action === TASK_BANNER_ACTION
      ? `DELETE FROM pending_ad_events WHERE telegram_id = ? AND action = ? AND status = 'pending'`
      : `DELETE FROM pending_ad_events WHERE telegram_id = ? AND action != ? AND status = 'pending'`;
  await client.execute({ sql, args: [telegramId, TASK_BANNER_ACTION] });

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
// `action` is OPTIONAL: pass it only for the task banner's dedicated
// Adsgram block (adsgram_task_banner_block_id), which has its own
// Reward Url scoped to action='adsgram_task_banner' — see routes/bot.js.
// Omit it for every other Adsgram flow: spin, miner start/claim/boost,
// referral claim, withdrawal request, the streak tab, and the
// daily_watch:adsgram slot all reuse the SAME single adsgram_block_id,
// and Adsgram only allows ONE Reward Url per block — so there's no way
// to route by action there; matching "oldest pending for this user, any
// action" is the correct behavior, and startAdEvent above keeps that
// queue clean of stale rows so "oldest" always means the current attempt.
async function confirmOldestPendingByUser({ telegramId, action, estimatedPrice = 0 }) {
  // When no action is given (the shared-block Reward Url used by spin/
  // miner/referral/withdrawal/streak/daily_watch:adsgram), the task
  // banner's queue must be excluded explicitly. The task banner has its
  // OWN separate Adsgram block and its own action-scoped Reward Url
  // (confirmed via the `action` branch below instead) — if a banner
  // nonce is armed (which happens automatically on Tasks-page mount)
  // and happens to be older than the nonce this shared-block ad watch
  // just started, "oldest pending for this user" would otherwise match
  // the banner's row instead of the one actually being waited on, and
  // the real nonce would never confirm ("Ad not yet confirmed" forever)
  // even though a postback genuinely arrived and matched *something*.
  const sql = action
    ? `SELECT nonce FROM pending_ad_events
       WHERE telegram_id = ? AND action = ? AND status = 'pending'
         AND created_at >= datetime('now', '-${NONCE_TTL_MINUTES} minutes')
       ORDER BY created_at ASC LIMIT 1`
    : `SELECT nonce FROM pending_ad_events
       WHERE telegram_id = ? AND action != ? AND status = 'pending'
         AND created_at >= datetime('now', '-${NONCE_TTL_MINUTES} minutes')
       ORDER BY created_at ASC LIMIT 1`;
  const args = action ? [telegramId, action] : [telegramId, TASK_BANNER_ACTION];
  const res = await client.execute({ sql, args });
  const row = res.rows[0];
  if (!row) return false;
  return confirmAdEvent({ nonce: row.nonce, estimatedPrice });
}

const { getAllSettings } = require('./settings');

// Every reward-gated action (spin, miner start/claim/boost, referral
// claim, withdrawal request, task claim, watch-ad tasks) goes through
// these two instead of calling startAdEvent/consumeAdEvent directly.
// `settingKey` names WHICH admin boolean gates this specific action —
// each caller passes its own dedicated setting (spin_ads_enabled,
// miner_start_ads_enabled, etc.) so every button's ad requirement is
// independently switchable in the admin panel, instead of one shared
// on/off for all of them. When that setting is off, prepare returns
// null (frontend skips showing an ad entirely — see each component's
// handleX function) and consume is a no-op (nothing to verify, the ad
// requirement is off). The stale-row cleanup for Adsgram's shared-block
// queue lives in startAdEvent itself, so every caller gets it
// regardless of whether it goes through this wrapper (taskBannerService
// and adWatchService call startAdEvent directly — those two already
// have their own independent gating via daily-limit / block-id
// settings, not a boolean here).
async function startAdEventIfRequired({ telegramId, action, settingKey }) {
  const settings = await getAllSettings();
  if (!settings[settingKey]) return null;
  return startAdEvent({ telegramId, action });
}

async function consumeAdEventIfRequired({ nonce, telegramId, action, settingKey }) {
  const settings = await getAllSettings();
  if (!settings[settingKey]) return null;
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