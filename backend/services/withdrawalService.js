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
  const withdrawalsFlag = await getFlag('withdrawals');
  if (!withdrawalsFlag.enabled) {
    const err = new Error(withdrawalsFlag.message || 'Withdrawals are temporarily unavailable.');
    err.statusCode = 403;
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
    const [pointsPerUsd, flatFee, feePercent] = await Promise.all([
      getSetting('points_per_usd'),
      getSetting('withdrawal_fee_flat_points'),
      getSetting('withdrawal_fee_percent'),
    ]);
    // Fee expressed in the SAME unit the user requested (points), same
    // shape as the "Requested Amount / Fee / You Will Receive" display
    // in the withdrawal form — not a separate percentage silently
    // applied only to the $ conversion. At the defaults (0 and 0%) this
    // is identical to the pre-fee behavior: netPoints === points.
    const feePoints = Math.round(flatFee + points * (feePercent / 100));
    const netPoints = Math.max(0, points - feePoints);
    if (netPoints <= 0) {
      const err = new Error('The withdrawal fee is greater than or equal to the requested amount — try a larger amount');
      err.statusCode = 400;
      throw err;
    }
    const amountUsd = netPoints / pointsPerUsd;
    await tx.execute({
      sql: `INSERT INTO withdrawals (id, telegram_id, usdt_bep20_address, amount_usd, points_deducted, status)
            VALUES (?, ?, ?, ?, ?, 'PENDING')`,
      args: [id, telegramId, address, amountUsd, points],
    });
    await tx.execute({
      sql: 'INSERT INTO ledger (telegram_id, type, points_delta, meta) VALUES (?, ?, ?, ?)',
      args: [
        telegramId,
        'withdrawal_request',
        -points,
        JSON.stringify({ withdrawalId: id, feePoints, netPoints }),
      ],
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

// Single-withdrawal lookup by ID — powers the admin panel's "enter an ID,
// fetch its details" flow instead of scrolling a full list.
async function getWithdrawalById(withdrawalId) {
  const res = await client.execute({
    sql: 'SELECT * FROM withdrawals WHERE id = ?',
    args: [withdrawalId],
  });
  return res.rows[0] || null;
}

// For fixing a typo made when originally completing a withdrawal (wrong
// tx_hash, date, or points entered) — NOT for changing anything else.
// Only touches an ALREADY-COMPLETED withdrawal; doesn't re-run the
// balance deduction or ledger entry (those already happened in
// completeWithdrawal above), just corrects these fields. Any field can
// be omitted to leave it as-is.
async function editCompletedWithdrawal({ withdrawalId, txHash, processedAt, points }) {
  const wRes = await client.execute({
    sql: 'SELECT * FROM withdrawals WHERE id = ?',
    args: [withdrawalId],
  });
  const w = wRes.rows[0];
  if (!w) {
    const err = new Error('Withdrawal not found');
    err.statusCode = 404;
    throw err;
  }
  if (w.status !== 'COMPLETED') {
    const err = new Error(`Can only edit an already-completed withdrawal's details — this one is ${w.status}`);
    err.statusCode = 409;
    throw err;
  }

  const sets = [];
  const args = [];
  if (txHash !== undefined) {
    if (!txHash || typeof txHash !== 'string' || txHash.length < 10) {
      const err = new Error('tx_hash must be a real transaction hash, at least 10 characters');
      err.statusCode = 400;
      throw err;
    }
    sets.push('tx_hash = ?');
    args.push(txHash);
  }
  if (processedAt !== undefined) {
    // Expects 'YYYY-MM-DD HH:MM:SS' (what the admin panel's
    // datetime-local input is converted to before this call) — same
    // format SQLite's own CURRENT_TIMESTAMP produces, so this stays
    // consistent with every other row's processed_at.
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(processedAt)) {
      const err = new Error("processedAt must look like 'YYYY-MM-DD HH:MM:SS'");
      err.statusCode = 400;
      throw err;
    }
    sets.push('processed_at = ?');
    args.push(processedAt);
  }
  if (points !== undefined) {
    const pointsNum = Number(points);
    if (!Number.isInteger(pointsNum) || pointsNum <= 0) {
      const err = new Error('points must be a positive whole number');
      err.statusCode = 400;
      throw err;
    }
    // $ amount is always DERIVED from points at the CURRENT
    // points_per_usd rate — never entered separately, so the two can
    // never drift out of sync with each other or with how every other
    // conversion in the app works.
    const pointsPerUsd = await getSetting('points_per_usd');
    sets.push('points_deducted = ?', 'amount_usd = ?');
    args.push(pointsNum, pointsNum / pointsPerUsd);
  }
  if (sets.length === 0) {
    const err = new Error('Nothing to update — provide txHash, processedAt, and/or points');
    err.statusCode = 400;
    throw err;
  }

  args.push(withdrawalId);
  await client.execute({ sql: `UPDATE withdrawals SET ${sets.join(', ')} WHERE id = ?`, args });

  const res = await client.execute({ sql: 'SELECT * FROM withdrawals WHERE id = ?', args: [withdrawalId] });
  return res.rows[0];
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

// Public "proof of payout" board — required for ad-network moderation
// (e.g. Adsgram's review explicitly asks for "a public leaderboard... or
// a dedicated section publishing payout confirmations" as proof real
// payouts happen). Shows only what's needed to verify a payout is real:
// masked identity (or @username if they have one — never the raw
// numeric Telegram ID), amount, and a tx hash anyone can check on
// Tonviewer themselves. Nothing here is writable by a user, it's a
// read-only view of withdrawals this same service already completes.
async function getRecentPayouts({ limit = 20 } = {}) {
  const res = await client.execute({
    sql: `SELECT w.telegram_id, w.points_deducted, w.tx_hash, w.processed_at
          FROM withdrawals w
          WHERE w.status = 'COMPLETED'
          ORDER BY w.processed_at DESC
          LIMIT ?`,
    args: [limit],
  });
  return res.rows.map((row) => ({
    // Deliberately ID-based, never @username — and points only, never
    // the $ amount. Just enough to prove real payouts happen (the
    // tx_hash is independently verifiable on-chain) without publishing
    // identifying info or dollar figures.
    id: `#${String(row.telegram_id).slice(-4)}`,
    points: row.points_deducted,
    tx_hash: row.tx_hash,
    tonviewer_url: `https://tonviewer.com/transaction/${row.tx_hash}`,
    processed_at: row.processed_at,
  }));
}

module.exports = {
  requestWithdrawal,
  listPendingWithdrawals,
  listWithdrawalsForUser,
  completeWithdrawal,
  getWithdrawalById,
  editCompletedWithdrawal,
  rejectWithdrawal,
  getRecentPayouts,
  TON_ADDRESS_REGEX,
  MIN_WITHDRAWAL_POINTS,
};
