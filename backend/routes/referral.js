const express = require('express');
const { telegramAuth } = require('../middleware/telegramAuth');
const { prepareClaim, claimReferral, REFERRAL_BASE_REWARD } = require('../services/referralService');
const { client } = require('../db/db');

const router = express.Router();

// Same two-step flow as spin: get a nonce, show the ad, then claim.
router.post('/prepare-claim', telegramAuth, async (req, res) => {
  try {
    const nonce = await prepareClaim({ telegramId: req.telegramUser.id });
    res.json({ ok: true, nonce });
  } catch (err) {
    res.status(err.statusCode || 500).json({ ok: false, error: err.message });
  }
});

router.post('/claim', telegramAuth, async (req, res) => {
  const { nonce } = req.body;
  try {
    const result = await claimReferral({ telegramId: req.telegramUser.id, nonce });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(err.statusCode || 500).json({ ok: false, error: err.message });
  }
});

// Granting happens automatically in routes/bot.js when a referred user
// sends /start — nothing needs to call this from the frontend.
router.get('/status', telegramAuth, async (req, res) => {
  const telegramId = req.telegramUser.id;
  try {
    const [userRes, totalRes, successfulRes] = await Promise.all([
      client.execute({
        sql: 'SELECT pending_referral_balance, daily_ref_claims_count, last_ref_claim_at, referred_by FROM users WHERE telegram_id = ?',
        args: [telegramId],
      }),
      client.execute({
        sql: 'SELECT COUNT(*) as cnt FROM users WHERE referred_by = ?',
        args: [telegramId],
      }),
      // "Successful" = referred users who've done at least one real
      // point-earning action (spin, task, miner claim, etc.) — proof
      // they're a genuine active user, not just a raw signup. There's
      // no other natural definition available with the data this app
      // tracks; flagging that choice explicitly rather than silently
      // picking one.
      client.execute({
        sql: `SELECT COUNT(DISTINCT u.telegram_id) as cnt
              FROM users u
              JOIN ledger l ON l.telegram_id = u.telegram_id
              WHERE u.referred_by = ? AND l.type != 'referral_grant'`,
        args: [telegramId],
      }),
    ]);

    const user = userRes.rows[0];
    res.json({
      ok: true,
      ...user,
      total_referrals: Number(totalRes.rows[0].cnt),
      successful_referrals: Number(successfulRes.rows[0].cnt),
      available_claims: Math.floor((user.pending_referral_balance || 0) / REFERRAL_BASE_REWARD),
      reward_per_claim: REFERRAL_BASE_REWARD,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
