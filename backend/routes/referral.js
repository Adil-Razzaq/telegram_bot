const express = require('express');
const { telegramAuth } = require('../middleware/telegramAuth');
const { claimReferral } = require('../services/referralService');
const { client } = require('../db/db');

const router = express.Router();

router.post('/claim', telegramAuth, async (req, res) => {
  try {
    const result = await claimReferral({ telegramId: req.telegramUser.id });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(err.statusCode || 500).json({ ok: false, error: err.message });
  }
});

// Granting now happens automatically in routes/bot.js when a referred
// user sends /start — nothing needs to call this from the frontend.
router.get('/status', telegramAuth, async (req, res) => {
  try {
    const result = await client.execute({
      sql: 'SELECT pending_referral_balance, daily_ref_claims_count, last_ref_claim_at, referred_by FROM users WHERE telegram_id = ?',
      args: [req.telegramUser.id],
    });
    res.json({ ok: true, ...result.rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
