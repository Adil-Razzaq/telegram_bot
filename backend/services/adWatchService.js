const { client } = require('../db/db');
const { getAllSettings } = require('../utils/settings');
const { startAdEvent, consumeAdEvent } = require('../utils/monetagAds');

/**
 * The two fixed task-bar slots: "Watch a Monetag ad" and "Watch an
 * Adsgram ad", each repeatable up to its own daily limit (Settings:
 * watch_ad_daily_limit_monetag / _adsgram). Reward calculation is
 * deliberately different per network — Adsgram's Reward Url carries no
 * ad-value, only Monetag's does:
 *
 *   - Monetag: reward = monetag_task_reward_percent% of the ad's real
 *     estimated_price (USD), converted to points via points_per_usd.
 *     Comes from confirmAdEvent's stored estimated_price — the actual
 *     number Monetag's postback reported, not an estimate.
 *   - Adsgram: reward = a fixed adsgram_task_reward_points (Settings) —
 *     Adsgram never tells us what the ad was actually worth.
 *
 * These are NOT gated by action_ads_enabled — turning off "require an
 * ad for reward actions" doesn't make sense for a task whose entire
 * point is watching an ad; if action_ads_enabled is off, the frontend
 * hides these two cards entirely instead (see Tasks.jsx).
 */

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

async function getWatchState(telegramId) {
  const res = await client.execute({
    sql: `SELECT network, watch_count FROM daily_ad_watch_state
          WHERE telegram_id = ? AND watch_date = ?`,
    args: [telegramId, todayUTC()],
  });
  const counts = { monetag: 0, adsgram: 0 };
  for (const row of res.rows) counts[row.network] = row.watch_count;
  return counts;
}

async function getStatus({ telegramId }) {
  const [settings, counts] = await Promise.all([getAllSettings(), getWatchState(telegramId)]);
  return {
    monetag: {
      watched_today: counts.monetag,
      daily_limit: settings.watch_ad_daily_limit_monetag,
      can_watch: counts.monetag < settings.watch_ad_daily_limit_monetag,
      // reward_percent deliberately NOT included here — it's an internal
      // revenue-share detail (see claimWatch below, which still uses
      // settings.monetag_task_reward_percent directly), not something
      // the client/API response should expose, even unused in the UI.
    },
    adsgram: {
      watched_today: counts.adsgram,
      daily_limit: settings.watch_ad_daily_limit_adsgram,
      can_watch: counts.adsgram < settings.watch_ad_daily_limit_adsgram,
      reward_points: settings.adsgram_task_reward_points,
    },
  };
}

async function prepareWatch({ telegramId, network }) {
  const status = await getStatus({ telegramId });
  if (!status[network].can_watch) {
    const err = new Error(`You've hit today's limit for this ad (${status[network].daily_limit}/day) — come back tomorrow`);
    err.statusCode = 400;
    throw err;
  }
  return startAdEvent({ telegramId, action: `daily_watch:${network}` });
}

async function claimWatch({ telegramId, network, nonce }) {
  const event = await consumeAdEvent({ nonce, telegramId, action: `daily_watch:${network}` });
  const settings = await getAllSettings();

  const earnedPoints =
    network === 'monetag'
      ? Math.round((event.estimated_price || 0) * settings.points_per_usd * (settings.monetag_task_reward_percent / 100))
      : Math.round(settings.adsgram_task_reward_points);

  const tx = await client.transaction('write');
  try {
    await tx.execute({
      sql: `INSERT INTO daily_ad_watch_state (telegram_id, network, watch_date, watch_count)
            VALUES (?, ?, ?, 1)
            ON CONFLICT(telegram_id, network, watch_date) DO UPDATE SET watch_count = watch_count + 1`,
      args: [telegramId, network, todayUTC()],
    });
    if (earnedPoints > 0) {
      await tx.execute({
        sql: 'UPDATE users SET main_balance = main_balance + ? WHERE telegram_id = ?',
        args: [earnedPoints, telegramId],
      });
    }
    await tx.execute({
      sql: 'INSERT INTO ledger (telegram_id, type, points_delta, meta) VALUES (?, ?, ?, ?)',
      args: [
        telegramId,
        'daily_watch_ad',
        earnedPoints,
        JSON.stringify({ network, estimated_price: event.estimated_price || 0 }),
      ],
    });
    const updatedRes = await tx.execute({
      sql: 'SELECT main_balance FROM users WHERE telegram_id = ?',
      args: [telegramId],
    });
    await tx.commit();
    return { earned_points: earnedPoints, main_balance: updatedRes.rows[0].main_balance, network };
  } catch (err) {
    await tx.rollback().catch(() => {});
    throw err;
  }
}

module.exports = { getStatus, prepareWatch, claimWatch };
