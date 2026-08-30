const express = require('express');
const { telegramAuth } = require('../middleware/telegramAuth');
const { prepareSpin, playSpin } = require('../services/spinService');

const router = express.Router();

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
