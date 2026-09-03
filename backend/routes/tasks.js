const express = require('express');
const { telegramAuth } = require('../middleware/telegramAuth');
const { listTasksForUser, claimTask, prepareAdTask, claimAdTask } = require('../services/taskService');
const { getStatus: getAdWatchStatus, prepareWatch, claimWatch } = require('../services/adWatchService');

const router = express.Router();

router.get('/list', telegramAuth, async (req, res) => {
  try {
    const tasks = await listTasksForUser({ telegramId: req.telegramUser.id });
    res.json({ ok: true, tasks });
  } catch (err) {
    res.status(err.statusCode || 500).json({ ok: false, error: err.message });
  }
});

router.post('/claim', telegramAuth, async (req, res) => {
  const { task_id } = req.body;
  try {
    const result = await claimTask({ telegramId: req.telegramUser.id, taskId: Number(task_id) });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(err.statusCode || 500).json({ ok: false, error: err.message });
  }
});

// watch_ad tasks: Rewarded Popup format — get a nonce, show the popup, claim.
router.post('/prepare-ad', telegramAuth, async (req, res) => {
  const { task_id } = req.body;
  try {
    const nonce = await prepareAdTask({ telegramId: req.telegramUser.id, taskId: Number(task_id) });
    res.json({ ok: true, nonce });
  } catch (err) {
    res.status(err.statusCode || 500).json({ ok: false, error: err.message });
  }
});

router.post('/claim-ad', telegramAuth, async (req, res) => {
  const { task_id, nonce } = req.body;
  try {
    const result = await claimAdTask({ telegramId: req.telegramUser.id, taskId: Number(task_id), nonce });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(err.statusCode || 500).json({ ok: false, error: err.message });
  }
});

// --- The two fixed daily watch-ad slots (Monetag + Adsgram) — see
// services/adWatchService.js. `network` is 'monetag' or 'adsgram'.

router.get('/ad-watch/status', telegramAuth, async (req, res) => {
  try {
    const status = await getAdWatchStatus({ telegramId: req.telegramUser.id });
    res.json({ ok: true, status });
  } catch (err) {
    res.status(err.statusCode || 500).json({ ok: false, error: err.message });
  }
});

router.post('/ad-watch/prepare', telegramAuth, async (req, res) => {
  const { network } = req.body;
  if (network !== 'monetag' && network !== 'adsgram') {
    return res.status(400).json({ ok: false, error: "network must be 'monetag' or 'adsgram'" });
  }
  try {
    const nonce = await prepareWatch({ telegramId: req.telegramUser.id, network });
    res.json({ ok: true, nonce });
  } catch (err) {
    res.status(err.statusCode || 500).json({ ok: false, error: err.message });
  }
});

router.post('/ad-watch/claim', telegramAuth, async (req, res) => {
  const { network, nonce } = req.body;
  if (network !== 'monetag' && network !== 'adsgram') {
    return res.status(400).json({ ok: false, error: "network must be 'monetag' or 'adsgram'" });
  }
  try {
    const result = await claimWatch({ telegramId: req.telegramUser.id, network, nonce });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(err.statusCode || 500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
