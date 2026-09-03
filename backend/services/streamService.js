const { client } = require('../db/db');

/**
 * Live activity feed for the Stream tab — recent EARNING events across
 * all users (never withdrawals or balance adjustments; those stay
 * private to the user they belong to), for the social-proof "look,
 * people are actually earning" effect. Purely a read of the existing
 * ledger audit trail — no new writes, no new state to keep in sync.
 */

const LABELS = {
  spin_payout: 'won a spin',
  referral_claim: 'claimed a referral bonus',
  referral_grant: 'earned a referral bonus',
  miner_claim: 'claimed mining rewards',
  daily_watch_ad: 'watched an ad',
  streak_claim: 'kept their streak going',
};
// Anything with a type not in LABELS (ad_task:<id>, admin_adjustment,
// withdrawal_*, spin_entry which is a debit, etc.) is filtered out
// below rather than guessing a label for it.

function displayName(row) {
  if (row.username) return `@${row.username}`;
  const id = String(row.telegram_id);
  return `Player…${id.slice(-4)}`;
}

async function getRecentActivity({ limit = 30 } = {}) {
  const placeholders = Object.keys(LABELS).map(() => '?').join(',');
  const res = await client.execute({
    sql: `SELECT l.telegram_id, u.username, l.type, l.points_delta, l.created_at
          FROM ledger l
          JOIN users u ON u.telegram_id = l.telegram_id
          WHERE l.type IN (${placeholders}) AND l.points_delta > 0
          ORDER BY l.id DESC
          LIMIT ?`,
    args: [...Object.keys(LABELS), limit],
  });

  return res.rows.map((row) => ({
    display_name: displayName(row),
    action: LABELS[row.type] || 'earned points',
    points: row.points_delta,
    created_at: row.created_at,
  }));
}

module.exports = { getRecentActivity };
