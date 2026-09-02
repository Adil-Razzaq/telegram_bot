const { v4: uuidv4 } = require('uuid');
const { client } = require('../db/db');
const { sendTelegramMessage } = require('../utils/telegram');
const { getSetting } = require('../utils/settings');
const { getFlag } = require('../utils/featureFlags');

// TON addresses, not BEP-20 — matches the TON Connect / Tonkeeper wallet
// integration (see walletService.js). Accepts both the common
// user-friendly form (48 base64url chars, starting EQ/UQ/kQ/0Q) and the
// raw form (workchain:hex), since different wallets/tools surface either.
const TON_ADDRESS_REGEX = /^((EQ|UQ|kQ|0Q)[A-Za-z0-9_-]{46}|-?[01]:[a-fA-F0-9]{64})$/;
const MIN_WITHDRAWAL_POINTS = 500; // = $0.05 at the default 10,000 pts = $1 rate

async function requestWithdrawal({ telegramId, address, points }) {
  const flag = await getFlag('withdrawal');
  if (!flag.enabled) {
    const err = new Error(flag.message || 'Withdrawals are temporarily disabled.');
    err.statusCode = 503;
    throw err;
  }

  if (!TON_ADDRESS_REGEX.test(address || '')) {
    const err = new Error('Invalid TON wallet address format');
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
    const pointsPerUsd = await getSetting('points_per_usd');
    const amountUsd = points / pointsPerUsd;
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
    // in .env (e.g. @YourPublicChannel) to turn this on. Shows the
    // Telegram user ID (not username — not everyone has one set) rather
    // than any other identifying info. A failure here never breaks the
    // withdrawal itself — it's already been marked COMPLETED above.
    const channel = process.env.WITHDRAWAL_ANNOUNCE_CHANNEL;
    if (channel) {
      const tonviewerUrl = `https://tonviewer.com/transaction/${txHash}`;
      const message = [
        '✅ <b>Withdrawal Completed</b>',
        '',
        `👤 User ID: <code>${w.telegram_id}</code>`,
        `💰 Amount: ${w.points_deducted} points ($${w.amount_usd.toFixed(2)})`,
        `🔗 Tx Hash: <a href="${tonviewerUrl}">View on Tonviewer</a>`,
        '📌 Status: COMPLETED',
      ].join('\n');

      sendTelegramMessage(channel, message, { parseMode: 'HTML' }).catch((err) =>
        console.error('Failed to post withdrawal announcement:', err.message)
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
  TON_ADDRESS_REGEX,
  MIN_WITHDRAWAL_POINTS,
};
