const express = require('express');
const { telegramAuth } = require('../middleware/telegramAuth');
const { client } = require('../db/db');
const { getAllSettings } = require('../utils/settings');

const router = express.Router();

// The frontend calls this once on load so it shows your REAL balance
// instead of starting from 0 and only catching up after some action
// (spin/claim/withdrawal) happens to return a fresh number.
router.get('/me', telegramAuth, async (req, res) => {
  try {
    const result = await client.execute({
      sql: 'SELECT telegram_id, username, main_balance, wallet_address FROM users WHERE telegram_id = ?',
      args: [req.telegramUser.id],
    });
    res.json({ ok: true, ...result.rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Lets the frontend render correct $ amounts and copy (points_per_usd,
// referral_reward, miner_daily_points, etc.) WITHOUT hardcoding numbers
// that can drift the moment an admin changes them via the admin panel.
router.get('/config', telegramAuth, async (req, res) => {
  try {
    res.json({ ok: true, ...(await getAllSettings()) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
