const { client, rolloverMinerCyclesIfNeeded } = require('../db/db');
const { startAdEventIfRequired, consumeAdEventIfRequired } = require('../utils/monetagAds');
const { getAllSettings } = require('../utils/settings');
const { maybeQualifyReferral } = require('./referralService');

/**
 * Manual, ad-gated, cycle-based miner:
 *
 *   - Nothing accrues until the user taps Start (watches an ad first).
 *   - Once started, points accrue continuously in real time toward that
 *     cycle's target (see pointsForCycleIndex) over `miner_cycle_hours`.
 *     Cycle length itself never changes — boost (below) does NOT extend
 *     or shrink it.
 *   - Claim only unlocks once the cycle's FULL duration has actually
 *     elapsed (cycle_complete) — see isCycleComplete, checked in both
 *     prepareClaim and claim itself. Claiming still requires watching
 *     an ad, and always ends that cycle (status -> idle) — the user
 *     then has to tap Start (+ ad) again for the next one.
 *   - getStatus reports cycle_complete: true once the timer hits zero,
 *     so the frontend can stop showing it as "running" and show a
 *     separate, distinct Claim button instead of leaving it looking
 *     like mining is still in progress.
 *
 *   - Ad-gated Boost — TEMPORARY, RENEWABLE window (not a once-per-cycle
 *     permanent multiplier): watching an ad raises the accrual RATE by
 *     miner_boost_multiplier (default 3x) for the next
 *     miner_boost_duration_minutes (default 60) only. Once that window
 *     expires, the rate drops back to normal and the button becomes
 *     available again — watching another ad "renews" it for another
 *     window. A user could in principle re-boost every hour for the
 *     whole cycle, but each renewal costs its own ad view.
 *
 *     Implementation: boost_expires_at (when the CURRENT window ends)
 *     plus boost_bonus_banked (extra points already earned from PAST,
 *     now-expired windows this cycle, accumulated each time a new
 *     window starts — see activateBoost). accruedNow always = normal
 *     1x trajectory + banked bonus + whatever bonus the CURRENTLY
 *     active window has earned so far. This lets multiple
 *     non-contiguous boost windows across one cycle stack correctly
 *     without needing to store a list of them.
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
    sql: `SELECT status, cycle_started_at, cycle_ends_at, cycles_completed_today, cycles_reset_date,
                 boost_expires_at, boost_bonus_banked
          FROM miner_state WHERE telegram_id = ?`,
    args: [telegramId],
  });
  return res.rows[0];
}

// The base (unboosted) target for this cycle — boost no longer touches
// this at all; it only affects the RATE via boostBonusPoints below.
function currentCyclePoints(row, settings) {
  return pointsForCycleIndex(row.cycles_completed_today, settings.miner_daily_points, settings.miner_cycles_per_day);
}

function cycleTotalSeconds(row) {
  const startedAt = new Date(row.cycle_started_at + 'Z').getTime();
  const endsAt = new Date(row.cycle_ends_at + 'Z').getTime();
  return Math.max(1, (endsAt - startedAt) / 1000);
}

function isBoostCurrentlyActive(row) {
  if (!row.boost_expires_at) return false;
  return Date.now() < new Date(row.boost_expires_at + 'Z').getTime();
}

// Bonus points from boosting — banked (past, fully-expired windows this
// cycle) plus however much the CURRENTLY active window (if any) has
// earned so far. A window's contribution is capped at the cycle's own
// end time, so a boost activated near the very end of a cycle can't
// earn bonus past when the cycle itself finishes.
function boostBonusPoints(row, settings) {
  const banked = row.boost_bonus_banked || 0;
  if (!row.boost_expires_at) return { banked, active: 0, total: banked };

  const cyclePoints = currentCyclePoints(row, settings);
  const totalSeconds = cycleTotalSeconds(row);
  const baseRatePerSecond = cyclePoints / totalSeconds;
  const extraRatePerSecond = baseRatePerSecond * (settings.miner_boost_multiplier - 1);

  const durationSeconds = settings.miner_boost_duration_minutes * 60;
  const expiresAtMs = new Date(row.boost_expires_at + 'Z').getTime();
  const startedAtMs = expiresAtMs - durationSeconds * 1000;
  const cycleEndsAtMs = new Date(row.cycle_ends_at + 'Z').getTime();
  const windowEndMs = Math.min(expiresAtMs, cycleEndsAtMs, Date.now());

  const boostedSeconds = Math.max(0, (windowEndMs - startedAtMs) / 1000);
  const active = extraRatePerSecond * boostedSeconds;
  return { banked, active, total: banked + active };
}

// Prorated accrual RIGHT NOW for a running cycle — unfloored. Normal 1x
// trajectory plus whatever boost bonus (banked + active window) has
// accumulated. This is the source of truth both for the floored payout
// amount (accruedNow, below) and for the frontend's live-ticking
// display (accrued_now_precise in getStatus) — the display needs the
// unfloored value so a boosted counter can climb smoothly instead of
// being capped at the unboosted cycle target.
function accruedNowPrecise(row, settings) {
  if (row.status !== 'running') return 0;
  const totalSeconds = cycleTotalSeconds(row);
  const startedAt = new Date(row.cycle_started_at + 'Z').getTime();
  const elapsedSeconds = Math.max(0, Math.min(totalSeconds, (Date.now() - startedAt) / 1000));
  const cyclePoints = currentCyclePoints(row, settings);
  const baseAccrued = cyclePoints * (elapsedSeconds / totalSeconds);
  const { total: bonus } = boostBonusPoints(row, settings);
  return baseAccrued + bonus;
}

// Floored version — used for actual payout, so a claim can never pay
// out more than has genuinely elapsed.
function accruedNow(row, settings) {
  return Math.floor(accruedNowPrecise(row, settings));
}

async function getStatus({ telegramId }) {
  const [row, settings] = await Promise.all([getRow(telegramId), getAllSettings()]);
  const { miner_daily_points, miner_cycles_per_day, miner_boost_multiplier, miner_boost_duration_minutes } = settings;

  const cyclesRemaining = Math.max(0, miner_cycles_per_day - row.cycles_completed_today);
  const cyclePoints = currentCyclePoints(row, settings);
  const totalSeconds = row.status === 'running' ? cycleTotalSeconds(row) : 0;
  const boostActive = row.status === 'running' && isBoostCurrentlyActive(row);

  let secondsRemainingInCycle = 0;
  if (row.status === 'running') {
    const endsAt = new Date(row.cycle_ends_at + 'Z').getTime();
    secondsRemainingInCycle = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
  }

  let boostSecondsRemaining = 0;
  if (boostActive) {
    boostSecondsRemaining = Math.max(0, Math.ceil((new Date(row.boost_expires_at + 'Z').getTime() - Date.now()) / 1000));
  }

  // Effective rate right now — 3x (or whatever the multiplier is)
  // while a boost window is active, plain rate otherwise. Lets the
  // frontend's live-ticking animation actually speed up visibly during
  // a boost, not just silently accrue more.
  const baseRate = row.status === 'running' ? cyclePoints / totalSeconds : 0;
  const effectiveRate = boostActive ? baseRate * miner_boost_multiplier : baseRate;

  return {
    status: row.status,
    cycle_started_at: row.cycle_started_at,
    cycle_ends_at: row.cycle_ends_at,
    seconds_remaining_in_cycle: secondsRemainingInCycle,
    cycle_complete: row.status === 'running' && secondsRemainingInCycle <= 0,
    cycles_completed_today: row.cycles_completed_today,
    cycles_remaining_today: cyclesRemaining,
    cycles_per_day: miner_cycles_per_day,
    cycle_hours: settings.miner_cycle_hours,
    current_cycle_points: row.status === 'running' ? cyclePoints : 0,
    rate_per_second: effectiveRate,
    accrued_now: accruedNow(row, settings),
    // Unfloored — lets the frontend's live counter climb smoothly and
    // reflect boosted earnings past the base cycle target instead of
    // being capped at it. Never used for payout (see accruedNow).
    accrued_now_precise: accruedNowPrecise(row, settings),
    next_cycle_points: cyclesRemaining > 0 ? cyclePoints : 0,
    can_start: row.status === 'idle' && cyclesRemaining > 0,
    daily_points: miner_daily_points,
    boost_active: boostActive,
    boost_seconds_remaining: boostSecondsRemaining,
    boost_multiplier: miner_boost_multiplier,
    boost_duration_minutes: miner_boost_duration_minutes,
    // Available whenever running and no window is currently active —
    // once a window expires, this flips back to true, letting the user
    // "renew" with another ad.
    can_boost: row.status === 'running' && !boostActive,
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
  // Starting a mining cycle has its OWN independent toggle
  // (miner_start_ads_enabled) — defaults to on, switchable in the admin
  // panel separately from every other button's ad requirement.
  return startAdEventIfRequired({ telegramId, action: 'miner_start', settingKey: 'miner_start_ads_enabled' });
}

async function startCycle({ telegramId, nonce }) {
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

  // See prepareStart's comment above — its own independent toggle.
  await consumeAdEventIfRequired({ nonce, telegramId, action: 'miner_start', settingKey: 'miner_start_ads_enabled' });

  await client.execute({
    sql: `UPDATE miner_state
          SET status = 'running', cycle_started_at = CURRENT_TIMESTAMP,
              cycle_ends_at = datetime('now', '+' || ? || ' hours'),
              boost_expires_at = NULL, boost_bonus_banked = 0
          WHERE telegram_id = ?`,
    args: [settings.miner_cycle_hours, telegramId],
  });

  return getStatus({ telegramId });
}

function isCycleComplete(row) {
  const endsAt = new Date(row.cycle_ends_at + 'Z').getTime();
  return Date.now() >= endsAt;
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
  if (!isCycleComplete(row)) {
    const err = new Error('This cycle is still running — claim unlocks once the timer hits zero');
    err.statusCode = 400;
    throw err;
  }
  // Claiming has its OWN independent toggle (miner_claim_ads_enabled)
  // too — same pattern as prepareStart above.
  return startAdEventIfRequired({ telegramId, action: 'miner_claim', settingKey: 'miner_claim_ads_enabled' });
}

async function claim({ telegramId, nonce }) {
  const settings = await getAllSettings();

  // Consumed BEFORE opening the write transaction below — same
  // reasoning and same placement as spinService.js's
  // consumeAdEventIfRequired call: if the claim later fails (e.g. the
  // cycle isn't actually complete yet), the ad view is "spent" either
  // way — acceptable tradeoff, not exploitable, costs the user, not us.
  //
  // IMPORTANT: this must NOT run inside the tx below. consumeAdEvent
  // does its own plain client.execute() UPDATE, which is a SEPARATE
  // write from the interactive `tx` transaction — issuing it WHILE
  // `tx` is open self-deadlocks on a single-writer database (`tx`
  // holds the write lock and won't release it until this resolves,
  // but this needs that same lock to run) and the request just hangs
  // until it times out. (This was a real bug here until this fix —
  // prepareStart/startCycle never had it because startCycle has no
  // wrapping transaction at all; activateBoost never had it because
  // its consumeAdEventIfRequired call is likewise placed before its
  // own tx opens.)
  await consumeAdEventIfRequired({ nonce, telegramId, action: 'miner_claim', settingKey: 'miner_claim_ads_enabled' });

  const tx = await client.transaction('write');
  try {
    await tx.execute({
      sql: 'INSERT OR IGNORE INTO miner_state (telegram_id) VALUES (?)',
      args: [telegramId],
    });
    const rowRes = await tx.execute({
      sql: `SELECT status, cycle_started_at, cycle_ends_at, cycles_completed_today,
                   boost_expires_at, boost_bonus_banked
            FROM miner_state WHERE telegram_id = ?`,
      args: [telegramId],
    });
    const row = rowRes.rows[0];

    if (row.status !== 'running') {
      const err = new Error('Miner is not running — tap Start first');
      err.statusCode = 400;
      throw err;
    }
    if (!isCycleComplete(row)) {
      const err = new Error('This cycle is still running — claim unlocks once the timer hits zero');
      err.statusCode = 400;
      throw err;
    }

    // Recomputed at claim time, inside the transaction — not trusted
    // from anything the client sent, so there's no way to claim more
    // than has genuinely elapsed or genuinely boosted.
    const earnedPoints = accruedNow(row, settings);

    await tx.execute({
      sql: 'UPDATE users SET main_balance = main_balance + ? WHERE telegram_id = ?',
      args: [earnedPoints, telegramId],
    });
    await tx.execute({
      sql: `UPDATE miner_state
            SET status = 'idle', cycle_started_at = NULL, cycle_ends_at = NULL,
                cycles_completed_today = cycles_completed_today + 1,
                boost_expires_at = NULL, boost_bonus_banked = 0
            WHERE telegram_id = ?`,
      args: [telegramId],
    });
    // Lifetime counter (never resets, unlike cycles_completed_today
    // above) — this is what referral-qualification gating checks
    // against settings.referral_qualify_miner_cycles below.
    await tx.execute({
      sql: 'UPDATE users SET total_miner_cycles_completed = total_miner_cycles_completed + 1 WHERE telegram_id = ?',
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

    // Anti-bot-farm referral gating (see referralService.js) — checks
    // whether THIS user was referred and, now that they've completed
    // another cycle, finally qualifies their referrer for the reward.
    // A no-op when gating is off (the default) or conditions aren't met
    // yet. Deliberately outside the transaction above and never allowed
    // to throw, so a bug or a slow Telegram API call here can never
    // block or fail the claim itself — the points are already paid out.
    maybeQualifyReferral(telegramId).catch((e) =>
      console.error('Referral qualification check failed after miner claim:', e.message)
    );

    return { earned_points: earnedPoints, main_balance: updatedUserRes.rows[0].main_balance };
  } catch (err) {
    await tx.rollback().catch(() => {});
    throw err;
  }
}

// --- Boost: watch an ad to raise the accrual RATE by
// miner_boost_multiplier for miner_boost_duration_minutes. Renewable —
// once the window expires, another ad starts a fresh one.

async function prepareBoost({ telegramId }) {
  const row = await getRow(telegramId);
  if (row.status !== 'running') {
    const err = new Error('Miner is not running — tap Start first');
    err.statusCode = 400;
    throw err;
  }
  if (isBoostCurrentlyActive(row)) {
    const err = new Error('Boost is still active — wait until it expires to renew');
    err.statusCode = 400;
    throw err;
  }
  return startAdEventIfRequired({ telegramId, action: 'miner_boost', settingKey: 'miner_boost_ads_enabled' });
}

async function activateBoost({ telegramId, nonce }) {
  await consumeAdEventIfRequired({ nonce, telegramId, action: 'miner_boost', settingKey: 'miner_boost_ads_enabled' });

  const settings = await getAllSettings();
  const tx = await client.transaction('write');
  try {
    const rowRes = await tx.execute({
      sql: `SELECT status, cycle_started_at, cycle_ends_at, cycles_completed_today,
                   boost_expires_at, boost_bonus_banked
            FROM miner_state WHERE telegram_id = ?`,
      args: [telegramId],
    });
    const row = rowRes.rows[0];

    if (row.status !== 'running') {
      const err = new Error('Miner is not running — tap Start first');
      err.statusCode = 400;
      throw err;
    }
    if (isBoostCurrentlyActive(row)) {
      const err = new Error('Boost is still active — wait until it expires to renew');
      err.statusCode = 400;
      throw err;
    }

    // Bank whatever the PREVIOUS window (now fully expired, if there
    // was one) earned, before starting the new one overwrites
    // boost_expires_at — otherwise that window's contribution would be
    // lost the moment we set a new expiry.
    const { active: previousWindowBonus } = boostBonusPoints(row, settings);
    const newBanked = (row.boost_bonus_banked || 0) + previousWindowBonus;

    const durationMs = settings.miner_boost_duration_minutes * 60 * 1000;
    // Match SQLite's own datetime() output format ('YYYY-MM-DD
    // HH:MM:SS', implicitly UTC) so this stays consistent with every
    // other timestamp column here.
    const newExpiresAt = new Date(Date.now() + durationMs).toISOString().slice(0, 19).replace('T', ' ');

    await tx.execute({
      sql: `UPDATE miner_state SET boost_expires_at = ?, boost_bonus_banked = ? WHERE telegram_id = ?`,
      args: [newExpiresAt, newBanked, telegramId],
    });
    await tx.commit();
  } catch (err) {
    await tx.rollback().catch(() => {});
    throw err;
  }

  return getStatus({ telegramId });
}

module.exports = { getStatus, prepareStart, startCycle, prepareClaim, claim, prepareBoost, activateBoost };
