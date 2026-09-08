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
  const [referralReward, requiredCycles] = await Promise.all([
    getSetting('referral_reward'),
    getSetting('referral_qualify_miner_cycles'),
  ]);
  try {
    const [userRes, totalRes, successfulRes, pendingQualRes] = await Promise.all([
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
      // ADDED: referrals that exist (referred_by is set) but haven't yet
      // cleared qualification (referral_qualify_miner_cycles /
      // referral_require_channel_join) — these are the ones "stuck" in
      // Friends.jsx's team list with no commission counted yet. Powers
      // the "locked" bonus preview card so the referrer can see what's
      // waiting on the other person to actually mine, rather than it
      // silently earning nothing with no explanation on the frontend.
      client.execute({
        sql: 'SELECT COUNT(*) as cnt FROM users WHERE referred_by = ? AND referral_qualified = 0',
        args: [telegramId],
      }),
    ]);

    const user = userRes.rows[0];
    const pendingQualificationCount = Number(pendingQualRes.rows[0].cnt);
    res.json({
      ok: true,
      ...user,
      total_referrals: Number(totalRes.rows[0].cnt),
      successful_referrals: Number(successfulRes.rows[0].cnt),
      available_claims: Math.floor((user.pending_referral_balance || 0) / referralReward),
      reward_per_claim: referralReward,
      // Not real, unlocked balance — an estimate of what moves into
      // pending_referral_balance once each of these referrals hits
      // referral_qualify_miner_cycles mining cycles. Shown separately
      // in the UI so it's never confused with claimable points.
      pending_qualification_count: pendingQualificationCount,
      locked_referral_bonus_estimate: pendingQualificationCount * referralReward,
      referral_qualify_miner_cycles: requiredCycles,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Real list of directly-referred users, most recent first — powers the
// "Latest invited friends" section. Only username + join date, nothing
// else about them is exposed here — plus (ADDED) referral_qualified and
// total_miner_cycles_completed, so the frontend can show each invited
// friend as active vs. still-pending-activation instead of implying
// they're all already earning commission.
router.get('/invited', telegramAuth, async (req, res) => {
  try {
    const [res_, requiredCycles] = await Promise.all([
      client.execute({
        sql: `SELECT telegram_id, username, created_at, referral_qualified,
                     total_miner_cycles_completed
              FROM users
              WHERE referred_by = ? ORDER BY created_at DESC LIMIT 50`,
        args: [req.telegramUser.id],
      }),
      getSetting('referral_qualify_miner_cycles'),
    ]);
    res.json({ ok: true, invited: res_.rows, referral_qualify_miner_cycles: requiredCycles });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
