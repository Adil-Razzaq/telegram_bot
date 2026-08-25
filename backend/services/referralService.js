const { client, rolloverUserRefCounterIfNeeded } = require('../db/db');
const { verifyAdCompletion } = require('../utils/adsgram');

const REFERRAL_BASE_REWARD = 500;
const DAILY_CLAIM_CAP = 20; // 20 * 500 = 10,000 pts/day, matches spec
const COOLDOWN_SECONDS = 60;

/**
 * Grants the base 500-point referral reward into the REFERRER's
 * pending_referral_balance when a new user they invited signs up.
 *
 * The spec's 5 listed endpoints don't include a "register referral" route,
 * but something has to call this — otherwise pending_referral_balance
 * never has anything in it to claim. The natural place is your bot's
 * /start handler: when a new user starts the bot via a
 * `t.me/YourBot?start=ref_<referrerId>` deep link, call this once for
 * that referrer, guarded so the same referred user can't trigger it twice.
 */
async function grantReferral({ referrerId, referredTelegramId }) {
  const tx = await client.transaction('write');
  try {
    const referrerRes = await tx.execute({
      sql: 'SELECT * FROM users WHERE telegram_id = ?',
      args: [referrerId],
    });
    const referrer = referrerRes.rows[0];
    if (!referrer) {
      const err = new Error('Referrer not found');
      err.statusCode = 404;
      throw err;
    }

    // Prevent double-crediting the same referred user twice: one ledger
    // row per (referrer, referred) pair, checked via meta.
    const metaStr = JSON.stringify({ referredTelegramId });
    const alreadyRes = await tx.execute({
      sql: `SELECT 1 FROM ledger WHERE telegram_id = ? AND type = 'referral_grant' AND meta = ?`,
      args: [referrerId, metaStr],
    });
    if (alreadyRes.rows[0]) {
      const err = new Error('This referral has already been credited');
      err.statusCode = 409;
      throw err;
    }

    await tx.execute({
      sql: 'UPDATE users SET pending_referral_balance = pending_referral_balance + ? WHERE telegram_id = ?',
      args: [REFERRAL_BASE_REWARD, referrerId],
    });
    await tx.execute({
      sql: 'INSERT INTO ledger (telegram_id, type, points_delta, meta) VALUES (?, ?, ?, ?)',
      args: [referrerId, 'referral_grant', REFERRAL_BASE_REWARD, metaStr],
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

async function claimReferral({ telegramId, adToken }) {
  await rolloverUserRefCounterIfNeeded(telegramId);

  const adCheck = verifyAdCompletion({ telegramId, adToken, purpose: 'referral_claim' });
  if (!adCheck.ok) {
    const err = new Error(`Ad verification failed: ${adCheck.reason}`);
    err.statusCode = 400;
    throw err;
  }

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
    if (user.last_ref_claim_at) {
      const elapsed = (Date.now() - new Date(user.last_ref_claim_at).getTime()) / 1000;
      if (elapsed < COOLDOWN_SECONDS) {
        const err = new Error(
          `Cooldown active — try again in ${Math.ceil(COOLDOWN_SECONDS - elapsed)}s`
        );
        err.statusCode = 429;
        throw err;
      }
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

module.exports = { grantReferral, claimReferral, REFERRAL_BASE_REWARD, DAILY_CLAIM_CAP, COOLDOWN_SECONDS };
