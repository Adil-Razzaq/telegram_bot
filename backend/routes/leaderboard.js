const express = require('express');
const { telegramAuth } = require('../middleware/telegramAuth');
const { getTopReferrers } = require('../services/leaderboardService');

const router = express.Router();

router.get('/top', telegramAuth, async (req, res) => {
  try {
    const result = await getTopReferrers({ telegramId: req.telegramUser.id });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(err.statusCode || 500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
