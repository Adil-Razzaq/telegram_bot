const express = require('express');
const { telegramAuth } = require('../middleware/telegramAuth');
const { prepareSpin, playSpin, getSpinConfigForUser } = require('../services/spinService');

const router = express.Router();

// Current payouts, entry fee, and this user's free-spins-remaining —
// fetched by the frontend on load so the wheel's labels and cost text
// always reflect whatever's actually configured via the admin panel,
// not stale values baked into the frontend bundle at build time.
router.get('/config', telegramAuth, async (req, res) => {
  try {
    const config = await getSpinConfigForUser({ telegramId: req.telegramUser.id });
    res.json({ ok: true, ...config });
  } catch (err) {
    res.status(err.statusCode || 500).json({ ok: false, error: err.message });
  }
});

// Call this first — returns a nonce to pass as `ymid` when showing the
// Monetag ad, and back to /play once the ad is confirmed watched.
router.post('/prepare', telegramAuth, async (req, res) => {
  try {
    const nonce = await prepareSpin({ telegramId: req.telegramUser.id });
    res.json({ ok: true, nonce });
  } catch (err) {
    res.status(err.statusCode || 500).json({ ok: false, error: err.message });
  }
});

router.post('/play', telegramAuth, async (req, res) => {
  const { nonce } = req.body;
  try {
    const result = await playSpin({ telegramId: req.telegramUser.id, nonce });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(err.statusCode || 500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
