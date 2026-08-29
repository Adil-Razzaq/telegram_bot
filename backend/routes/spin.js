const express = require('express');
const { telegramAuth } = require('../middleware/telegramAuth');
const { playSpin } = require('../services/spinService');

const router = express.Router();

// No ad required — spin runs on the entry fee alone. See the comment on
// ENTRY_FEE in services/spinService.js for why this changed.
router.post('/play', telegramAuth, async (req, res) => {
  try {
    const result = await playSpin({ telegramId: req.telegramUser.id });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(err.statusCode || 500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
