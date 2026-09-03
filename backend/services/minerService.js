const { client, rolloverMinerCyclesIfNeeded } = require('../db/db');
const { startAdEventIfRequired, consumeAdEventIfRequired } = require('../utils/monetagAds');
const { getAllSettings } = require('../utils/settings');

/**
 * Manual, ad-gated, cycle-based miner:
 *
 *   - Nothing accrues until the user taps Start (watches an ad first).
 *   - Once started, points accrue continuously in real time toward that
 *     cycle's target (see pointsForCycleIndex) over `miner_cycle_hours`.
 *   - Claim is available AT ANY TIME while running — not just once the
 *     cycle finishes — and pays out whatever's accrued so far
 *     (prorated by elapsed time, capped at the full cycle amount if
 *     claimed after it's actually finished). Claiming also requires
 *     watching an ad, and ends that cycle (status -> idle) whether it
 *     was claimed early or after completion — the user then has to tap
 *     Start (+ ad) again for the next cycle.
 *   - Once the cycle's timer reaches zero, accrual is capped (always
 *     was) AND getStatus reports cycle_complete: true so the frontend
 *     can stop showing it as "running" and clearly prompt to Claim
 *     instead of leaving it looking like mining is still in progress.
 *     Nothing forces an auto-claim — that still costs an ad, same as
 *     any other claim — this is a display-state fix, not a payout one.
 *   - Ad-gated Boost: once per cycle, watching an extra ad multiplies
 *     this cycle's TOTAL reward target by miner_boost_multiplier
 *     (default 3x) — e.g. a cycle worth 100 becomes worth 300. The
 *     cycle's start/end timestamps don't change, so that 300 still
 *     accrues gradually across the same remaining cycle time (see
 *     effectiveCyclePoints/accruedNow) — boosting just raises the
 *     ceiling, it doesn't shorten the clock. If boosted mid-cycle, the
 *     portion already elapsed is recomputed against the new, higher
 *     target too (accruedNow always derives from elapsed/total against
 *     whatever the current effective target is — there's no separate
 *     "boosted portion" to track).
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
    sql: `SELECT status, cycle_started_at, cycle_ends_at, cycles_completed_today, cycles_reset_date, boost_active
          FROM miner_state WHERE telegram_id = ?`,
    args: [telegramId],
  });
  return res.rows[0];
}

// Whatever this cycle would be worth in total once it finishes, BEFORE
// any boost. Used as the baseline for display (e.g. "next_cycle_points"
// on the not-yet-started upcoming cycle, which can never be boosted).
function currentCyclePoints(row, settings) {
  return pointsForCycleIndex(row.cycles_completed_today, settings.miner_daily_points, settings.miner_cycles_per_day);
}

// The REAL target for the running cycle right now — base points, times
// miner_boost_multiplier if boost has been activated for this cycle.
// This is what accrual, the live rate, and the final claim payout all
// actually use; currentCyclePoints() above is only the pre-boost figure.
function effectiveCyclePoints(row, settings) {
  const base = currentCyclePoints(row, settings);
  return row.boost_active ? base * settings.miner_boost_multiplier : base;
}

// totalSeconds comes from the ROW's own stored start/end timestamps —
// unaffected by boost now, since boost raises the point target rather
// than shrinking the time window.
function cycleTotalSeconds(row) {
  const startedAt = new Date(row.cycle_started_at + 'Z').getTime();
  const endsAt = new Date(row.cycle_ends_at + 'Z').getTime();
  return Math.max(1, (endsAt - startedAt) / 1000);
}

// Prorated accrual RIGHT NOW for a running cycle — floored, so a claim
// can never pay out more than has genuinely elapsed. Capped at the full
// (boosted, if active) cycle amount once elapsed time reaches the cycle
// length.
function accruedNow(row, settings) {
  if (row.status !== 'running') return 0;
  const totalSeconds = cycleTotalSeconds(row);
  const startedAt = new Date(row.cycle_started_at + 'Z').getTime();
  const elapsedSeconds = Math.max(0, Math.min(totalSeconds, (Date.now() - startedAt) / 1000));
  const cyclePoints = effectiveCyclePoints(row, settings);
  return Math.floor(cyclePoints * (elapsedSeconds / totalSeconds));
}

async function getStatus({ telegramId }) {
  const [row, settings] = await Promise.all([getRow(telegramId), getAllSettings()]);
  const { miner_daily_points, miner_cycles_per_day, miner_boost_multiplier } = settings;

  const cyclesRemaining = Math.max(0, miner_cycles_per_day - row.cycles_completed_today);
  // Base (pre-boost) points — only meaningful for the not-yet-started
  // next cycle. For the currently running cycle, effectiveCyclePoints
  // below is the real, possibly-boosted target.
  const baseCyclePoints = currentCyclePoints(row, settings);
  const cyclePoints = effectiveCyclePoints(row, settings);
  const totalSeconds = row.status === 'running' ? cycleTotalSeconds(row) : 0;

  let secondsRemainingInCycle = 0;
  if (row.status === 'running') {
    const endsAt = new Date(row.cycle_ends_at + 'Z').getTime();
    secondsRemainingInCycle = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
  }

  return {
    status: row.status,
    cycle_started_at: row.cycle_started_at,
    cycle_ends_at: row.cycle_ends_at,
    seconds_remaining_in_cycle: secondsRemainingInCycle,
    // True once a running cycle's timer has hit zero but the user
    // hasn't claimed yet — frontend uses this to stop showing the
    // "mining in progress" state and prompt Claim instead.
    cycle_complete: row.status === 'running' && secondsRemainingInCycle <= 0,
    cycles_completed_today: row.cycles_completed_today,
    cycles_remaining_today: cyclesRemaining,
    cycles_per_day: miner_cycles_per_day,
    cycle_hours: settings.miner_cycle_hours,
    // Current cycle's full target, and the rate/second toward it — lets
    // the frontend animate a live-ticking number between polls, without
    // hitting the server every second just to move a counter. Rate
    // reflects any active boost automatically since totalSeconds does.
    current_cycle_points: row.status === 'running' ? cyclePoints : 0,
    rate_per_second: row.status === 'running' ? cyclePoints / totalSeconds : 0,
    accrued_now: accruedNow(row, settings),
    // The upcoming, not-yet-started cycle is never boosted (boost is
    // per-cycle and only activates once running), so this always shows
    // the base figure — never the currently-running cycle's boosted one.
    next_cycle_points: cyclesRemaining > 0 ? baseCyclePoints : 0,
    can_start: row.status === 'idle' && cyclesRemaining > 0,
    daily_points: miner_daily_points,
    boost_active: !!row.boost_active,
    boost_multiplier: miner_boost_multiplier,
    // Boost only makes sense while genuinely still counting down — once
    // the cycle is complete there's nothing left to speed up.
    can_boost: row.status === 'running' && !row.boost_active && secondsRemainingInCycle > 0,
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
  return startAdEventIfRequired({ telegramId, action: 'miner_start' });
}

async function startCycle({ telegramId, nonce }) {
  await consumeAdEventIfRequired({ nonce, telegramId, action: 'miner_start' });

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
              cycle_ends_at = datetime('now', '+' || ? || ' hours'), boost_active = 0
          WHERE telegram_id = ?`,
    args: [settings.miner_cycle_hours, telegramId],
  });

  return getStatus({ telegramId });
}

// Step 1 of claiming: get an ad nonce. Mirrors prepareStart exactly —
// claim now costs an ad view too, same as starting does.
async function prepareClaim({ telegramId }) {
  const row = await getRow(telegramId);
  if (row.status !== 'running') {
    const err = new Error('Miner is not running — tap Start first');
    err.statusCode = 400;
    throw err;
  }
  return startAdEventIfRequired({ telegramId, action: 'miner_claim' });
}

async function claim({ telegramId, nonce }) {
  await consumeAdEventIfRequired({ nonce, telegramId, action: 'miner_claim' });

  const settings = await getAllSettings();
  const tx = await client.transaction('write');
  try {
    await tx.execute({
      sql: 'INSERT OR IGNORE INTO miner_state (telegram_id) VALUES (?)',
      args: [telegramId],
    });
    const rowRes = await tx.execute({
      sql: `SELECT status, cycle_started_at, cycle_ends_at, cycles_completed_today, boost_active FROM miner_state WHERE telegram_id = ?`,
      args: [telegramId],
    });
    const row = rowRes.rows[0];

    if (row.status !== 'running') {
      const err = new Error('Miner is not running — tap Start first');
      err.statusCode = 400;
      throw err;
    }

    // Recomputed at claim time, inside the transaction — not trusted
    // from anything the client sent, so there's no way to claim more
    // than has genuinely elapsed, and boost_active (fetched fresh in
    // this same query) is what makes a boosted claim actually pay out
    // the higher, tripled target rather than the base one.
    const earnedPoints = accruedNow(row, settings);

    await tx.execute({
      sql: 'UPDATE users SET main_balance = main_balance + ? WHERE telegram_id = ?',
      args: [earnedPoints, telegramId],
    });
    await tx.execute({
      sql: `UPDATE miner_state
            SET status = 'idle', cycle_started_at = NULL, cycle_ends_at = NULL,
                cycles_completed_today = cycles_completed_today + 1, boost_active = 0
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

// --- Boost: watch an ad to multiply the current cycle's TOTAL reward
// target by miner_boost_multiplier (e.g. 100 -> 300 at 3x). The cycle's
// timing is untouched — see effectiveCyclePoints/accruedNow above for
// how the higher target then accrues across the same remaining time.

async function prepareBoost({ telegramId }) {
  const row = await getRow(telegramId);
  if (row.status !== 'running') {
    const err = new Error('Miner is not running — tap Start first');
    err.statusCode = 400;
    throw err;
  }
  if (row.boost_active) {
    const err = new Error('Boost is already active for this cycle');
    err.statusCode = 400;
    throw err;
  }
  const endsAt = new Date(row.cycle_ends_at + 'Z').getTime();
  if (endsAt <= Date.now()) {
    const err = new Error('This cycle has already finished — claim it to start a new one');
    err.statusCode = 400;
    throw err;
  }
  return startAdEventIfRequired({ telegramId, action: 'miner_boost' });
}

async function activateBoost({ telegramId, nonce }) {
  await consumeAdEventIfRequired({ nonce, telegramId, action: 'miner_boost' });

  const tx = await client.transaction('write');
  try {
    const rowRes = await tx.execute({
      sql: `SELECT status, cycle_ends_at, boost_active FROM miner_state WHERE telegram_id = ?`,
      args: [telegramId],
    });
    const row = rowRes.rows[0];

    if (row.status !== 'running') {
      const err = new Error('Miner is not running — tap Start first');
      err.statusCode = 400;
      throw err;
    }
    if (row.boost_active) {
      const err = new Error('Boost is already active for this cycle');
      err.statusCode = 400;
      throw err;
    }

    const endsAt = new Date(row.cycle_ends_at + 'Z').getTime();
    if (endsAt <= Date.now()) {
      const err = new Error('This cycle has already finished — claim it to start a new one');
      err.statusCode = 400;
      throw err;
    }

    // Just flip the flag — effectiveCyclePoints() picks this up
    // everywhere (accrual, live rate, claim payout) automatically. No
    // timestamp math needed since timing is untouched.
    await tx.execute({
      sql: `UPDATE miner_state SET boost_active = 1 WHERE telegram_id = ?`,
      args: [telegramId],
    });
    await tx.commit();
  } catch (err) {
    await tx.rollback().catch(() => {});
    throw err;
  }

  return getStatus({ telegramId });
}

module.exports = { getStatus, prepareStart, startCycle, prepareClaim, claim, prepareBoost, activateBoost };
