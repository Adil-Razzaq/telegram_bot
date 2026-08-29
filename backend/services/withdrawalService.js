const { v4: uuidv4 } = require('uuid');
const { client } = require('../db/db');
const { sendTelegramMessage } = require('../utils/telegram');

const BEP20_ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/;
const POINTS_PER_USD = 10000;
const MIN_WITHDRAWAL_POINTS = 500; // = $0.05 at 10,000 pts = $1

async function requestWithdrawal({ telegramId, address, points }) {
  if (!BEP20_ADDRESS_REGEX.test(address || '')) {
    const err = new Error('Invalid BEP-20 address format');
    err.statusCode = 400;
    throw err;
  }
  if (!Number.isInteger(points) || points < MIN_WITHDRAWAL_POINTS) {
    const err = new Error(`points must be an integer >= ${MIN_WITHDRAWAL_POINTS}`);
    err.statusCode = 400;
    throw err;
  }

  const tx = await client.transaction('write');
  try {
    const userRes = await tx.execute({
      sql: 'SELECT * FROM users WHERE telegram_id = ?',
      args: [telegramId],
    });
    const user = userRes.rows[0];
    if (!user) {
      const err = new Error('User not found');
      err.statusCode = 404;
      throw err;
    }
    if (user.main_balance < points) {
      const err = new Error('Insufficient balance');
      err.statusCode = 400;
      throw err;
    }

    await tx.execute({
      sql: 'UPDATE users SET main_balance = main_balance - ? WHERE telegram_id = ?',
      args: [points, telegramId],
    });

    const id = uuidv4();
    const amountUsd = points / POINTS_PER_USD;
    await tx.execute({
      sql: `INSERT INTO withdrawals (id, telegram_id, usdt_bep20_address, amount_usd, points_deducted, status)
            VALUES (?, ?, ?, ?, ?, 'PENDING')`,
      args: [id, telegramId, address, amountUsd, points],
    });
    await tx.execute({
      sql: 'INSERT INTO ledger (telegram_id, type, points_delta, meta) VALUES (?, ?, ?, ?)',
      args: [telegramId, 'withdrawal_request', -points, JSON.stringify({ withdrawalId: id })],
    });

    const res = await tx.execute({ sql: 'SELECT * FROM withdrawals WHERE id = ?', args: [id] });
    await tx.commit();
    return res.rows[0];
  } catch (err) {
    await tx.rollback().catch(() => {});
    throw err;
  }
}

async function listPendingWithdrawals() {
  const res = await client.execute(
    `SELECT * FROM withdrawals WHERE status = 'PENDING' ORDER BY created_at ASC`
  );
  return res.rows;
}

async function listWithdrawalsForUser(telegramId) {
  const res = await client.execute({
    sql: `SELECT * FROM withdrawals WHERE telegram_id = ? ORDER BY created_at DESC`,
    args: [telegramId],
  });
  return res.rows;
}

async function completeWithdrawal({ withdrawalId, txHash }) {
  if (!txHash || typeof txHash !== 'string' || txHash.length < 10) {
    const err = new Error('A valid tx_hash is required to mark a withdrawal complete');
    err.statusCode = 400;
    throw err;
  }

  const tx = await client.transaction('write');
  try {
    const wRes = await tx.execute({
      sql: 'SELECT * FROM withdrawals WHERE id = ?',
      args: [withdrawalId],
    });
    const w = wRes.rows[0];
    if (!w) {
      const err = new Error('Withdrawal not found');
      err.statusCode = 404;
      throw err;
    }
    if (w.status !== 'PENDING') {
      const err = new Error(`Withdrawal is already ${w.status}`);
      err.statusCode = 409;
      throw err;
    }
    await tx.execute({
      sql: `UPDATE withdrawals SET status = 'COMPLETED', tx_hash = ?, processed_at = CURRENT_TIMESTAMP WHERE id = ?`,
      args: [txHash, withdrawalId],
    });
    await tx.execute({
      sql: 'INSERT INTO ledger (telegram_id, type, points_delta, meta) VALUES (?, ?, ?, ?)',
      args: [w.telegram_id, 'withdrawal_completed', 0, JSON.stringify({ withdrawalId, txHash })],
    });

    const res = await tx.execute({
      sql: 'SELECT * FROM withdrawals WHERE id = ?',
      args: [withdrawalId],
    });
    await tx.commit();

    // Proof-of-payout for your public channel — set WITHDRAWAL_ANNOUNCE_CHANNEL
    // in .env (e.g. @YourPublicChannel) to turn this on. No user-identifying
    // info is included, just the points amount. A failure here never breaks
    // the withdrawal itself — it's already been marked COMPLETED above.
    const channel = process.env.WITHDRAWAL_ANNOUNCE_CHANNEL;
    if (channel) {
      sendTelegramMessage(channel, `🎉 A user just withdrew ${w.points_deducted} points!`).catch(
        (err) => console.error('Failed to post withdrawal announcement:', err.message)
      );
    }

    return res.rows[0];
  } catch (err) {
    await tx.rollback().catch(() => {});
    throw err;
  }
}

async function rejectWithdrawal({ withdrawalId, reason }) {
  const tx = await client.transaction('write');
  try {
    const wRes = await tx.execute({
      sql: 'SELECT * FROM withdrawals WHERE id = ?',
      args: [withdrawalId],
    });
    const w = wRes.rows[0];
    if (!w) {
      const err = new Error('Withdrawal not found');
      err.statusCode = 404;
      throw err;
    }
    if (w.status !== 'PENDING') {
      const err = new Error(`Withdrawal is already ${w.status}`);
      err.statusCode = 409;
      throw err;
    }
    // Refund the points since the payout never happened
    await tx.execute({
      sql: 'UPDATE users SET main_balance = main_balance + ? WHERE telegram_id = ?',
      args: [w.points_deducted, w.telegram_id],
    });
    await tx.execute({
      sql: `UPDATE withdrawals SET status = 'REJECTED', processed_at = CURRENT_TIMESTAMP WHERE id = ?`,
      args: [withdrawalId],
    });
    await tx.execute({
      sql: 'INSERT INTO ledger (telegram_id, type, points_delta, meta) VALUES (?, ?, ?, ?)',
      args: [
        w.telegram_id,
        'withdrawal_rejected',
        w.points_deducted,
        JSON.stringify({ withdrawalId, reason: reason || null }),
      ],
    });

    const res = await tx.execute({
      sql: 'SELECT * FROM withdrawals WHERE id = ?',
      args: [withdrawalId],
    });
    await tx.commit();
    return res.rows[0];
  } catch (err) {
    await tx.rollback().catch(() => {});
    throw err;
  }
}

module.exports = {
  requestWithdrawal,
  listPendingWithdrawals,
  listWithdrawalsForUser,
  completeWithdrawal,
  rejectWithdrawal,
  BEP20_ADDRESS_REGEX,
  POINTS_PER_USD,
  MIN_WITHDRAWAL_POINTS,
};
