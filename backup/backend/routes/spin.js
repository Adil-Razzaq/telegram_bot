const express = require('express');
const { telegramAuth } = require('../middleware/telegramAuth');
const { playSpin } = require('../services/spinService');

const router = express.Router();

router.post('/play', telegramAuth, async (req, res) => {
  const { adToken } = req.body;
  try {
    const result = await playSpin({ telegramId: req.telegramUser.id, adToken });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(err.statusCode || 500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
