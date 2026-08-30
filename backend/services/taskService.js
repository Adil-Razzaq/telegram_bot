const { client } = require('../db/db');

const TELEGRAM_API = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;

/**
 * Checks real Telegram channel membership via the Bot API's
 * getChatMember. This ONLY works if your bot is an admin of the channel
 * (same requirement as the withdrawal announcement feature). Returns
 * true for 'member', 'administrator', or 'creator' status — false for
 * 'left', 'kicked', or if the API call itself fails for any reason
 * (fails closed: never grants credit on an unclear result).
 */
async function isChannelMember(channelId, telegramId) {
  try {
    const res = await fetch(
      `${TELEGRAM_API}/getChatMember?chat_id=${encodeURIComponent(channelId)}&user_id=${telegramId}`
    );
    const data = await res.json();
    if (!data.ok) return false;
    return ['member', 'administrator', 'creator'].includes(data.result.status);
  } catch (e) {
    return false;
  }
}

async function listTasksForUser({ telegramId }) {
  const [tasksRes, completionsRes] = await Promise.all([
    client.execute(
      'SELECT * FROM tasks WHERE active = 1 ORDER BY sort_order ASC, id ASC'
    ),
    client.execute({
      sql: 'SELECT task_id FROM task_completions WHERE telegram_id = ?',
      args: [telegramId],
    }),
  ]);

  const completedIds = new Set(completionsRes.rows.map((r) => r.task_id));
  return tasksRes.rows.map((t) => ({
    id: t.id,
    title: t.title,
    reward_points: t.reward_points,
    link_url: t.link_url,
    icon: t.icon,
    task_type: t.task_type,
    completed: completedIds.has(t.id),
  }));
}

async function claimTask({ telegramId, taskId }) {
  const taskRes = await client.execute({
    sql: 'SELECT * FROM tasks WHERE id = ? AND active = 1',
    args: [taskId],
  });
  const task = taskRes.rows[0];
  if (!task) {
    const err = new Error('Task not found or no longer active');
    err.statusCode = 404;
    throw err;
  }

  const alreadyRes = await client.execute({
    sql: 'SELECT 1 FROM task_completions WHERE telegram_id = ? AND task_id = ?',
    args: [telegramId, taskId],
  });
  if (alreadyRes.rows[0]) {
    const err = new Error('You already claimed this task');
    err.statusCode = 409;
    throw err;
  }

  if (task.task_type === 'telegram_join') {
    const isMember = await isChannelMember(task.telegram_channel_id, telegramId);
    if (!isMember) {
      const err = new Error("You haven't joined the channel yet — join it, then try again");
      err.statusCode = 400;
      throw err;
    }
  }
  // task_type 'generic' (follow X, subscribe YouTube, etc.) has no
  // real verification available — this is an honest honor-system credit,
  // not a fabricated check. See the note in db/schema.sql.

  const tx = await client.transaction('write');
  try {
    await tx.execute({
      sql: 'INSERT INTO task_completions (telegram_id, task_id) VALUES (?, ?)',
      args: [telegramId, taskId],
    });
    await tx.execute({
      sql: 'UPDATE users SET main_balance = main_balance + ? WHERE telegram_id = ?',
      args: [task.reward_points, telegramId],
    });
    await tx.execute({
      sql: 'INSERT INTO ledger (telegram_id, type, points_delta, meta) VALUES (?, ?, ?, ?)',
      args: [telegramId, 'task_claim', task.reward_points, JSON.stringify({ taskId, title: task.title })],
    });

    const updatedRes = await tx.execute({
      sql: 'SELECT main_balance FROM users WHERE telegram_id = ?',
      args: [telegramId],
    });
    await tx.commit();
    return { earned_points: task.reward_points, main_balance: updatedRes.rows[0].main_balance };
  } catch (err) {
    await tx.rollback().catch(() => {});
    throw err;
  }
}

// --- Admin management ---

async function createTask({ title, rewardPoints, linkUrl, taskType, telegramChannelId, icon, sortOrder }) {
  if (taskType === 'telegram_join' && !telegramChannelId) {
    const err = new Error('telegram_channel_id is required for task_type telegram_join');
    err.statusCode = 400;
    throw err;
  }
  const res = await client.execute({
    sql: `INSERT INTO tasks (title, reward_points, link_url, task_type, telegram_channel_id, icon, sort_order)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [
      title,
      rewardPoints,
      linkUrl,
      taskType || 'generic',
      telegramChannelId || null,
      icon || '⭐',
      sortOrder || 0,
    ],
  });
  return { id: Number(res.lastInsertRowid) };
}

async function listAllTasksAdmin() {
  const res = await client.execute('SELECT * FROM tasks ORDER BY sort_order ASC, id ASC');
  return res.rows;
}

async function setTaskActive({ taskId, active }) {
  await client.execute({
    sql: 'UPDATE tasks SET active = ? WHERE id = ?',
    args: [active ? 1 : 0, taskId],
  });
}

module.exports = {
  listTasksForUser,
  claimTask,
  createTask,
  listAllTasksAdmin,
  setTaskActive,
  isChannelMember,
};
