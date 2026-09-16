const express = require('express');
const { telegramAuth } = require('../middleware/telegramAuth');
const { getTopReferrers } = require('../services/leaderboardService');
const { getCurrentContestStatus } = require('../services/miningContestService');

const router = express.Router();

router.get('/top', telegramAuth, async (req, res) => {
  try {
    const result = await getTopReferrers({ telegramId: req.telegramUser.id });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(err.statusCode || 500).json({ ok: false, error: err.message });
  }
});

// Live Mining Contest standings (activity-based — see
// miningContestService.js) for the Ranks tab. `contest: null` when
// none is currently running — the frontend just hides that section.
router.get('/mining-contest', telegramAuth, async (req, res) => {
  try {
    const contest = await getCurrentContestStatus({ telegramId: req.telegramUser.id });
    res.json({ ok: true, contest });
  } catch (err) {
    res.status(err.statusCode || 500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
