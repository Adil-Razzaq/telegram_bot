const express = require('express');
const { telegramAuth } = require('../middleware/telegramAuth');
const { claimReferral, grantReferral } = require('../services/referralService');
const { client } = require('../db/db');

const router = express.Router();

router.post('/claim', telegramAuth, async (req, res) => {
  const { adToken } = req.body;
  try {
    const result = await claimReferral({ telegramId: req.telegramUser.id, adToken });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(err.statusCode || 500).json({ ok: false, error: err.message });
  }
});

// Not one of the 5 spec'd endpoints, but needed so referral rewards have a
// way to be granted in the first place — call this from your bot's /start
// handler when a user arrives via a `?start=ref_<referrerId>` deep link.
router.post('/register', telegramAuth, async (req, res) => {
  const { referrerId } = req.body;
  const referredTelegramId = req.telegramUser.id;

  if (!referrerId || Number(referrerId) === referredTelegramId) {
    return res.status(400).json({ ok: false, error: 'Invalid or self-referral' });
  }

  try {
    const result = await grantReferral({ referrerId: Number(referrerId), referredTelegramId });
    res.json({ ok: true, referrer_pending_balance: result.pending_referral_balance });
  } catch (err) {
    res.status(err.statusCode || 500).json({ ok: false, error: err.message });
  }
});

router.get('/status', telegramAuth, async (req, res) => {
  try {
    const result = await client.execute({
      sql: 'SELECT pending_referral_balance, daily_ref_claims_count, last_ref_claim_at FROM users WHERE telegram_id = ?',
      args: [req.telegramUser.id],
    });
    res.json({ ok: true, ...result.rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
