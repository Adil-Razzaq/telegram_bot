const express = require('express');
const { telegramAuth } = require('../middleware/telegramAuth');
const { getStatus, prepareClaim, claim } = require('../services/streakService');

const router = express.Router();

router.get('/status', telegramAuth, async (req, res) => {
  try {
    const status = await getStatus({ telegramId: req.telegramUser.id });
    res.json({ ok: true, ...status });
  } catch (err) {
    res.status(err.statusCode || 500).json({ ok: false, error: err.message });
  }
});

router.post('/prepare', telegramAuth, async (req, res) => {
  const { network } = req.body;
  if (network !== 'monetag' && network !== 'adsgram') {
    return res.status(400).json({ ok: false, error: "network must be 'monetag' or 'adsgram'" });
  }
  try {
    const nonce = await prepareClaim({ telegramId: req.telegramUser.id, network });
    res.json({ ok: true, nonce });
  } catch (err) {
    res.status(err.statusCode || 500).json({ ok: false, error: err.message });
  }
});

router.post('/claim', telegramAuth, async (req, res) => {
  const { network, nonce } = req.body;
  if (network !== 'monetag' && network !== 'adsgram') {
    return res.status(400).json({ ok: false, error: "network must be 'monetag' or 'adsgram'" });
  }
  try {
    const result = await claim({ telegramId: req.telegramUser.id, network, nonce });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(err.statusCode || 500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
