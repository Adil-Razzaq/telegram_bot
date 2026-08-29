const { client } = require('../db/db');

const BASE_DAILY_POINTS = 200; // = $0.02/day at 10,000 pts = $1
const BASE_RATE_PER_SECOND = BASE_DAILY_POINTS / 86400;
const MAX_ACCUMULATION_SECONDS = 86400; // caps backlog at 24h so idle time isn't unlimited

// Confirmed tier structure: every 10 referrals unlocks the next tier.
// First five tiers give 20/20/10/10/10 (cumulative +70% at 50 referrals),
// then every additional 10 referrals adds +5% forever, uncapped.
const TIER_MILESTONES_PERCENT = [20, 20, 10, 10, 10];
const REFERRALS_PER_TIER = 10;
const ONGOING_TIER_BOOST_PERCENT = 5;

function boostPercentForReferrals(referralCount) {
  const tiersAchieved = Math.floor(referralCount / REFERRALS_PER_TIER);
  let boost = 0;
  for (let i = 0; i < tiersAchieved; i++) {
    boost += i < TIER_MILESTONES_PERCENT.length ? TIER_MILESTONES_PERCENT[i] : ONGOING_TIER_BOOST_PERCENT;
  }
  return boost;
}

function nextTierInfo(referralCount) {
  const referralsIntoTier = referralCount % REFERRALS_PER_TIER;
  const referralsNeeded = REFERRALS_PER_TIER - referralsIntoTier;
  const tiersAchieved = Math.floor(referralCount / REFERRALS_PER_TIER);
  const nextBoost =
    tiersAchieved < TIER_MILESTONES_PERCENT.length
      ? TIER_MILESTONES_PERCENT[tiersAchieved]
      : ONGOING_TIER_BOOST_PERCENT;
  return { referrals_needed: referralsNeeded, next_boost_percent: nextBoost };
}

async function getReferralCount(telegramId) {
  const res = await client.execute({
    sql: 'SELECT COUNT(*) as cnt FROM users WHERE referred_by = ?',
    args: [telegramId],
  });
  return Number(res.rows[0].cnt);
}

async function ensureMinerRow(telegramId) {
  await client.execute({
    sql: 'INSERT OR IGNORE INTO miner_state (telegram_id) VALUES (?)',
    args: [telegramId],
  });
}

/**
 * Read-only status for the frontend's live ticking display: current rate
 * (points/second, after the referral boost) and how much has accrued
 * since the last claim, as of right now. The frontend interpolates
 * between polls of this for the smooth "+0.0506"-style live counter.
 */
async function getStatus({ telegramId }) {
  await ensureMinerRow(telegramId);
  const [minerRes, referralCount] = await Promise.all([
    client.execute({
      sql: 'SELECT accumulation_started_at FROM miner_state WHERE telegram_id = ?',
      args: [telegramId],
    }),
    getReferralCount(telegramId),
  ]);

  const startedAt = new Date(minerRes.rows[0].accumulation_started_at + 'Z');
  const elapsedSeconds = Math.max(0, (Date.now() - startedAt.getTime()) / 1000);
  const cappedSeconds = Math.min(elapsedSeconds, MAX_ACCUMULATION_SECONDS);

  const boostPercent = boostPercentForReferrals(referralCount);
  const ratePerSecond = BASE_RATE_PER_SECOND * (1 + boostPercent / 100);
  const accruedNow = cappedSeconds * ratePerSecond;

  return {
    accumulation_started_at: minerRes.rows[0].accumulation_started_at,
    rate_per_second: ratePerSecond,
    rate_per_day: BASE_DAILY_POINTS * (1 + boostPercent / 100),
    accrued_now: accruedNow,
    is_capped: elapsedSeconds >= MAX_ACCUMULATION_SECONDS,
    referral_count: referralCount,
    boost_percent: boostPercent,
    next_tier: nextTierInfo(referralCount),
  };
}

/**
 * Claims everything accrued since the last claim (or since the miner
 * started, if never claimed), credits it to main_balance, and resets the
 * accumulation window to now. Atomic against double-claims via the same
 * write-transaction pattern used everywhere else in this app.
 */
async function claim({ telegramId }) {
  await ensureMinerRow(telegramId);

  const tx = await client.transaction('write');
  try {
    const minerRes = await tx.execute({
      sql: 'SELECT accumulation_started_at FROM miner_state WHERE telegram_id = ?',
      args: [telegramId],
    });
    const startedAt = new Date(minerRes.rows[0].accumulation_started_at + 'Z');
    const elapsedSeconds = Math.max(0, (Date.now() - startedAt.getTime()) / 1000);
    const cappedSeconds = Math.min(elapsedSeconds, MAX_ACCUMULATION_SECONDS);

    const referralCount = await getReferralCount(telegramId);
    const boostPercent = boostPercentForReferrals(referralCount);
    const ratePerSecond = BASE_RATE_PER_SECOND * (1 + boostPercent / 100);
    const earnedPoints = Math.floor(cappedSeconds * ratePerSecond);

    if (earnedPoints <= 0) {
      const err = new Error('Nothing to claim yet');
      err.statusCode = 400;
      throw err;
    }

    await tx.execute({
      sql: 'UPDATE users SET main_balance = main_balance + ? WHERE telegram_id = ?',
      args: [earnedPoints, telegramId],
    });
    await tx.execute({
      sql: 'UPDATE miner_state SET accumulation_started_at = CURRENT_TIMESTAMP WHERE telegram_id = ?',
      args: [telegramId],
    });
    await tx.execute({
      sql: 'INSERT INTO ledger (telegram_id, type, points_delta, meta) VALUES (?, ?, ?, ?)',
      args: [telegramId, 'miner_claim', earnedPoints, JSON.stringify({ boostPercent, referralCount })],
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

module.exports = {
  getStatus,
  claim,
  boostPercentForReferrals,
  BASE_DAILY_POINTS,
  MAX_ACCUMULATION_SECONDS,
};
