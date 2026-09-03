const express = require('express');
const { telegramAuth } = require('../middleware/telegramAuth');
const { requestWithdrawal, listWithdrawalsForUser, getRecentPayouts } = require('../services/withdrawalService');

const router = express.Router();

router.post('/request', telegramAuth, async (req, res) => {
  const { address, points } = req.body;
  try {
    const withdrawal = await requestWithdrawal({
      telegramId: req.telegramUser.id,
      address,
      points: Number(points),
    });
    res.json({ ok: true, withdrawal });
  } catch (err) {
    res.status(err.statusCode || 500).json({ ok: false, error: err.message });
  }
});

router.get('/history', telegramAuth, async (req, res) => {
  try {
    const rows = await listWithdrawalsForUser(req.telegramUser.id);
    res.json({ ok: true, withdrawals: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Public payout proof board — see the comment on getRecentPayouts in
// withdrawalService.js for why this exists.
router.get('/recent-payouts', telegramAuth, async (req, res) => {
  try {
    const payouts = await getRecentPayouts({});
    res.json({ ok: true, payouts });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
