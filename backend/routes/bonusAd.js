const express = require('express');
const { telegramAuth } = require('../middleware/telegramAuth');
const { prepareBonusAd, claimBonusAd } = require('../services/bonusAdService');

const router = express.Router();

// Same two-step pattern as everything else: get a nonce, show the ad,
// then claim. Nothing else in the app depends on this — it's purely
// optional, which is what keeps the app's core actions (spin, miner,
// referral status) usable with zero ads involved.
router.post('/prepare', telegramAuth, async (req, res) => {
  try {
    const nonce = await prepareBonusAd({ telegramId: req.telegramUser.id });
    res.json({ ok: true, nonce });
  } catch (err) {
    res.status(err.statusCode || 500).json({ ok: false, error: err.message });
  }
});

router.post('/claim', telegramAuth, async (req, res) => {
  const { nonce } = req.body;
  try {
    const result = await claimBonusAd({ telegramId: req.telegramUser.id, nonce });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(err.statusCode || 500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
