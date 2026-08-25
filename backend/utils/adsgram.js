const { client } = require('../db/db');

/**
 * WHAT ADSGRAM ACTUALLY GIVES YOU (confirmed against their docs at
 * docs.adsgram.ai/publisher/api-reference and .../get-block-id — this
 * replaces an earlier version of this file that assumed a signed token,
 * which isn't how Adsgram works):
 *
 * - `AdController.show()` on the frontend resolves/rejects a Promise
 *   based on whether the user watched the ad. It does NOT hand back a
 *   token, signature, or anything else your backend can independently
 *   verify. That promise result is inherently a client-side claim —
 *   anyone who opens devtools can call your API and claim they watched
 *   an ad without ever loading one.
 * - Adsgram DOES offer an optional server-to-server "Reward URL": once
 *   you're doing real volume (they specifically say "makes sense for
 *   publishers who have more than 50k daily average users"), you set a
 *   URL like `https://yourapp.com/bot/adsgram-reward?userid=[userId]` in
 *   their dashboard and they GET it after confirming a real ad view.
 *   There's no per-request nonce or signature in that callback — just
 *   the Telegram user id — so it can't be tied to one specific spin or
 *   claim, only used as an independent audit signal ("did Adsgram think
 *   this user watched N ads today").
 *
 * Given that, real protection here is:
 *   1. Require a valid, HMAC-verified Telegram initData (already true
 *      for every route via telegramAuth) — so at minimum this is a real
 *      Telegram user, not an anonymous script.
 *   2. A minimum-interval check between spins/claims (below) — a crude
 *      but honest heuristic: a real rewarded ad takes several seconds,
 *      so back-to-back requests faster than that are almost certainly
 *      scripted, not a fast human.
 *   3. Log Adsgram's Reward URL pings (see routes/bot.js) into
 *      ad_reward_pings so you can periodically compare "rewards claimed"
 *      vs "ad views Adsgram confirmed" per user and flag outliers by
 *      hand — this is detection, not prevention, but it's the honest
 *      ceiling of what's available without paid ad-network tiers.
 *
 * None of this is airtight. If/when abuse becomes a real cost, the
 * generally-accepted patterns are: cap total daily payout per user
 * tightly (you already do, for referrals), and/or move to an ad network
 * that does give you a verifiable server callback per impression.
 */

const MIN_INTERVAL_SECONDS = {
  spin: 8,
  referral_claim: 8,
};

async function checkMinInterval({ telegramId, action, lastTimestamp }) {
  const minSeconds = MIN_INTERVAL_SECONDS[action] || 5;
  if (!lastTimestamp) return { ok: true };
  const elapsed = (Date.now() - new Date(lastTimestamp).getTime()) / 1000;
  if (elapsed < minSeconds) {
    return { ok: false, reason: `too_fast (${Math.ceil(minSeconds - elapsed)}s remaining)` };
  }
  return { ok: true };
}

async function recordRewardPing(telegramId) {
  await client.execute({
    sql: 'INSERT INTO ad_reward_pings (telegram_id) VALUES (?)',
    args: [telegramId],
  });
}

module.exports = { checkMinInterval, recordRewardPing, MIN_INTERVAL_SECONDS };
