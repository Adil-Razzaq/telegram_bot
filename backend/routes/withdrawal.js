const express = require('express');
const { telegramAuth } = require('../middleware/telegramAuth');
const { requestWithdrawal, listWithdrawalsForUser } = require('../services/withdrawalService');
const { getFlag } = require('../utils/featureFlags');

const router = express.Router();

// The frontend checks this before rendering the withdrawal form, to show
// the "coming soon" state with your custom message instead of a form
// that would just fail. The real enforcement is still server-side in
// requestWithdrawal — this is only what decides what the UI shows.
router.get('/status', telegramAuth, async (req, res) => {
  try {
    const flag = await getFlag('withdrawal');
    res.json({ ok: true, enabled: flag.enabled, message: flag.message });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

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
