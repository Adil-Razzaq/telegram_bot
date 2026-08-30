const express = require('express');
const { telegramAuth } = require('../middleware/telegramAuth');
const { listTasksForUser, claimTask } = require('../services/taskService');

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

module.exports = router;
