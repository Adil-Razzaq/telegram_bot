const express = require('express');
const { telegramAuth } = require('../middleware/telegramAuth');
const { requestWithdrawal, listWithdrawalsForUser } = require('../services/withdrawalService');

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

module.exports = router;
