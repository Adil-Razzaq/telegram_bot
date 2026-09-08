const { client, rolloverUserRefCounterIfNeeded } = require('../db/db');
const { startAdEventIfRequired, consumeAdEventIfRequired } = require('../utils/monetagAds');
const { getSetting } = require('../utils/settings');
const { checkOfficialChannelsMembership } = require('./taskService');

// Default 100 pts/claim (utils/settings.js) — tunable live via the admin
// panel's Settings section without a deploy.
const DAILY_CLAIM_CAP = 20;
const COOLDOWN_SECONDS = 60;

// Called from the bot's /start handler (routes/bot.js) the moment a
// referred user first opens the bot — this is what was missing before:
// nothing was ever calling this, so no referral was ever credited no
// matter how correct the claim/cooldown logic downstream was.
// Idempotent via users.referred_by: a user can only ever be credited to
// one referrer, once, no matter how many times /start fires for them.
//
// ANTI-BOT-FARM GATING: when settings.referral_qualify_miner_cycles > 0
// and/or settings.referral_require_channel_join is true, this no longer
// credits the reward immediately — it only links referred_by (still
// idempotent, still one-shot). The actual reward is credited later by
// maybeQualifyReferral, once the REFERRED user has genuinely completed
// that many mining cycles and (if required) joined every channel in
// settings.official_channels — see minerService.js's claim(), which
// calls maybeQualifyReferral after every completed cycle. With both
// settings left at their defaults (0 / false), behavior is UNCHANGED
// from before: instant credit, exactly like today.
async function grantReferral({ referrerId, referredTelegramId }) {
  if (referrerId === referredTelegramId) {
    const err = new Error('Self-referral is not allowed');
    err.statusCode = 400;
    throw err;
  }

  const [requiredCycles, requireChannelJoin] = await Promise.all([
    getSetting('referral_qualify_miner_cycles'),
    getSetting('referral_require_channel_join'),
  ]);
  const gatingActive = requiredCycles > 0 || requireChannelJoin;

  const tx = await client.transaction('write');
  try {
    await tx.execute({
      sql: 'INSERT OR IGNORE INTO users (telegram_id) VALUES (?)',
      args: [referredTelegramId],
    });
    await tx.execute({
      sql: 'INSERT OR IGNORE INTO users (telegram_id) VALUES (?)',
      args: [referrerId],
    });

    const referredRes = await tx.execute({
      sql: 'SELECT referred_by FROM users WHERE telegram_id = ?',
      args: [referredTelegramId],
    });
    if (referredRes.rows[0].referred_by) {
      const err = new Error('This user has already been credited to a referrer');
      err.statusCode = 409;
      throw err;
    }

    await tx.execute({
      sql: 'UPDATE users SET referred_by = ? WHERE telegram_id = ?',
      args: [referrerId, referredTelegramId],
    });

    if (gatingActive) {
      // Link only — no reward yet. Recorded as its own ledger type
      // (0 points) purely for audit visibility ("this referral exists
      // and is awaiting qualification"), distinct from 'referral_grant'
      // which always means points actually moved.
      await tx.execute({
        sql: 'INSERT INTO ledger (telegram_id, type, points_delta, meta) VALUES (?, ?, ?, ?)',
        args: [referrerId, 'referral_linked', 0, JSON.stringify({ referredTelegramId, pendingQualification: true })],
      });
    } else {
      const REFERRAL_BASE_REWARD = await getSetting('referral_reward');
      await tx.execute({
        sql: 'UPDATE users SET pending_referral_balance = pending_referral_balance + ? WHERE telegram_id = ?',
        args: [REFERRAL_BASE_REWARD, referrerId],
      });
      await tx.execute({
        sql: 'INSERT INTO ledger (telegram_id, type, points_delta, meta) VALUES (?, ?, ?, ?)',
        args: [referrerId, 'referral_grant', REFERRAL_BASE_REWARD, JSON.stringify({ referredTelegramId })],
      });
      // Old path also stays the source of truth for "already rewarded",
      // so maybeQualifyReferral (if gating gets turned on later) never
      // double-grants this same referral.
      await tx.execute({
        sql: 'UPDATE users SET referral_qualified = 1 WHERE telegram_id = ?',
        args: [referredTelegramId],
      });
    }

    const updatedRes = await tx.execute({
      sql: 'SELECT * FROM users WHERE telegram_id = ?',
      args: [referrerId],
    });
    await tx.commit();

    // ADDED: catches the case where the referred user already had
    // enough mining cycles (or already met the channel-join rule)
    // BEFORE this link was even created — e.g. they mined first, then
    // opened the referral link later. Without this, maybeQualifyReferral
    // only ever runs from a FUTURE cycle claim (see minerService.js), so
    // that user would sit "stuck" needing one extra, unnecessary cycle
    // before their referrer ever gets paid. Safe to fire immediately:
    // maybeQualifyReferral re-checks everything itself and is a no-op
    // if conditions genuinely aren't met yet. Non-blocking (same
    // fire-and-forget pattern as minerService.js's claim()) so a slow
    // channel-membership check can never delay the /register or /start
    // response.
    if (gatingActive) {
      maybeQualifyReferral(referredTelegramId).catch((e) =>
        console.error('Referral qualification check failed after linking:', e.message)
      );
    }

    return updatedRes.rows[0];
  } catch (err) {
    await tx.rollback().catch(() => {});
    throw err;
  }
}

