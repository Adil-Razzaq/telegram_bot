const { client, rolloverMinerCyclesIfNeeded } = require('../db/db');
const { startAdEvent, consumeAdEvent } = require('../utils/monetagAds');
const { getAllSettings } = require('../utils/settings');

/**
 * Redesigned from a passive always-accruing miner into a manual,
 * ad-gated, cycle-based one:
 *
 *   - Nothing accrues until the user taps Start.
 *   - Start requires a confirmed Monetag ad view first (Rewarded Popup —
 *     see frontend/src/monetag.js).
 *   - Once started, a cycle runs for exactly `miner_cycle_hours` and then
 *     stops. It does NOT auto-restart — the user has to come back and
 *     tap Start again (watching another ad) for the next cycle. If
 *     they're late, nothing bad happens and nothing is compensated —
 *     that time the miner just wasn't running.
 *   - Capped at `miner_cycles_per_day` starts per calendar day.
 *   - `miner_daily_points` is split across the day's cycles with a
 *     remainder-safe distribution so the total always adds up to
 *     exactly miner_daily_points regardless of cycle count.
 */

async function ensureMinerRow(telegramId) {
  await client.execute({
    sql: 'INSERT OR IGNORE INTO miner_state (telegram_id) VALUES (?)',
    args: [telegramId],
  });
}

function pointsForCycleIndex(index, total, count) {
  const upTo = (n) => Math.round((total * n) / count);
  return upTo(index + 1) - upTo(index);
}

async function getRow(telegramId) {
  await ensureMinerRow(telegramId);
  await rolloverMinerCyclesIfNeeded(telegramId);
  const res = await client.execute({
    sql: `SELECT status, cycle_started_at, cycle_ends_at, cycles_completed_today, cycles_reset_date
          FROM miner_state WHERE telegram_id = ?`,
    args: [telegramId],
  });
  return res.rows[0];
}

async function getStatus({ telegramId }) {
  const [row, settings] = await Promise.all([getRow(telegramId), getAllSettings()]);
  const { miner_daily_points, miner_cycles_per_day, miner_cycle_hours } = settings;

  const cyclesRemaining = Math.max(0, miner_cycles_per_day - row.cycles_completed_today);
  const nextCyclePoints =
    row.cycles_completed_today < miner_cycles_per_day
      ? pointsForCycleIndex(row.cycles_completed_today, miner_daily_points, miner_cycles_per_day)
      : 0;

  let secondsRemainingInCycle = 0;
  let cycleFinishedUnclaimed = false;
  if (row.status === 'running') {
    const endsAt = new Date(row.cycle_ends_at + 'Z').getTime();
    const remainingMs = endsAt - Date.now();
    if (remainingMs > 0) {
      secondsRemainingInCycle = Math.ceil(remainingMs / 1000);
    } else {
      cycleFinishedUnclaimed = true;
    }
  }

  return {
    status: row.status,
    cycle_ends_at: row.cycle_ends_at,
    seconds_remaining_in_cycle: secondsRemainingInCycle,
    cycle_finished_unclaimed: cycleFinishedUnclaimed,
    cycles_completed_today: row.cycles_completed_today,
    cycles_remaining_today: cyclesRemaining,
    cycles_per_day: miner_cycles_per_day,
    cycle_hours: miner_cycle_hours,
    next_cycle_points: nextCyclePoints,
    can_start: row.status === 'idle' && cyclesRemaining > 0,
    daily_points: miner_daily_points,
  };
}

async function prepareStart({ telegramId }) {
  const row = await getRow(telegramId);
  const settings = await getAllSettings();
  if (row.status !== 'idle') {
    const err = new Error('Miner is already running');
    err.statusCode = 400;
    throw err;
  }
  if (row.cycles_completed_today >= settings.miner_cycles_per_day) {
    const err = new Error("You've used all of today's mining cycles — come back tomorrow");
    err.statusCode = 400;
    throw err;
  }
  return startAdEvent({ telegramId, action: 'miner_start' });
}

async function startCycle({ telegramId, nonce }) {
  await consumeAdEvent({ nonce, telegramId, action: 'miner_start' });

  const row = await getRow(telegramId);
  const settings = await getAllSettings();
  if (row.status !== 'idle') {
    const err = new Error('Miner is already running');
    err.statusCode = 400;
    throw err;
  }
  if (row.cycles_completed_today >= settings.miner_cycles_per_day) {
    const err = new Error("You've used all of today's mining cycles — come back tomorrow");
    err.statusCode = 400;
    throw err;
  }

  await client.execute({
    sql: `UPDATE miner_state
          SET status = 'running', cycle_started_at = CURRENT_TIMESTAMP,
              cycle_ends_at = datetime('now', '+' || ? || ' hours')
          WHERE telegram_id = ?`,
    args: [settings.miner_cycle_hours, telegramId],
  });

  return getStatus({ telegramId });
}

async function claim({ telegramId }) {
  const settings = await getAllSettings();
  const tx = await client.transaction('write');
  try {
    await tx.execute({
      sql: 'INSERT OR IGNORE INTO miner_state (telegram_id) VALUES (?)',
      args: [telegramId],
    });
    const rowRes = await tx.execute({
      sql: `SELECT status, cycle_ends_at, cycles_completed_today FROM miner_state WHERE telegram_id = ?`,
      args: [telegramId],
    });
    const row = rowRes.rows[0];

    if (row.status !== 'running') {
      const err = new Error('Miner is not running — tap Start first');
      err.statusCode = 400;
      throw err;
    }
    const endsAt = new Date(row.cycle_ends_at + 'Z').getTime();
    if (Date.now() < endsAt) {
      const err = new Error('This cycle is still running — check back when the timer finishes');
      err.statusCode = 400;
      throw err;
    }

    const earnedPoints = pointsForCycleIndex(
      row.cycles_completed_today,
      settings.miner_daily_points,
      settings.miner_cycles_per_day
    );

    await tx.execute({
      sql: 'UPDATE users SET main_balance = main_balance + ? WHERE telegram_id = ?',
      args: [earnedPoints, telegramId],
    });
    await tx.execute({
      sql: `UPDATE miner_state
            SET status = 'idle', cycle_started_at = NULL, cycle_ends_at = NULL,
                cycles_completed_today = cycles_completed_today + 1
            WHERE telegram_id = ?`,
      args: [telegramId],
    });
    await tx.execute({
      sql: 'INSERT INTO ledger (telegram_id, type, points_delta, meta) VALUES (?, ?, ?, ?)',
      args: [telegramId, 'miner_claim', earnedPoints, JSON.stringify({ cycleIndex: row.cycles_completed_today })],
    });

    const updatedUserRes = await tx.execute({
      sql: 'SELECT main_balance FROM users WHERE telegram_id = ?',
      args: [telegramId],
    });
    await tx.commit();

    return { earned_points: earnedPoints, main_balance: updatedUserRes.rows[0].main_balance };
  } catch (err) {
    await tx.rollback().catch(() => {});
    throw err;
  }
}

module.exports = { getStatus, prepareStart, startCycle, claim };
