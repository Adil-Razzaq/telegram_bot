const { client } = require('../db/db');
const { getAllSettings } = require('../utils/settings');
const { startAdEvent, consumeAdEvent } = require('../utils/monetagAds');

/**
 * Adsgram's "Task" format block (Tasks tab) — fundamentally different
 * from every other ad flow in this app: it's a passive web component
 * (<adsgram-task>, see components/AdsgramTaskBanner.jsx) that Adsgram
 * rotates and displays on ITS OWN schedule, firing a `reward` event
 * whenever it decides a view counted — not something the user clicks to
 * start, and not something we control the timing of.
 *
 * To fit this into the same nonce/postback confirmation pattern as
 * everything else (never trust the client, always wait for the
 * network's own server confirmation), the frontend keeps ONE pending
 * nonce "armed" at all times whenever the daily limit isn't reached:
 * prepare a nonce as soon as the component mounts (or the previous one
 * gets used up), and when the `reward` event fires, immediately try to
 * claim that armed nonce. See AdsgramTaskBanner.jsx for the client side
 * of this.
 *
 * NOT gated by action_ads_enabled — same reasoning as adWatchService.js:
 * a "watch this ad" reward with no ad doesn't make sense, so the
 * frontend hides the banner entirely when ads are globally off, rather
 * than the backend silently skipping the ad requirement.
 *
 * Reward is a FIXED point amount (adsgram_task_banner_reward_points) —
 * Adsgram's Reward Url carries no ad-value for this format either, same
 * limitation as the Adsgram watch-ad task slot.
 */

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

async function getWatchCount(telegramId) {
  const res = await client.execute({
    sql: `SELECT watch_count FROM daily_task_banner_state WHERE telegram_id = ? AND watch_date = ?`,
    args: [telegramId, todayUTC()],
  });
  return res.rows[0]?.watch_count || 0;
}

async function getStatus({ telegramId }) {
  const [settings, watchedToday] = await Promise.all([getAllSettings(), getWatchCount(telegramId)]);
  return {
    block_id: settings.adsgram_task_banner_block_id,
    reward_points: settings.adsgram_task_banner_reward_points,
    watched_today: watchedToday,
    daily_limit: settings.adsgram_task_banner_daily_limit,
    can_watch: watchedToday < settings.adsgram_task_banner_daily_limit,
  };
}

async function prepareReward({ telegramId }) {
  const status = await getStatus({ telegramId });
  if (!status.can_watch) {
    const err = new Error(`Daily limit reached for this ad (${status.daily_limit}/day) — come back tomorrow`);
    err.statusCode = 400;
    throw err;
  }
  return startAdEvent({ telegramId, action: 'adsgram_task_banner' });
}

async function claimReward({ telegramId, nonce }) {
  await consumeAdEvent({ nonce, telegramId, action: 'adsgram_task_banner' });
  const settings = await getAllSettings();
  const rewardPoints = settings.adsgram_task_banner_reward_points;
  const today = todayUTC();

  const tx = await client.transaction('write');
  try {
    // Re-checked here too, not just in prepareReward — the widget fires
    // `reward` on its own schedule, so a claim could theoretically land
    // just after the daily limit was already hit by a near-simultaneous
    // one.
    const countRes = await tx.execute({
      sql: `SELECT watch_count FROM daily_task_banner_state WHERE telegram_id = ? AND watch_date = ?`,
      args: [telegramId, today],
    });
    const watchedToday = countRes.rows[0]?.watch_count || 0;
    if (watchedToday >= settings.adsgram_task_banner_daily_limit) {
      const err = new Error(`Daily limit reached for this ad (${settings.adsgram_task_banner_daily_limit}/day) — come back tomorrow`);
      err.statusCode = 400;
      throw err;
    }

    await tx.execute({
      sql: `INSERT INTO daily_task_banner_state (telegram_id, watch_date, watch_count)
            VALUES (?, ?, 1)
            ON CONFLICT(telegram_id, watch_date) DO UPDATE SET watch_count = watch_count + 1`,
      args: [telegramId, today],
    });
    await tx.execute({
      sql: 'UPDATE users SET main_balance = main_balance + ? WHERE telegram_id = ?',
      args: [rewardPoints, telegramId],
    });
    await tx.execute({
      sql: 'INSERT INTO ledger (telegram_id, type, points_delta, meta) VALUES (?, ?, ?, ?)',
      args: [telegramId, 'adsgram_task_banner', rewardPoints, JSON.stringify({})],
    });

    const updatedRes = await tx.execute({
      sql: 'SELECT main_balance FROM users WHERE telegram_id = ?',
      args: [telegramId],
    });
    await tx.commit();
    return { earned_points: rewardPoints, main_balance: updatedRes.rows[0].main_balance };
  } catch (err) {
    await tx.rollback().catch(() => {});
    throw err;
  }
}

module.exports = { getStatus, prepareReward, claimReward };
