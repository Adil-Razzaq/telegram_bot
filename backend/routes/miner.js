const express = require('express');
const { telegramAuth } = require('../middleware/telegramAuth');
const { getStatus, prepareStart, startCycle, prepareClaim, claim } = require('../services/minerService');

const router = express.Router();

router.get('/status', telegramAuth, async (req, res) => {
  try {
    const status = await getStatus({ telegramId: req.telegramUser.id });
    res.json({ ok: true, ...status });
  } catch (err) {
    res.status(err.statusCode || 500).json({ ok: false, error: err.message });
  }
});

router.post('/prepare-start', telegramAuth, async (req, res) => {
  try {
    const nonce = await prepareStart({ telegramId: req.telegramUser.id });
    res.json({ ok: true, nonce });
  } catch (err) {
    res.status(err.statusCode || 500).json({ ok: false, error: err.message });
  }
});

router.post('/start', telegramAuth, async (req, res) => {
  const { nonce } = req.body;
  try {
    const status = await startCycle({ telegramId: req.telegramUser.id, nonce });
    res.json({ ok: true, ...status });
  } catch (err) {
    res.status(err.statusCode || 500).json({ ok: false, error: err.message });
  }
});

// Claim is now ad-gated too, same two-step pattern as start.
router.post('/prepare-claim', telegramAuth, async (req, res) => {
  try {
    const nonce = await prepareClaim({ telegramId: req.telegramUser.id });
    res.json({ ok: true, nonce });
  } catch (err) {
    res.status(err.statusCode || 500).json({ ok: false, error: err.message });
  }
});

router.post('/claim', telegramAuth, async (req, res) => {
  const { nonce } = req.body;
  try {
    const result = await claim({ telegramId: req.telegramUser.id, nonce });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(err.statusCode || 500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
