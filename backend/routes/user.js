const express = require('express');
const { telegramAuth } = require('../middleware/telegramAuth');
const { client } = require('../db/db');
const { getAllSettings, getSetting } = require('../utils/settings');
const { getFlag } = require('../utils/featureFlags');
const { checkOfficialChannelsMembership } = require('../services/taskService');

const router = express.Router();

// The frontend calls this once on load so it shows your REAL balance
// instead of starting from 0 and only catching up after some action
// (spin/claim/withdrawal) happens to return a fresh number.
router.get('/me', telegramAuth, async (req, res) => {
  try {
    const result = await client.execute({
      sql: 'SELECT telegram_id, username, main_balance, wallet_address FROM users WHERE telegram_id = ?',
      args: [req.telegramUser.id],
    });
    res.json({ ok: true, ...result.rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Lets the frontend render correct $ amounts and copy (points_per_usd,
// referral_reward, miner_daily_points, etc.) WITHOUT hardcoding numbers
// that can drift the moment an admin changes them via the admin panel.
// Also carries the withdrawals feature flag so Profile can show the
// admin's custom maintenance/coming-soon message and disable the
// Withdraw button, without a separate round-trip.
router.get('/config', telegramAuth, async (req, res) => {
  try {
    const [settings, withdrawalsFlag, spinFlag] = await Promise.all([
      getAllSettings(),
      getFlag('withdrawals'),
      getFlag('spin'),
    ]);
    res.json({ ok: true, ...settings, withdrawals: withdrawalsFlag, spin_enabled: spinFlag.enabled });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// App-open hard gate: blocks ALL app usage (not just one action, unlike
// the referral/withdrawal channel gates) until every channel in
// official_channels is joined. Called once on app mount, and again
// whenever the user taps "I've Joined — Verify".
router.get('/channel-gate-status', telegramAuth, async (req, res) => {
  try {
    const required = await getSetting('app_open_require_channel_join');
    if (!required) {
      return res.json({ ok: true, gate: { required: false, joined: true, channels: [] } });
    }

    let membership;
    try {
      membership = await checkOfficialChannelsMembership(req.telegramUser.id);
    } catch (err) {
      // Deliberately DIFFERENT from the referral/withdrawal gates' fail-
      // CLOSED behavior on a verification error (bot not admin of the
      // channel, network hiccup, etc.) — those only block one action,
      // but this one blocks the ENTIRE app, so a Telegram API problem
      // or a misconfigured channel here must never lock every single
      // user out. Fails OPEN instead, and logs loudly so the admin
      // still finds out and can fix the channel config.
      console.error('channel-gate-status: verification error, failing OPEN:', err.message);
      return res.json({ ok: true, gate: { required: false, joined: true, channels: [], verification_error: err.message } });
    }

    const channels = membership.required.map((id) => ({
      id,
      // Only a bare "@username" can become a direct t.me join link —
      // numeric IDs (private channels/supergroups) have no public join
      // URL we can construct from the ID alone.
      join_url: id.startsWith('@') ? `https://t.me/${id.slice(1)}` : null,
      joined: !membership.missing.includes(id),
    }));

    res.json({ ok: true, gate: { required: true, joined: membership.joined, channels } });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
