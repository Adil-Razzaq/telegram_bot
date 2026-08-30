const express = require('express');
const { telegramAuth } = require('../middleware/telegramAuth');
const { connectWallet, disconnectWallet } = require('../services/walletService');

const router = express.Router();

router.post('/connect', telegramAuth, async (req, res) => {
  const { address } = req.body;
  try {
    const result = await connectWallet({ telegramId: req.telegramUser.id, address });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(err.statusCode || 500).json({ ok: false, error: err.message });
  }
});

router.post('/disconnect', telegramAuth, async (req, res) => {
  try {
    await disconnectWallet({ telegramId: req.telegramUser.id });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
