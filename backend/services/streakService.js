const { client } = require('../db/db');
const { getAllSettings } = require('../utils/settings');
const { startAdEvent, consumeAdEvent } = require('../utils/monetagAds');

/**
 * 7-day streak: watch an ad once per calendar day (UTC) to advance to
 * the next day's (bigger) reward. Miss a day and it resets to day 1.
 * After day 7, claiming again wraps back to day 1 and the cycle
 * repeats — there's no "final" reward that stops the streak, it just
 * loops, same shape as most mobile daily-reward systems.
 *
 * Reward per day is fully admin-editable (Settings → streak_day1_points
 * .. streak_day7_points), and which ad network confirms the claim is
 * its own switch (Settings → streak_ad_network) — independent of
 * action_ads_network and auto_ad_network.
 */

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

function daysBetween(aStr, bStr) {
  const a = new Date(aStr + 'T00:00:00Z').getTime();
  const b = new Date(bStr + 'T00:00:00Z').getTime();
  return Math.round((b - a) / 86400000);
}

async function getRow(telegramId) {
  await client.execute({
    sql: 'INSERT OR IGNORE INTO user_streak (telegram_id) VALUES (?)',
    args: [telegramId],
  });
  const res = await client.execute({
    sql: 'SELECT streak_day, last_claim_date FROM user_streak WHERE telegram_id = ?',
    args: [telegramId],
  });
  return res.rows[0];
}

// The day number (1-7) a claim RIGHT NOW would complete, and whether a
// claim is even available today (already claimed today = not available
// until tomorrow).
function computeNextClaim(row) {
  const today = todayUTC();
  if (row.last_claim_date === today) {
    return { available: false, nextDay: row.streak_day, brokeStreak: false };
  }
  if (!row.last_claim_date) {
    return { available: true, nextDay: 1, brokeStreak: false };
  }
  const gap = daysBetween(row.last_claim_date, today);
  if (gap === 1) {
    // Continues the cycle: day 7 -> day 1 again, otherwise +1.
    const nextDay = row.streak_day >= 7 ? 1 : row.streak_day + 1;
    return { available: true, nextDay, brokeStreak: false };
  }
  // gap > 1 (or somehow negative/clock weirdness) — streak broken.
  return { available: true, nextDay: 1, brokeStreak: row.streak_day > 0 };
}

async function getStatus({ telegramId }) {
  const [row, settings] = await Promise.all([getRow(telegramId), getAllSettings()]);
  const { available, nextDay, brokeStreak } = computeNextClaim(row);
  const rewardFor = (day) => settings[`streak_day${day}_points`];

  return {
    current_day: row.streak_day, // last COMPLETED day, 0 if never claimed
    next_day: nextDay, // day a claim right now would complete
    next_reward: rewardFor(nextDay),
    can_claim: available,
    broke_streak: brokeStreak, // true only on the response right after a miss, so the UI can show "streak reset" once
    rewards: [1, 2, 3, 4, 5, 6, 7].map((d) => ({ day: d, points: rewardFor(d) })),
  };
}

async function prepareClaim({ telegramId }) {
  const row = await getRow(telegramId);
  const { available } = computeNextClaim(row);
  if (!available) {
    const err = new Error("You've already claimed today's streak reward — come back tomorrow");
    err.statusCode = 400;
    throw err;
  }
  return startAdEvent({ telegramId, action: 'streak_claim' });
}

async function claim({ telegramId, nonce }) {
  const event = await consumeAdEvent({ nonce, telegramId, action: 'streak_claim' });
  void event; // no revenue-share here — streak uses fixed per-day settings regardless of network

  const settings = await getAllSettings();
  const tx = await client.transaction('write');
  try {
    await tx.execute({
      sql: 'INSERT OR IGNORE INTO user_streak (telegram_id) VALUES (?)',
      args: [telegramId],
    });
    const rowRes = await tx.execute({
      sql: 'SELECT streak_day, last_claim_date FROM user_streak WHERE telegram_id = ?',
      args: [telegramId],
    });
    const row = rowRes.rows[0];
    const { available, nextDay } = computeNextClaim(row);
    if (!available) {
      const err = new Error("You've already claimed today's streak reward — come back tomorrow");
      err.statusCode = 400;
      throw err;
    }

    const earnedPoints = settings[`streak_day${nextDay}_points`];
    const today = todayUTC();

    await tx.execute({
      sql: 'UPDATE users SET main_balance = main_balance + ? WHERE telegram_id = ?',
      args: [earnedPoints, telegramId],
    });
    await tx.execute({
      sql: 'UPDATE user_streak SET streak_day = ?, last_claim_date = ? WHERE telegram_id = ?',
      args: [nextDay, today, telegramId],
    });
    await tx.execute({
      sql: 'INSERT INTO ledger (telegram_id, type, points_delta, meta) VALUES (?, ?, ?, ?)',
      args: [telegramId, 'streak_claim', earnedPoints, JSON.stringify({ day: nextDay })],
    });

    const updatedRes = await tx.execute({
      sql: 'SELECT main_balance FROM users WHERE telegram_id = ?',
      args: [telegramId],
    });
    await tx.commit();
    return { earned_points: earnedPoints, main_balance: updatedRes.rows[0].main_balance, day: nextDay };
  } catch (err) {
    await tx.rollback().catch(() => {});
    throw err;
  }
}

module.exports = { getStatus, prepareClaim, claim };
