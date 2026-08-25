const express = require('express');
const { adminAuth } = require('../middleware/adminAuth');
const {
  listPendingWithdrawals,
  completeWithdrawal,
  rejectWithdrawal,
} = require('../services/withdrawalService');

const router = express.Router();
router.use(adminAuth);

router.get('/withdrawals/pending', async (req, res) => {
  try {
    res.json({ ok: true, withdrawals: await listPendingWithdrawals() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/withdrawal/complete', async (req, res) => {
  const { withdrawal_id, tx_hash } = req.body;
  try {
    const withdrawal = await completeWithdrawal({ withdrawalId: withdrawal_id, txHash: tx_hash });
    res.json({ ok: true, withdrawal });
  } catch (err) {
    res.status(err.statusCode || 500).json({ ok: false, error: err.message });
  }
});

// Not one of the 5 spec'd endpoints, but PENDING withdrawals need a reject
// path too — otherwise an invalid/fraudulent request permanently locks the
// user's points with no resolution.
router.post('/withdrawal/reject', async (req, res) => {
  const { withdrawal_id, reason } = req.body;
  try {
    const withdrawal = await rejectWithdrawal({ withdrawalId: withdrawal_id, reason });
    res.json({ ok: true, withdrawal });
  } catch (err) {
    res.status(err.statusCode || 500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
