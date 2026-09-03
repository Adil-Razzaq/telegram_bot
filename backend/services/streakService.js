const { client } = require('../db/db');
const { getAllSettings } = require('../utils/settings');
const { startAdEvent, consumeAdEvent } = require('../utils/monetagAds');

/**
 * 7-day streak: watch an ad once per calendar day (UTC) to claim that
 * day's reward and keep the streak alive. Same network-selectable
 * pattern as the daily watch-ad task slots in adWatchService.js — the
 * user picks Monetag or Adsgram per claim, action = `streak_watch:<network>`
 * so each network's postback (see routes/bot.js, already generic) can
 * confirm it independently.
 *
 * `consecutive_days` is NOT capped at 7 — it just keeps counting up for
 * as long as the streak stays unbroken, which is what makes
 * `best_streak` meaningful beyond a single week. The reward for any
 * given claim always comes from settings.streak_day_N_points where
 * N = ((consecutive_days - 1) % 7) + 1, so the 7-day reward calendar
 * simply repeats every week. Missing a UTC calendar day resets the
 * streak back to day 1 on the next claim — not gated by
 * action_ads_enabled, same reasoning as adWatchService: a "watch ad to
 * claim" feature has no meaningful off-state for the ad requirement.
 */

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

function yesterdayUTC() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

async function ensureRow(telegramId) {
  await client.execute({
    sql: 'INSERT OR IGNORE INTO streak_state (telegram_id) VALUES (?)',
    args: [telegramId],
  });
}

async function getRow(telegramId) {
  await ensureRow(telegramId);
  const res = await client.execute({
    sql: `SELECT consecutive_days, last_claim_date, best_streak, total_claims
          FROM streak_state WHERE telegram_id = ?`,
    args: [telegramId],
  });
  return res.rows[0];
}

function rewardsFromSettings(settings) {
  return [1, 2, 3, 4, 5, 6, 7].map((d) => settings[`streak_day_${d}_points`]);
}

// Given the row as it stands right now, what claiming TODAY would do —
// used by both getStatus (read-only preview) and claim (inside the
// transaction, on a freshly re-read row) so the logic can't drift.
function computeNextClaim(row) {
  const today = todayUTC();
  const yesterday = yesterdayUTC();

  if (row.last_claim_date === today) {
    return { alreadyClaimedToday: true };
  }
  const continuing = row.last_claim_date === yesterday;
  const nextConsecutive = continuing ? row.consecutive_days + 1 : 1;
  const position = ((nextConsecutive - 1) % 7) + 1;
  return { alreadyClaimedToday: false, continuing, nextConsecutive, position };
}

async function getStatus({ telegramId }) {
  const [row, settings] = await Promise.all([getRow(telegramId), getAllSettings()]);
  const rewards = rewardsFromSettings(settings);
  const next = computeNextClaim(row);
  const currentPosition = row.consecutive_days > 0 ? ((row.consecutive_days - 1) % 7) + 1 : 0;

  return {
    consecutive_days: row.consecutive_days,
    current_position: currentPosition, // 0 = no streak claimed yet, else 1-7
    best_streak: row.best_streak,
    total_claims: row.total_claims,
    last_claim_date: row.last_claim_date,
    claimed_today: next.alreadyClaimedToday,
    // Whether claiming today would CONTINUE the streak vs reset it to
    // day 1 (a gap of one or more missed UTC days) — lets the frontend
    // warn "you'll lose your streak" before the user commits to an ad.
    will_reset: !next.alreadyClaimedToday && row.last_claim_date && !next.continuing,
    next_position: next.alreadyClaimedToday ? null : next.position,
    next_reward: next.alreadyClaimedToday ? null : rewards[next.position - 1],
    rewards, // [day1Points, ..., day7Points], admin-editable via Settings
    can_claim: !next.alreadyClaimedToday,
  };
}

async function prepareClaim({ telegramId, network }) {
  const row = await getRow(telegramId);
  const next = computeNextClaim(row);
  if (next.alreadyClaimedToday) {
    const err = new Error("You've already claimed today's streak reward — come back tomorrow");
    err.statusCode = 400;
    throw err;
  }
  return startAdEvent({ telegramId, action: `streak_watch:${network}` });
}

async function claim({ telegramId, network, nonce }) {
  await consumeAdEvent({ nonce, telegramId, action: `streak_watch:${network}` });
  const settings = await getAllSettings();

  const tx = await client.transaction('write');
  try {
    await tx.execute({
      sql: 'INSERT OR IGNORE INTO streak_state (telegram_id) VALUES (?)',
      args: [telegramId],
    });
    const rowRes = await tx.execute({
      sql: `SELECT consecutive_days, last_claim_date, best_streak, total_claims
            FROM streak_state WHERE telegram_id = ?`,
      args: [telegramId],
    });
    const row = rowRes.rows[0];
    const next = computeNextClaim(row);
    if (next.alreadyClaimedToday) {
      const err = new Error("You've already claimed today's streak reward — come back tomorrow");
      err.statusCode = 400;
      throw err;
    }

    const rewards = rewardsFromSettings(settings);
    const earnedPoints = rewards[next.position - 1];
    const newBest = Math.max(row.best_streak, next.nextConsecutive);

    await tx.execute({
      sql: 'UPDATE users SET main_balance = main_balance + ? WHERE telegram_id = ?',
      args: [earnedPoints, telegramId],
    });
    await tx.execute({
      sql: `UPDATE streak_state
            SET consecutive_days = ?, last_claim_date = ?, best_streak = ?, total_claims = total_claims + 1
            WHERE telegram_id = ?`,
      args: [next.nextConsecutive, todayUTC(), newBest, telegramId],
    });
    await tx.execute({
      sql: 'INSERT INTO ledger (telegram_id, type, points_delta, meta) VALUES (?, ?, ?, ?)',
      args: [
        telegramId,
        'streak_claim',
        earnedPoints,
        JSON.stringify({ network, position: next.position, consecutive_days: next.nextConsecutive }),
      ],
    });

    const updatedRes = await tx.execute({
      sql: 'SELECT main_balance FROM users WHERE telegram_id = ?',
      args: [telegramId],
    });
    await tx.commit();

    return {
      earned_points: earnedPoints,
      main_balance: updatedRes.rows[0].main_balance,
      consecutive_days: next.nextConsecutive,
      position: next.position,
      best_streak: newBest,
    };
  } catch (err) {
    await tx.rollback().catch(() => {});
    throw err;
  }
}

module.exports = { getStatus, prepareClaim, claim };
