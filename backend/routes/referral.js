const express = require('express');
const { telegramAuth } = require('../middleware/telegramAuth');
const { prepareClaim, claimReferral, grantReferral } = require('../services/referralService');
const { client } = require('../db/db');
const { getSetting } = require('../utils/settings');

const router = express.Router();

// Same two-step flow as spin: get a nonce, show the ad, then claim.
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
    const result = await claimReferral({ telegramId: req.telegramUser.id, nonce });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(err.statusCode || 500).json({ ok: false, error: err.message });
  }
});

// Granting normally happens via routes/bot.js when a referred user
// sends /start (needs the Telegram webhook registered — see
// DEPLOYMENT.md). This is a second, independent path that doesn't
// depend on that webhook at all: the frontend calls this once on load
// if Telegram handed it a start_param (see App.jsx + Friends.jsx's
// startapp= link format). Idempotent via users.referred_by, same as
// the webhook path — safe to call on every load, silently a no-op if
// this user is already referred or this fails validation.
router.post('/register', telegramAuth, async (req, res) => {
  const referrerId = Number(req.body?.referrer_id);
  if (!Number.isFinite(referrerId)) {
    return res.status(400).json({ ok: false, error: 'referrer_id required' });
  }
  try {
    const result = await grantReferral({ referrerId, referredTelegramId: req.telegramUser.id });
    res.json({ ok: true, ...result });
  } catch (err) {
    // Self-referral and "already referred" are expected, harmless
    // outcomes here (this can get called on every app load) — not
    // real errors worth surfacing to the user.
    res.json({ ok: true, skipped: err.message });
  }
});

router.get('/status', telegramAuth, async (req, res) => {
  const telegramId = req.telegramUser.id;
  const referralReward = await getSetting('referral_reward');
  try {
    const [userRes, totalRes, successfulRes] = await Promise.all([
      client.execute({
        sql: 'SELECT pending_referral_balance, daily_ref_claims_count, last_ref_claim_at, referred_by FROM users WHERE telegram_id = ?',
        args: [telegramId],
      }),
      client.execute({
        sql: 'SELECT COUNT(*) as cnt FROM users WHERE referred_by = ?',
        args: [telegramId],
      }),
      // "Successful" = referred users who've done at least one real
      // point-earning action (spin, task, miner claim, etc.) — proof
      // they're a genuine active user, not just a raw signup. There's
      // no other natural definition available with the data this app
      // tracks; flagging that choice explicitly rather than silently
      // picking one.
      client.execute({
        sql: `SELECT COUNT(DISTINCT u.telegram_id) as cnt
              FROM users u
              JOIN ledger l ON l.telegram_id = u.telegram_id
              WHERE u.referred_by = ? AND l.type != 'referral_grant'`,
        args: [telegramId],
      }),
    ]);

    const user = userRes.rows[0];
    res.json({
      ok: true,
      ...user,
      total_referrals: Number(totalRes.rows[0].cnt),
      successful_referrals: Number(successfulRes.rows[0].cnt),
      available_claims: Math.floor((user.pending_referral_balance || 0) / referralReward),
      reward_per_claim: referralReward,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Real list of directly-referred users, most recent first — powers the
// "Latest invited friends" section. Only username + join date, nothing
// else about them is exposed here.
router.get('/invited', telegramAuth, async (req, res) => {
  try {
    const res_ = await client.execute({
      sql: `SELECT telegram_id, username, created_at FROM users
            WHERE referred_by = ? ORDER BY created_at DESC LIMIT 50`,
      args: [req.telegramUser.id],
    });
    res.json({ ok: true, invited: res_.rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
