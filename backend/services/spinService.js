const { client, rolloverDailyCountersIfNeeded } = require('../db/db');
const { startAdEvent, consumeAdEvent } = require('../utils/monetagAds');
const { getAllSettings } = require('../utils/settings');

// Base probabilities only — the actual payout AMOUNTS now come from
// settings (spin_payout_1..6, admin-editable), so this only defines the
// odds and the pool-affordability/unlock rules per segment slot.
const SEGMENT_WEIGHTS = [
  { index: 1, weight: 0.40 },
  { index: 2, weight: 0.30 },
  { index: 3, weight: 0.15 },
  { index: 4, weight: 0.10 },
  { index: 5, weight: 0.04, isEligible: (pool) => pool.daily_collected >= 400 },
  {
    index: 6,
    weight: 0.01,
    isEligible: (pool, payout) => pool.daily_collected >= 5000 && pool.current_pool_points >= payout,
  },
];

async function getSpinConfig() {
  const settings = await getAllSettings();
  const payouts = {
    1: settings.spin_payout_1,
    2: settings.spin_payout_2,
    3: settings.spin_payout_3,
    4: settings.spin_payout_4,
    5: settings.spin_payout_5,
    6: settings.spin_payout_6,
  };
  const segments = SEGMENT_WEIGHTS.map((seg) => ({ ...seg, payout: payouts[seg.index] }));
  return {
    entryFee: settings.spin_entry_fee,
    freeSpins: settings.spin_free_spins,
    segments,
  };
}

function pickSegment(segments, pool) {
  // A segment is only offered if (a) any segment-specific unlock condition
  // passes, AND (b) the pool can actually afford the payout without going
  // negative — this is the "server evaluates available SpinPool points
  // BEFORE determining outcome" insolvency guard from the spec.
  const eligible = segments.filter((seg) => {
    if (seg.payout > pool.current_pool_points) return false;
    if (seg.isEligible && !seg.isEligible(pool, seg.payout)) return false;
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
 * Public config for the frontend — current payouts, entry fee, and how
 * many free spins this specific user has left. Lets the wheel's labels
 * and cost text always reflect whatever's actually configured right now,
 * instead of stale hardcoded values baked into the frontend bundle.
 */
async function getSpinConfigForUser({ telegramId }) {
  const [config, userRes] = await Promise.all([
    getSpinConfig(),
    client.execute({ sql: 'SELECT free_spins_used FROM users WHERE telegram_id = ?', args: [telegramId] }),
  ]);
  const used = userRes.rows[0]?.free_spins_used ?? 0;
  return {
    entry_fee: config.entryFee,
    payouts: config.segments.map((s) => ({ index: s.index, payout: s.payout })),
    free_spins_remaining: Math.max(0, config.freeSpins - used),
  };
}

async function prepareSpin({ telegramId }) {
  return startAdEvent({ telegramId, action: 'spin' });
}

/**
 * Plays one spin for telegramId. `nonce` must be a Monetag-confirmed ad
 * event from prepareSpin() — consumeAdEvent throws if it's missing,
 * unconfirmed, expired, or already used. Throws Error with .statusCode
 * for the route layer to translate into an HTTP response.
 */
async function playSpin({ telegramId, nonce }) {
  await rolloverDailyCountersIfNeeded();

  // Consumed before the balance transaction: if the spin later fails
  // (e.g. insufficient balance), the ad view is "spent" either way —
  // that's an acceptable tradeoff for keeping this atomic and simple,
  // and it's not exploitable (a wasted ad view costs the user, not us).
  await consumeAdEvent({ nonce, telegramId, action: 'spin' });

  const config = await getSpinConfig();

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

    const isFreeSpin = (user.free_spins_used || 0) < config.freeSpins;
    const entryFee = isFreeSpin ? 0 : config.entryFee;

    if (!isFreeSpin && user.main_balance < entryFee) {
      const err = new Error('Insufficient balance for spin entry fee');
      err.statusCode = 400;
      throw err;
    }

    // 1. Deduct entry fee (0 for a free spin), stamp last_spin_at, track
    // free-spin usage, add to pool + daily_collected (a free spin still
    // funds the pool at the same amount a paid entry would have, so the
    // payout pool isn't starved by giving new users free spins).
    await tx.execute({
      sql: `UPDATE users
            SET main_balance = main_balance - ?,
                last_spin_at = CURRENT_TIMESTAMP,
                free_spins_used = free_spins_used + ?
            WHERE telegram_id = ?`,
      args: [entryFee, isFreeSpin ? 1 : 0, telegramId],
    });
    await tx.execute({
      sql: 'UPDATE spin_pool SET current_pool_points = current_pool_points + ?, daily_collected = daily_collected + ? WHERE id = 1',
      args: [config.entryFee, config.entryFee],
    });
    await tx.execute({
      sql: 'INSERT INTO ledger (telegram_id, type, points_delta, meta) VALUES (?, ?, ?, ?)',
      args: [telegramId, 'spin_entry', -entryFee, JSON.stringify({ free_spin: isFreeSpin })],
    });

    // 2. Evaluate pool state AFTER the entry fee lands, then pick a segment
    const poolRes = await tx.execute('SELECT * FROM spin_pool WHERE id = 1');
    const pool = poolRes.rows[0];
    const segment = pickSegment(config.segments, pool);

    // 3. Pay out
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
      was_free_spin: isFreeSpin,
      main_balance: updatedUser.main_balance,
      free_spins_remaining: Math.max(0, config.freeSpins - updatedUser.free_spins_used),
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

module.exports = { prepareSpin, playSpin, getSpinConfigForUser };
