const { client, rolloverUserRefCounterIfNeeded } = require('../db/db');
const { startAdEvent, consumeAdEvent } = require('../utils/monetagAds');

const REFERRAL_BASE_REWARD = 500;
const DAILY_CLAIM_CAP = 20;
const COOLDOWN_SECONDS = 60;

// Called from the bot's /start handler (routes/bot.js) the moment a
// referred user first opens the bot — this is what was missing before:
// nothing was ever calling this, so no referral was ever credited no
// matter how correct the claim/cooldown logic downstream was.
// Idempotent via users.referred_by: a user can only ever be credited to
// one referrer, once, no matter how many times /start fires for them.
async function grantReferral({ referrerId, referredTelegramId }) {
  if (referrerId === referredTelegramId) {
    const err = new Error('Self-referral is not allowed');
    err.statusCode = 400;
    throw err;
  }

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
    await tx.execute({
      sql: 'UPDATE users SET pending_referral_balance = pending_referral_balance + ? WHERE telegram_id = ?',
      args: [REFERRAL_BASE_REWARD, referrerId],
    });
    await tx.execute({
      sql: 'INSERT INTO ledger (telegram_id, type, points_delta, meta) VALUES (?, ?, ?, ?)',
      args: [referrerId, 'referral_grant', REFERRAL_BASE_REWARD, JSON.stringify({ referredTelegramId })],
    });

    const updatedRes = await tx.execute({
      sql: 'SELECT * FROM users WHERE telegram_id = ?',
      args: [referrerId],
    });
    await tx.commit();
    return updatedRes.rows[0];
  } catch (err) {
    await tx.rollback().catch(() => {});
    throw err;
  }
}

async function prepareClaim({ telegramId }) {
  return startAdEvent({ telegramId, action: 'referral_claim' });
}

async function claimReferral({ telegramId, nonce }) {
  await rolloverUserRefCounterIfNeeded(telegramId);
  await consumeAdEvent({ nonce, telegramId, action: 'referral_claim' });

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

module.exports = { grantReferral, prepareClaim, claimReferral, REFERRAL_BASE_REWARD, DAILY_CLAIM_CAP, COOLDOWN_SECONDS };
