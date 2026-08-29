const express = require('express');
const { telegramAuth } = require('../middleware/telegramAuth');
const { getStatus, claim } = require('../services/minerService');

const router = express.Router();

router.get('/status', telegramAuth, async (req, res) => {
  try {
    const status = await getStatus({ telegramId: req.telegramUser.id });
    res.json({ ok: true, ...status });
  } catch (err) {
    res.status(err.statusCode || 500).json({ ok: false, error: err.message });
  }
});

router.post('/claim', telegramAuth, async (req, res) => {
  try {
    const result = await claim({ telegramId: req.telegramUser.id });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(err.statusCode || 500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
