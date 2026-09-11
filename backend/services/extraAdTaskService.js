const { client } = require('../db/db');
const { getAllSettings } = require('../utils/settings');
const { startAdEvent, consumeAdEvent } = require('../utils/monetagAds');

/**
 * Two more fixed, ALWAYS-Adsgram task-tab slots ('extra1' and 'extra2'),
 * each with its own dedicated Block ID, fixed point reward, and daily
 * limit — fully independent of adsgram_block_id (used by spin/miner/
 * referral) and of the daily_watch/task-banner slots. See settings.js
 * for the adsgram_extra_task1 and adsgram_extra_task2 settings below.
 *
 * A slot with no Block ID set is simply hidden in the Tasks tab (see
 * components/Tasks.jsx) rather than erroring — same convention as the
 * Adsgram card in the existing Watch & Earn section.
 *
 * NOT gated by action_ads_enabled or any of the per-button toggles
 * added elsewhere — same reasoning as adWatchService.js/
 * taskBannerService.js: a task whose entire point is watching an ad
 * doesn't have a meaningful "ad optional" mode. Turning a slot off is
 * done by clearing its Block ID instead.
 */

const SLOTS = ['extra1', 'extra2'];

function assertValidSlot(slot) {
  if (!SLOTS.includes(slot)) {
    const err = new Error(`Invalid slot '${slot}' — must be one of: ${SLOTS.join(', ')}`);
    err.statusCode = 400;
    throw err;
  }
}

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

async function getWatchCounts(telegramId) {
  const res = await client.execute({
    sql: `SELECT slot, watch_count FROM daily_extra_ad_task_state
          WHERE telegram_id = ? AND watch_date = ?`,
    args: [telegramId, todayUTC()],
  });
  const counts = { extra1: 0, extra2: 0 };
  for (const row of res.rows) counts[row.slot] = row.watch_count;
  return counts;
}

async function getStatus({ telegramId }) {
  const [settings, counts] = await Promise.all([getAllSettings(), getWatchCounts(telegramId)]);
  const buildSlot = (slot, n) => ({
    enabled: Boolean(settings[`adsgram_extra_task${n}_block_id`]),
    block_id: settings[`adsgram_extra_task${n}_block_id`],
    watched_today: counts[slot],
    daily_limit: settings[`adsgram_extra_task${n}_daily_limit`],
    can_watch: counts[slot] < settings[`adsgram_extra_task${n}_daily_limit`],
    reward_points: settings[`adsgram_extra_task${n}_reward_points`],
  });
  return {
    extra1: buildSlot('extra1', 1),
    extra2: buildSlot('extra2', 2),
  };
}

async function prepareWatch({ telegramId, slot }) {
  assertValidSlot(slot);
  const status = await getStatus({ telegramId });
  if (!status[slot].enabled) {
    const err = new Error('This task is not available right now');
    err.statusCode = 400;
    throw err;
  }
  if (!status[slot].can_watch) {
    const err = new Error(`You've hit today's limit for this task (${status[slot].daily_limit}/day) — come back tomorrow`);
    err.statusCode = 400;
    throw err;
  }
  return startAdEvent({ telegramId, action: `extra_task:${slot}` });
}

async function claimWatch({ telegramId, slot, nonce }) {
  assertValidSlot(slot);

  // Consumed BEFORE opening the write transaction below — same
  // reasoning and placement as every other ad-gated action here (see
  // minerService.js's claim() for why this ordering matters: doing
  // this INSIDE an already-open transaction self-deadlocks on a
  // single-writer database).
  const event = await consumeAdEvent({ nonce, telegramId, action: `extra_task:${slot}` });
  void event; // fixed reward regardless of network specifics — Adsgram never reports ad value

  const settings = await getAllSettings();
  const n = slot === 'extra1' ? 1 : 2;
  const earnedPoints = Math.round(settings[`adsgram_extra_task${n}_reward_points`]);

  const tx = await client.transaction('write');
  try {
    await tx.execute({
      sql: `INSERT INTO daily_extra_ad_task_state (telegram_id, slot, watch_date, watch_count)
            VALUES (?, ?, ?, 1)
            ON CONFLICT(telegram_id, slot, watch_date) DO UPDATE SET watch_count = watch_count + 1`,
      args: [telegramId, slot, todayUTC()],
    });
    if (earnedPoints > 0) {
      await tx.execute({
        sql: 'UPDATE users SET main_balance = main_balance + ? WHERE telegram_id = ?',
        args: [earnedPoints, telegramId],
      });
    }
    await tx.execute({
      sql: 'INSERT INTO ledger (telegram_id, type, points_delta, meta) VALUES (?, ?, ?, ?)',
      args: [telegramId, 'extra_ad_task', earnedPoints, JSON.stringify({ slot })],
    });
    const updatedRes = await tx.execute({
      sql: 'SELECT main_balance FROM users WHERE telegram_id = ?',
      args: [telegramId],
    });
    await tx.commit();
    return { earned_points: earnedPoints, main_balance: updatedRes.rows[0].main_balance, slot };
  } catch (err) {
    await tx.rollback().catch(() => {});
    throw err;
  }
}

module.exports = { getStatus, prepareWatch, claimWatch };
