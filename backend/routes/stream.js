const express = require('express');
const { telegramAuth } = require('../middleware/telegramAuth');
const { getRecentActivity } = require('../services/streamService');

const router = express.Router();

router.get('/recent', telegramAuth, async (req, res) => {
  try {
    const activity = await getRecentActivity({});
    res.json({ ok: true, activity });
  } catch (err) {
    res.status(err.statusCode || 500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
