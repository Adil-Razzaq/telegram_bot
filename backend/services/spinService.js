const { client, rolloverDailyCountersIfNeeded } = require('../db/db');

// Spin no longer requires watching an ad. Monetag/Adsgram policy
// explicitly prohibits gating a core app action behind a mandatory ad
// ("services where you need to watch advertisements to perform any
// actions") — this used to call consumeAdEvent() before every spin,
// which is exactly that pattern. The entry fee alone (funded into
// spin_pool, see playSpin below) is what makes spins self-funding now;
// ad revenue is earned separately and optionally via bonusAdService.js.
const ENTRY_FEE = 100;

// Base probabilities. These only apply among segments that are currently
// ELIGIBLE (see isEligible below) — ineligible segments are removed and
// the remaining weights are renormalized, so on a day/pool state where
// segments 5 & 6 are locked, segments 1-4 absorb their combined 5%
// probability proportionally rather than that probability mass vanishing.
const SEGMENTS = [
  { index: 1, payout: 10, weight: 0.40 },
  { index: 2, payout: 20, weight: 0.30 },
  { index: 3, payout: 50, weight: 0.15 },
  { index: 4, payout: 100, weight: 0.10 },
  {
    index: 5,
    payout: 200,
    weight: 0.04,
    isEligible: (pool) => pool.daily_collected >= 400,
  },
  {
    index: 6,
    payout: 500,
    weight: 0.01,
    isEligible: (pool) => pool.daily_collected >= 5000 && pool.current_pool_points >= 500,
  },
];

function pickSegment(pool) {
  // A segment is only offered if (a) any segment-specific unlock condition
  // passes, AND (b) the pool can actually afford the payout without going
  // negative — this is the "server evaluates available SpinPool points
  // BEFORE determining outcome" insolvency guard from the spec.
  const eligible = SEGMENTS.filter((seg) => {
    if (seg.payout > pool.current_pool_points) return false;
    if (seg.isEligible && !seg.isEligible(pool)) return false;
    return true;
  });

  const totalWeight = eligible.reduce((sum, seg) => sum + seg.weight, 0);
  let roll = Math.random() * totalWeight;
  for (const seg of eligible) {
    if (roll < seg.weight) return seg;
    roll -= seg.weight;
  }
  return eligible[eligible.length - 1]; // floating point safety net
}

/**
 * Plays one spin for telegramId. No ad required — just the entry fee.
 * Throws Error with .statusCode for the route layer to translate into an
 * HTTP response.
 */
async function playSpin({ telegramId }) {
  await rolloverDailyCountersIfNeeded();

  const tx = await client.transaction('write');
  try {
    const userRes = await tx.execute({
      sql: 'SELECT * FROM users WHERE telegram_id = ?',
      args: [telegramId],
    });
    const user = userRes.rows[0];
    if (!user) {
      const err = new Error('User not found');
      err.statusCode = 404;
      throw err;
    }

    if (user.main_balance < ENTRY_FEE) {
      const err = new Error('Insufficient balance for spin entry fee');
      err.statusCode = 400;
      throw err;
    }

    // 1. Deduct entry fee from user, stamp last_spin_at, add to pool + daily_collected
    await tx.execute({
      sql: 'UPDATE users SET main_balance = main_balance - ?, last_spin_at = CURRENT_TIMESTAMP WHERE telegram_id = ?',
      args: [ENTRY_FEE, telegramId],
    });
    await tx.execute({
      sql: 'UPDATE spin_pool SET current_pool_points = current_pool_points + ?, daily_collected = daily_collected + ? WHERE id = 1',
      args: [ENTRY_FEE, ENTRY_FEE],
    });
    await tx.execute({
      sql: 'INSERT INTO ledger (telegram_id, type, points_delta, meta) VALUES (?, ?, ?, ?)',
      args: [telegramId, 'spin_entry', -ENTRY_FEE, JSON.stringify({})],
    });

    // 2. Evaluate pool state AFTER the entry fee lands, then pick a segment
    const poolRes = await tx.execute('SELECT * FROM spin_pool WHERE id = 1');
    const pool = poolRes.rows[0];
    const segment = pickSegment(pool);

    // 3. Pay out (segment 1 pays 0, no-op update kept for symmetry/audit)
    if (segment.payout > 0) {
      await tx.execute({
        sql: 'UPDATE users SET main_balance = main_balance + ? WHERE telegram_id = ?',
        args: [segment.payout, telegramId],
      });
      await tx.execute({
        sql: 'UPDATE spin_pool SET current_pool_points = current_pool_points - ? WHERE id = 1',
        args: [segment.payout],
      });
    }
    await tx.execute({
      sql: 'INSERT INTO ledger (telegram_id, type, points_delta, meta) VALUES (?, ?, ?, ?)',
      args: [telegramId, 'spin_payout', segment.payout, JSON.stringify({ segment: segment.index })],
    });

    const updatedUserRes = await tx.execute({
      sql: 'SELECT * FROM users WHERE telegram_id = ?',
      args: [telegramId],
    });
    const updatedPoolRes = await tx.execute('SELECT * FROM spin_pool WHERE id = 1');

    await tx.commit();

    const updatedUser = updatedUserRes.rows[0];
    const updatedPool = updatedPoolRes.rows[0];

    return {
      segment_index: segment.index,
      points_won: segment.payout,
      main_balance: updatedUser.main_balance,
      pool_snapshot: {
        current_pool_points: updatedPool.current_pool_points,
        daily_collected: updatedPool.daily_collected,
      },
    };
  } catch (err) {
    await tx.rollback().catch(() => {});
    throw err;
  }
}

module.exports = { playSpin, ENTRY_FEE, SEGMENTS };
