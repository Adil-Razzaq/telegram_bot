const { client } = require('../db/db');
const { startAdEvent, consumeAdEvent } = require('../utils/monetagAds');

const POINTS_PER_USD = 10000; // matches withdrawalService.js — one point system, one rate
const REVENUE_SHARE = 0.5; // user gets 50% of what the ad actually earned; you keep the rest
const MIN_REWARD_POINTS = 1; // floor so a genuinely-valued-but-tiny-CPM event still pays *something*

/**
 * Fully optional — nothing else in the app requires this. This is the
 * ONLY ad-gated reward left after the spin/referral changes, and its
 * payout is mathematically tied to real ad revenue instead of a flat
 * number someone picked, which is what keeps it from ever drifting into
 * "unrealistic and excessively high" territory (Monetag policy item #8):
 * whatever the ad actually earned, the user gets half, always.
 */
async function prepareBonusAd({ telegramId }) {
  return startAdEvent({ telegramId, action: 'bonus_ad' });
}

async function claimBonusAd({ telegramId, nonce }) {
  const event = await consumeAdEvent({ nonce, telegramId, action: 'bonus_ad' });

  const rawReward = (event.estimated_price || 0) * POINTS_PER_USD * REVENUE_SHARE;
  const pointsAwarded = Math.max(MIN_REWARD_POINTS, Math.round(rawReward));

  const tx = await client.transaction('write');
  try {
    await tx.execute({
      sql: 'INSERT OR IGNORE INTO users (telegram_id) VALUES (?)',
      args: [telegramId],
    });
    await tx.execute({
      sql: 'UPDATE users SET main_balance = main_balance + ? WHERE telegram_id = ?',
      args: [pointsAwarded, telegramId],
    });
    await tx.execute({
      sql: 'INSERT INTO ledger (telegram_id, type, points_delta, meta) VALUES (?, ?, ?, ?)',
      args: [
        telegramId,
        'bonus_ad_reward',
        pointsAwarded,
        JSON.stringify({ estimated_price: event.estimated_price || 0, revenue_share: REVENUE_SHARE }),
      ],
    });

    const updatedRes = await tx.execute({
      sql: 'SELECT main_balance FROM users WHERE telegram_id = ?',
      args: [telegramId],
    });
    await tx.commit();

    return {
      points_awarded: pointsAwarded,
      main_balance: updatedRes.rows[0].main_balance,
    };
  } catch (err) {
    await tx.rollback().catch(() => {});
    throw err;
  }
}

module.exports = { prepareBonusAd, claimBonusAd, POINTS_PER_USD, REVENUE_SHARE };