// Called after a referred user does something that could newly satisfy
// referral qualification — today that's exclusively "completed a mining
// cycle" (see minerService.js's claim()), since that's the one event
// guaranteed to fire repeatedly for an active user, so even
// channel-join-only gating (requiredCycles = 0) still gets re-checked
// each time they mine. Safe to call any time: a no-op unless the user
// was actually referred, isn't already qualified, and now genuinely
// meets every condition currently configured. Never throws — a bad
// channel config or a transient Telegram API error should never break
// whatever the caller (e.g. a mining claim) was doing; it just means
// qualification is deferred to the next attempt.
async function maybeQualifyReferral(referredTelegramId) {
  try {
    const [requiredCycles, requireChannelJoin, referralReward] = await Promise.all([
      getSetting('referral_qualify_miner_cycles'),
      getSetting('referral_require_channel_join'),
      getSetting('referral_reward'),
    ]);

    const userRes = await client.execute({
      sql: 'SELECT referred_by, referral_qualified, total_miner_cycles_completed FROM users WHERE telegram_id = ?',
      args: [referredTelegramId],
    });
    const user = userRes.rows[0];
    if (!user || !user.referred_by || user.referral_qualified) return false;

    if (requiredCycles > 0 && (user.total_miner_cycles_completed || 0) < requiredCycles) {
      return false;
    }

    if (requireChannelJoin) {
      let membership;
      try {
        membership = await checkOfficialChannelsMembership(referredTelegramId);
      } catch (e) {
        console.error('Referral qualification: channel check failed —', e.message);
        return false;
      }
      if (!membership.joined) return false;
    }

    const tx = await client.transaction('write');
    try {
      // Re-check inside the transaction, locking out any race between
      // two triggers (e.g. two rapid mining claims) firing at once —
      // whichever commits first wins, the other sees referral_qualified
      // already 1 and backs out without granting twice.
      const lockedRes = await tx.execute({
        sql: 'SELECT referred_by, referral_qualified FROM users WHERE telegram_id = ?',
        args: [referredTelegramId],
      });
      const locked = lockedRes.rows[0];
      if (!locked || !locked.referred_by || locked.referral_qualified) {
        await tx.rollback().catch(() => {});
        return false;
      }

      await tx.execute({
        sql: 'UPDATE users SET referral_qualified = 1 WHERE telegram_id = ?',
        args: [referredTelegramId],
      });
      await tx.execute({
        sql: 'INSERT OR IGNORE INTO users (telegram_id) VALUES (?)',
        args: [locked.referred_by],
      });
      await tx.execute({
        sql: 'UPDATE users SET pending_referral_balance = pending_referral_balance + ? WHERE telegram_id = ?',
        args: [referralReward, locked.referred_by],
      });
      await tx.execute({
        sql: 'INSERT INTO ledger (telegram_id, type, points_delta, meta) VALUES (?, ?, ?, ?)',
        args: [locked.referred_by, 'referral_grant', referralReward, JSON.stringify({ referredTelegramId, qualified: true })],
      });
      await tx.commit();
      return true;
    } catch (err) {
      await tx.rollback().catch(() => {});
      throw err;
    }
  } catch (err) {
    console.error('maybeQualifyReferral failed:', err.message);
    return false;
  }
}

