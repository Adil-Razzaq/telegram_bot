const { client, rolloverDailyCountersIfNeeded } = require('../db/db');
const { startAdEvent, consumeAdEvent } = require('../utils/monetagAds');
const { getAllSettings } = require('../utils/settings');

// Base probabilities only — the actual payout AMOUNTS come from
// settings (spin_payout_1..6, admin-editable). Weights recalibrated so
// a PAID spin's expected value ≈ 50% of the entry fee — i.e. across
// many spins, roughly half of what's collected in entry fees flows
// back out as winnings, the other half is margin. With the default
// payouts (10/20/50/100/200/500) and these weights, EV ≈ 49.8 against
// a 100-point entry fee. If you change the payout values via the admin
// panel, these weights won't auto-recalculate — you'd want to rebalance
// them too to keep the ~50/50 split accurate.
const SEGMENT_WEIGHTS = [
  { index: 1, weight: 0.32 },
  { index: 2, weight: 0.28 },
  { index: 3, weight: 0.19 },
  { index: 4, weight: 0.15 },
  { index: 5, weight: 0.045, isEligible: (pool) => pool.daily_collected >= 400 },
  {
    index: 6,
    weight: 0.015,
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

// For a FREE spin, the payout isn't random — it's whatever segment's
// value sits closest to what the ad genuinely earned (50% revenue
// share, same model as bonusAdService.js), so the wheel visually lands
// on a number that's honestly "about" what that ad view was worth,
// rather than a random unrelated amount. Still constrained to pool-
// affordable/eligible segments — a free spin can't land on a segment
// the pool can't actually pay out.
const FREE_SPIN_REVENUE_SHARE = 0.5;

function pickNearestSegment(segments, pool, targetValue) {
  const eligible = segments.filter((seg) => {
    if (seg.payout > pool.current_pool_points) return false;
    if (seg.isEligible && !seg.isEligible(pool, seg.payout)) return false;
    return true;
  });
  return eligible.reduce((closest, seg) =>
    Math.abs(seg.payout - targetValue) < Math.abs(closest.payout - targetValue) ? seg : closest
  );
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

async function isFreeSpinAvailable(telegramId) {
  const [config, userRes] = await Promise.all([
    getSpinConfig(),
    client.execute({ sql: 'SELECT free_spins_used FROM users WHERE telegram_id = ?', args: [telegramId] }),
  ]);
  return (userRes.rows[0]?.free_spins_used ?? 0) < config.freeSpins;
}

// A PAID spin (costs spin_entry_fee points, already-earned in-game
// currency) is core gameplay and must work with no ad at all — see
// minerService.js's header for the Adsgram-policy reasoning this app
// follows throughout ("basic functions available without ads",
// disallowing "each click leads to an ad" / "need to watch an ad to
// perform any action"). The FREE daily spin allowance is the one
// legitimate ad placement here: watching an ad to get something for
// nothing is exactly the "clear indication you need to watch an ad to
// get a bonus" pattern Adsgram's policy explicitly allows — so only
// that path requires one.
async function prepareSpin({ telegramId }) {
  const free = await isFreeSpinAvailable(telegramId);
  if (!free) return null; // paid spin — no ad needed
  return startAdEvent({ telegramId, action: 'spin' });
}

/**
 * Plays one spin for telegramId. If this turns out to be a free spin
 * (no entry fee), `nonce` must be a Monetag-confirmed ad event from
 * prepareSpin() — consumeAdEvent throws if it's missing, unconfirmed,
 * expired, or already used. Paid spins ignore `nonce` entirely; no ad
 * involved. Throws Error with .statusCode for the route layer to
 * translate into an HTTP response.
 */
async function playSpin({ telegramId, nonce }) {
  await rolloverDailyCountersIfNeeded();

  const config = await getSpinConfig();
  const settings = await getAllSettings();

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

    // Only a free spin needs a confirmed ad view — consumed here,
    // inside the transaction, right where it's actually needed (if the
    // rest of the spin later fails, the ad view is still "spent",
    // which is fine — it's not exploitable, a wasted ad view costs the
    // user, not us). event.estimated_price (Monetag's real revenue for
    // this exact ad view) sizes the free spin's payout below. A paid
    // spin never touches the ad system at all.
    let event = null;
    if (isFreeSpin) {
      if (!nonce) {
        const err = new Error('Watch an ad first to use your free spin');
        err.statusCode = 400;
        throw err;
      }
      event = await consumeAdEvent({ nonce, telegramId, action: 'spin' });
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

    // 2. Evaluate pool state AFTER the entry fee lands, then pick a segment.
    const poolRes = await tx.execute('SELECT * FROM spin_pool WHERE id = 1');
    const pool = poolRes.rows[0];

    // Free spins land on whatever segment is closest to what the ad
    // actually earned (50% revenue share) — small, honest, real-value
    // rewards, instead of the same random-jackpot odds as a paid spin.
    // Paid spins keep the weighted-random pick, calibrated for ~50%
    // RTP against the entry fee (see SEGMENT_WEIGHTS above).
    const segment = isFreeSpin
      ? pickNearestSegment(
          config.segments,
          pool,
          (event?.estimated_price || 0) * settings.points_per_usd * FREE_SPIN_REVENUE_SHARE
        )
      : pickSegment(config.segments, pool);

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
