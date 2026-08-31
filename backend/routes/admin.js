const express = require('express');
const { adminAuth } = require('../middleware/adminAuth');
const { sendTelegramMessage } = require('../utils/telegram');
const { client } = require('../db/db');
const { createTask, listAllTasksAdmin, setTaskActive, updateTask, deleteTask } = require('../services/taskService');
const { getAllSettings, setSetting, DEFAULTS } = require('../utils/settings');
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

// One-button test for WITHDRAWAL_ANNOUNCE_CHANNEL — hit this instead of
// waiting on a real withdrawal to find out if the channel setup works.
// Whatever's wrong (bot not an admin, wrong username, channel doesn't
// exist) comes back directly in the response now that utils/telegram.js
// actually checks Telegram's response instead of ignoring it.
router.post('/test-announce', async (req, res) => {
  const channel = process.env.WITHDRAWAL_ANNOUNCE_CHANNEL;
  if (!channel) {
    return res.status(400).json({ ok: false, error: 'WITHDRAWAL_ANNOUNCE_CHANNEL is not set in .env' });
  }
  try {
    await sendTelegramMessage(channel, '✅ Test message — if you can see this, announcements are working.');
    res.json({ ok: true, message: `Sent to ${channel} successfully` });
  } catch (err) {
    res.status(500).json({ ok: false, channel, error: err.message });
  }
});

// Manually adjust a user's balance (positive to add, negative to deduct).
// Atomic + ledger-logged with your reason attached — this is the correct
// way to do this instead of editing the database directly, same reason
// the withdrawal completion has to go through its own endpoint: a raw
// edit leaves no record of why the balance changed.
router.post('/adjust-balance', async (req, res) => {
  const { telegram_id, points_delta, reason } = req.body;
  const telegramId = Number(telegram_id);
  const delta = Number(points_delta);

  if (!telegramId || !Number.isInteger(delta) || delta === 0) {
    return res.status(400).json({
      ok: false,
      error: 'telegram_id and a non-zero integer points_delta are required',
    });
  }

  const tx = await client.transaction('write');
  try {
    const userRes = await tx.execute({
      sql: 'SELECT main_balance FROM users WHERE telegram_id = ?',
      args: [telegramId],
    });
    if (!userRes.rows[0]) {
      const err = new Error('User not found — they need to have opened the app at least once');
      err.statusCode = 404;
      throw err;
    }
    if (userRes.rows[0].main_balance + delta < 0) {
      const err = new Error('This would take the balance below zero');
      err.statusCode = 400;
      throw err;
    }

    await tx.execute({
      sql: 'UPDATE users SET main_balance = main_balance + ? WHERE telegram_id = ?',
      args: [delta, telegramId],
    });
    await tx.execute({
      sql: 'INSERT INTO ledger (telegram_id, type, points_delta, meta) VALUES (?, ?, ?, ?)',
      args: [telegramId, 'admin_adjustment', delta, JSON.stringify({ reason: reason || null })],
    });

    const updatedRes = await tx.execute({
      sql: 'SELECT main_balance FROM users WHERE telegram_id = ?',
      args: [telegramId],
    });
    await tx.commit();
    res.json({ ok: true, telegram_id: telegramId, new_balance: updatedRes.rows[0].main_balance });
  } catch (err) {
    await tx.rollback().catch(() => {});
    res.status(err.statusCode || 500).json({ ok: false, error: err.message });
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

// Add a new task — this is the "one command" way to add tasks without
// touching code. task_type defaults to 'generic' (honor-system, no real
// verification available) — pass "telegram_join" + telegram_channel_id
// for a Join-Channel task, which IS verified for real against Telegram's
// API when the user claims it.
router.post('/tasks', async (req, res) => {
  const { title, reward_points, link_url, task_type, telegram_channel_id, icon, sort_order } = req.body;
  const needsLink = task_type !== 'watch_ad';
  if (!title || !reward_points || (needsLink && !link_url)) {
    return res.status(400).json({
      ok: false,
      error: needsLink ? 'title, reward_points, and link_url are required' : 'title and reward_points are required',
    });
  }
  try {
    const result = await createTask({
      title,
      rewardPoints: Number(reward_points),
      linkUrl: link_url,
      taskType: task_type,
      telegramChannelId: telegram_channel_id,
      icon,
      sortOrder: sort_order,
    });
    res.json({ ok: true, task_id: result.id });
  } catch (err) {
    res.status(err.statusCode || 500).json({ ok: false, error: err.message });
  }
});

router.get('/tasks', async (req, res) => {
  try {
    res.json({ ok: true, tasks: await listAllTasksAdmin() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/tasks/:id/deactivate', async (req, res) => {
  try {
    await setTaskActive({ taskId: Number(req.params.id), active: false });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/tasks/:id/activate', async (req, res) => {
  try {
    await setTaskActive({ taskId: Number(req.params.id), active: true });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.patch('/tasks/:id', async (req, res) => {
  try {
    await updateTask({ taskId: Number(req.params.id), ...req.body });
    res.json({ ok: true });
  } catch (err) {
    res.status(err.statusCode || 500).json({ ok: false, error: err.message });
  }
});

router.delete('/tasks/:id', async (req, res) => {
  try {
    await deleteTask({ taskId: Number(req.params.id) });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- Settings: every admin-tunable number (point value, referral
// reward, miner timing/payout) in one place.
router.get('/settings', async (req, res) => {
  try {
    res.json({ ok: true, settings: await getAllSettings({ forceRefresh: true }), known_keys: Object.keys(DEFAULTS) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/settings', async (req, res) => {
  const updates = req.body || {};
  const keys = Object.keys(updates);
  if (keys.length === 0) {
    return res.status(400).json({ ok: false, error: 'Provide at least one setting, e.g. {"referral_reward": 100}' });
  }
  try {
    for (const key of keys) await setSetting(key, updates[key]);
    res.json({ ok: true, settings: await getAllSettings({ forceRefresh: true }) });
  } catch (err) {
    res.status(err.statusCode || 500).json({ ok: false, error: err.message });
  }
});

// --- Ad revenue: answers "how much did this click actually earn" and
// "what's my real average CPM" straight from the raw postback log,
// independent of the reward-gating logic in pending_ad_events.
router.get('/ad-revenue', async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 500);
    const recentRes = await client.execute({
      sql: `SELECT ymid, telegram_id_macro, zone_id, event_type, reward_event_type, estimated_price, matched_pending_event, received_at
            FROM ad_postback_log ORDER BY received_at DESC LIMIT ?`,
      args: [limit],
    });
    const summaryRes = await client.execute(
      `SELECT
         COUNT(*) AS total_postbacks,
         SUM(CASE WHEN reward_event_type IN ('yes','valued') THEN 1 ELSE 0 END) AS paid_postbacks,
         SUM(estimated_price) AS total_revenue_usd,
         AVG(CASE WHEN estimated_price > 0 THEN estimated_price END) AS avg_paid_price,
         AVG(estimated_price) * 1000 AS effective_cpm
       FROM ad_postback_log`
    );
    res.json({ ok: true, summary: summaryRes.rows[0], recent: recentRes.rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