// Self-healing sweep for referrals that already meet qualification but
// were never actually re-checked — e.g. a referred user who finished
// enough cycles BEFORE the immediate at-link check (above, in
// grantReferral) ever existed or ran for them, or before gating was
// turned on at all. Without this, such a referral sits stuck forever
// unless that specific referred user happens to mine one more cycle,
// which is exactly the "0/2 / 1/2 never flips" symptom. Called once at
// server startup and then on a fixed interval (see server.js) so it
// resolves itself automatically, with no admin action and no
// dependency on future activity from the referred user. Fully
// idempotent: maybeQualifyReferral does its own re-check-and-lock, so
// sweeping an already-qualified user (the overwhelming majority of
// rows here, over time) is always a cheap, safe no-op.
async function reconcileStuckReferrals() {
  try {
    const res = await client.execute(
      'SELECT telegram_id FROM users WHERE referred_by IS NOT NULL AND referral_qualified = 0'
    );
    for (const row of res.rows) {
      await maybeQualifyReferral(row.telegram_id);
    }
  } catch (err) {
    console.error('reconcileStuckReferrals failed:', err.message);
  }
}

async function prepareClaim({ telegramId }) {
  return startAdEventIfRequired({ telegramId, action: 'referral_claim' });
}

async function claimReferral({ telegramId, nonce }) {
  const REFERRAL_BASE_REWARD = await getSetting('referral_reward');
  await rolloverUserRefCounterIfNeeded(telegramId);
  await consumeAdEventIfRequired({ nonce, telegramId, action: 'referral_claim' });

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

    if (user.pending_referral_balance < REFERRAL_BASE_REWARD) {
      const err = new Error('No pending referral reward to claim');
      err.statusCode = 400;
      throw err;
    }
    if (user.daily_ref_claims_count >= DAILY_CLAIM_CAP) {
      const err = new Error('Daily referral claim limit reached (20/day)');
      err.statusCode = 429;
      throw err;
    }

    await tx.execute({
      sql: `UPDATE users
            SET pending_referral_balance = pending_referral_balance - ?,
                main_balance = main_balance + ?,
                daily_ref_claims_count = daily_ref_claims_count + 1,
                last_ref_claim_at = CURRENT_TIMESTAMP
            WHERE telegram_id = ?`,
      args: [REFERRAL_BASE_REWARD, REFERRAL_BASE_REWARD, telegramId],
    });
    await tx.execute({
      sql: 'INSERT INTO ledger (telegram_id, type, points_delta, meta) VALUES (?, ?, ?, ?)',
      args: [telegramId, 'referral_claim', REFERRAL_BASE_REWARD, JSON.stringify({})],
    });

    const updatedRes = await tx.execute({
      sql: 'SELECT * FROM users WHERE telegram_id = ?',
      args: [telegramId],
    });
    await tx.commit();

    const updated = updatedRes.rows[0];
    return {
      main_balance: updated.main_balance,
      pending_referral_balance: updated.pending_referral_balance,
      daily_ref_claims_count: updated.daily_ref_claims_count,
      claims_remaining_today: DAILY_CLAIM_CAP - updated.daily_ref_claims_count,
    };
  } catch (err) {
    await tx.rollback().catch(() => {});
    throw err;
  }
}

module.exports = {
  grantReferral,
  maybeQualifyReferral,
  reconcileStuckReferrals,
  prepareClaim,
  claimReferral,
  DAILY_CLAIM_CAP,
  COOLDOWN_SECONDS,
};
