const { client } = require('../db/db');

/**
 * Ranks ALL users by how many people they've referred (users.referred_by
 * = their telegram_id), largest first — same counting query already
 * used for an individual user's own count in routes/referral.js, just
 * aggregated across everyone here instead of filtered to one telegram_id.
 */

function displayName(row) {
  if (row.username) return `@${row.username}`;
  // No username set — still show *something* identifying without
  // exposing the full numeric Telegram ID to every other user.
  const id = String(row.telegram_id);
  return `Player…${id.slice(-4)}`;
}

async function getTopReferrers({ limit = 100, telegramId } = {}) {
  const res = await client.execute({
    sql: `SELECT u.telegram_id, u.username, COUNT(r.telegram_id) AS referral_count
          FROM users u
          LEFT JOIN users r ON r.referred_by = u.telegram_id
          GROUP BY u.telegram_id
          HAVING referral_count > 0
          ORDER BY referral_count DESC, u.telegram_id ASC
          LIMIT ?`,
    args: [limit],
  });

  const leaderboard = res.rows.map((row, i) => ({
    rank: i + 1,
    display_name: displayName(row),
    referral_count: row.referral_count,
    is_you: telegramId != null && row.telegram_id === telegramId,
  }));

  // If the requesting user isn't in the top `limit` (or has 0
  // referrals, so isn't in the ranked list at all), still tell them
  // their own count and an accurate rank so "you're #142" is possible
  // without paging through the whole table.
  let you = leaderboard.find((r) => r.is_you) || null;
  if (!you && telegramId != null) {
    const ownRes = await client.execute({
      sql: `SELECT COUNT(*) AS referral_count FROM users WHERE referred_by = ?`,
      args: [telegramId],
    });
    const ownCount = ownRes.rows[0].referral_count;
    let ownRank = null;
    if (ownCount > 0) {
      const rankRes = await client.execute({
        sql: `SELECT COUNT(*) + 1 AS rank FROM (
                SELECT r.referred_by AS tid, COUNT(*) AS cnt
                FROM users r WHERE r.referred_by IS NOT NULL
                GROUP BY r.referred_by
                HAVING cnt > ?
              )`,
        args: [ownCount],
      });
      ownRank = rankRes.rows[0].rank;
    }
    you = { rank: ownRank, display_name: 'You', referral_count: ownCount, is_you: true };
  }

  return { leaderboard, you };
}

module.exports = { getTopReferrers };
