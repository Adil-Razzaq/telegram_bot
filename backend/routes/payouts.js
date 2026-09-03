const express = require('express');
const { client } = require('../db/db');

const router = express.Router();

// Public, unauthenticated — no telegramAuth here on purpose. This
// exists specifically so a reviewer (Adsgram, Monetag, or anyone else)
// can see real proof that withdrawals actually get paid out without
// needing a Telegram account or app access, satisfying policies that
// require "proof of reward payouts to users (e.g. a pinned message, a
// public leaderboard, a public channel, or a dedicated section
// publishing payout confirmations)". Masks the wallet address and
// shows only a short username/id — enough to be verifiable, not enough
// to be a privacy problem.
router.get('/recent', async (req, res) => {
  try {
    const result = await client.execute(`
      SELECT w.id, w.amount_usd, w.tx_hash, w.processed_at, u.username, u.telegram_id
      FROM withdrawals w
      JOIN users u ON u.telegram_id = w.telegram_id
      WHERE w.status = 'COMPLETED'
      ORDER BY w.processed_at DESC
      LIMIT 50
    `);

    const payouts = result.rows.map((row) => ({
      id: row.id,
      amount_usd: row.amount_usd,
      tx_hash: row.tx_hash,
      processed_at: row.processed_at,
      user: row.username ? `@${row.username}` : `user ${String(row.telegram_id).slice(0, 4)}***`,
    }));

    res.json({ ok: true, payouts });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
