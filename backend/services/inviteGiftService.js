const { client } = require('../db/db');
const { getAllSettings } = require('../utils/settings');
const { startAdEvent, consumeAdEvent } = require('../utils/monetagAds');

/**
 * "Invite Gift" — a ONE-TIME, instant, ad-funded welcome bonus for a
 * NEW user who opened the app via someone's referral link, paid out
 * the moment they watch a single Adsgram ad. Both the new user AND
 * whoever referred them get credited instantly — separate from (and in
 * addition to) the slower referral_reward bonus, which still requires
 * referral_qualify_miner_cycles cycles before the referrer gets paid.
 * See settings.js's invite_gift_* settings for the full reasoning.
 */

async function getStatus({ telegramId }) {
  const [settings, userRes] = await Promise.all([
    getAllSettings(),
    client.execute({
      sql: `SELECT users.referred_by, users.invite_gift_claimed,
                   referrer.telegram_id AS referrer_telegram_id, referrer.username AS referrer_username
            FROM users
            LEFT JOIN users AS referrer ON referrer.telegram_id = users.referred_by
            WHERE users.telegram_id = ?`,
      args: [telegramId],
    }),
  ]);
  const user = userRes.rows[0];
  const configured = Boolean(settings.invite_gift_adsgram_block_id);
  const eligible = configured && Boolean(user?.referred_by) && !user?.invite_gift_claimed;

  return {
    eligible,
    block_id: settings.invite_gift_adsgram_block_id,
    new_user_points: settings.invite_gift_new_user_points,
    referrer_points: settings.invite_gift_referrer_points,
    // For the app-open popup: "You were invited by @username" (falls
    // back to a plain Telegram ID if the referrer has no username set
    // — not everyone does).
    referrer_telegram_id: user?.referrer_telegram_id ?? null,
    referrer_username: user?.referrer_username ?? null,
  };
}

async function prepareClaim({ telegramId }) {
  const status = await getStatus({ telegramId });
  if (!status.eligible) {
    const err = new Error('No welcome gift available');
    err.statusCode = 400;
    throw err;
  }
  return startAdEvent({ telegramId, action: 'invite_gift' });
}

async function claimGift({ telegramId, nonce }) {
  // Consumed BEFORE opening the write transaction below — same
  // ordering as every other ad-gated action in this app (see
  // minerService.js's claim() for exactly why doing this INSIDE an
  // open transaction self-deadlocks on a single-writer database).
  await consumeAdEvent({ telegramId, nonce, action: 'invite_gift' });

  const settings = await getAllSettings();
  const newUserPoints = Math.round(settings.invite_gift_new_user_points);
  const referrerPoints = Math.round(settings.invite_gift_referrer_points);

  const tx = await client.transaction('write');
  try {
    // Re-check eligibility inside the transaction — locks out a
    // double-claim from two rapid taps the same way every other
    // one-shot flag in this app does (see referralService.js's
    // maybeQualifyReferral for the identical pattern).
    const userRes = await tx.execute({
      sql: 'SELECT referred_by, invite_gift_claimed FROM users WHERE telegram_id = ?',
      args: [telegramId],
    });
    const user = userRes.rows[0];
    if (!user?.referred_by || user.invite_gift_claimed) {
      const err = new Error('No welcome gift available');
      err.statusCode = 400;
      throw err;
    }

    await tx.execute({
      sql: 'UPDATE users SET invite_gift_claimed = 1, main_balance = main_balance + ? WHERE telegram_id = ?',
      args: [newUserPoints, telegramId],
    });
    await tx.execute({
      sql: 'UPDATE users SET main_balance = main_balance + ? WHERE telegram_id = ?',
      args: [referrerPoints, user.referred_by],
    });
    await tx.execute({
      sql: 'INSERT INTO ledger (telegram_id, type, points_delta, meta) VALUES (?, ?, ?, ?)',
      args: [telegramId, 'invite_gift_new_user', newUserPoints, JSON.stringify({ referrerId: user.referred_by })],
    });
    await tx.execute({
      sql: 'INSERT INTO ledger (telegram_id, type, points_delta, meta) VALUES (?, ?, ?, ?)',
      args: [user.referred_by, 'invite_gift_referrer', referrerPoints, JSON.stringify({ newUserId: telegramId })],
    });

    const updatedRes = await tx.execute({
      sql: 'SELECT main_balance FROM users WHERE telegram_id = ?',
      args: [telegramId],
    });
    await tx.commit();
    return { earned_points: newUserPoints, main_balance: updatedRes.rows[0].main_balance };
  } catch (err) {
    await tx.rollback().catch(() => {});
    throw err;
  }
}

module.exports = { getStatus, prepareClaim, claimGift };
