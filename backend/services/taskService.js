const { client } = require('../db/db');
const { startAdEventIfRequired, consumeAdEventIfRequired } = require('../utils/monetagAds');

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
  let data;
  try {
    const res = await fetch(
      `${TELEGRAM_API}/getChatMember?chat_id=${encodeURIComponent(channelId)}&user_id=${telegramId}`
    );
    data = await res.json();
  } catch (e) {
    console.error('getChatMember request failed:', e.message);
    const err = new Error('Membership check failed — network error contacting Telegram');
    err.isVerificationError = true;
    throw err;
  }

  if (!data.ok) {
    // This is the case that was silently swallowed before: Telegram
    // couldn't answer the question at all — almost always because the
    // bot isn't an admin of this channel, or the channel ID is wrong.
    // That's a completely different problem from "user hasn't joined",
    // and needs a different, actionable error message instead of being
    // indistinguishable from it.
    console.error(`getChatMember failed for ${channelId} — is the bot an admin of it? Telegram said: ${data.description}`);
    const err = new Error(`Membership check failed: ${data.description || 'unknown Telegram API error'}`);
    err.isVerificationError = true;
    throw err;
  }

  return ['member', 'administrator', 'creator'].includes(data.result.status);
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

  if (task.task_type === 'watch_ad') {
    const err = new Error('This task requires watching an ad — use the ad-claim flow, not this endpoint');
    err.statusCode = 400;
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
    let isMember;
    try {
      isMember = await isChannelMember(task.telegram_channel_id, telegramId);
    } catch (e) {
      if (e.isVerificationError) {
        const err = new Error(
          `Can't verify membership right now — make sure the bot is an admin of ${task.telegram_channel_id}, then try again`
        );
        err.statusCode = 503;
        throw err;
      }
      throw e;
    }
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

// --- watch_ad tasks: Rewarded Popup format, high CPM — a single click
// both opens the advertiser's page AND is the claim action. Same
// server-verified nonce pattern as spin/referral/miner-start: nothing
// credits until Monetag's own postback confirms it.

async function prepareAdTask({ telegramId, taskId }) {
  const taskRes = await client.execute({
    sql: "SELECT * FROM tasks WHERE id = ? AND active = 1 AND task_type = 'watch_ad'",
    args: [taskId],
  });
  if (!taskRes.rows[0]) {
    const err = new Error('Ad task not found or no longer active');
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
  return startAdEventIfRequired({ telegramId, action: `ad_task:${taskId}` });
}

async function claimAdTask({ telegramId, taskId, nonce }) {
  await consumeAdEventIfRequired({ nonce, telegramId, action: `ad_task:${taskId}` });

  const taskRes = await client.execute({
    sql: "SELECT * FROM tasks WHERE id = ? AND active = 1 AND task_type = 'watch_ad'",
    args: [taskId],
  });
  const task = taskRes.rows[0];
  if (!task) {
    const err = new Error('Ad task not found or no longer active');
    err.statusCode = 404;
    throw err;
  }

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
      args: [telegramId, 'ad_task_claim', task.reward_points, JSON.stringify({ taskId, title: task.title })],
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
      linkUrl || '',
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

async function updateTask({ taskId, title, reward_points, link_url, task_type, telegram_channel_id, icon, sort_order }) {
  const fields = [];
  const args = [];
  if (title !== undefined) { fields.push('title = ?'); args.push(title); }
  if (reward_points !== undefined) { fields.push('reward_points = ?'); args.push(Number(reward_points)); }
  if (link_url !== undefined) { fields.push('link_url = ?'); args.push(link_url); }
  if (task_type !== undefined) { fields.push('task_type = ?'); args.push(task_type); }
  if (telegram_channel_id !== undefined) { fields.push('telegram_channel_id = ?'); args.push(telegram_channel_id); }
  if (icon !== undefined) { fields.push('icon = ?'); args.push(icon); }
  if (sort_order !== undefined) { fields.push('sort_order = ?'); args.push(Number(sort_order)); }
  if (fields.length === 0) {
    const err = new Error('No fields provided to update');
    err.statusCode = 400;
    throw err;
  }
  args.push(taskId);
  await client.execute({ sql: `UPDATE tasks SET ${fields.join(', ')} WHERE id = ?`, args });
}

async function deleteTask({ taskId }) {
  await client.execute({ sql: 'DELETE FROM tasks WHERE id = ?', args: [taskId] });
}

module.exports = {
  listTasksForUser,
  claimTask,
  createTask,
  listAllTasksAdmin,
  setTaskActive,
  updateTask,
  deleteTask,
  isChannelMember,
  prepareAdTask,
  claimAdTask,
};
