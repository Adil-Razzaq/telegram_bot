const express = require('express');
const { telegramAuth } = require('../middleware/telegramAuth');
const { client } = require('../db/db');

const router = express.Router();

// Full ranked list of every user with at least one referral, largest
// referral count first — powers the Leaderboard tab. Capped at a
// generous LIMIT purely as a payload-size safety valve, not a "top N"
// design choice; realistically no operator has more than a few hundred
// users with actual referrals.
router.get('/', telegramAuth, async (req, res) => {
  try {
    const myId = req.telegramUser.id;

    const listRes = await client.execute(`
      SELECT u.telegram_id, u.username, COUNT(r.telegram_id) AS referral_count
      FROM users u
      JOIN users r ON r.referred_by = u.telegram_id
      GROUP BY u.telegram_id
      HAVING referral_count > 0
      ORDER BY referral_count DESC, u.telegram_id ASC
      LIMIT 500
    `);

    const leaderboard = listRes.rows.map((row, index) => ({
      rank: index + 1,
      telegram_id: row.telegram_id,
      username: row.username,
      referral_count: Number(row.referral_count),
      is_me: row.telegram_id === myId,
    }));

    // The requesting user's own rank/count, even if they're not in the
    // (capped) list above or have zero referrals — so the frontend can
    // always show "Your rank" without the user having to scroll to find
    // themselves.
    const myCountRes = await client.execute({
      sql: 'SELECT COUNT(*) AS cnt FROM users WHERE referred_by = ?',
      args: [myId],
    });
    const myReferralCount = Number(myCountRes.rows[0].cnt);

    let myRank = leaderboard.find((r) => r.is_me)?.rank;
    if (myRank === undefined) {
      if (myReferralCount > 0) {
        const rankRes = await client.execute({
          sql: `SELECT COUNT(*) AS cnt FROM (
                  SELECT u.telegram_id, COUNT(r.telegram_id) AS referral_count
                  FROM users u JOIN users r ON r.referred_by = u.telegram_id
                  GROUP BY u.telegram_id
                  HAVING referral_count > ?
                )`,
          args: [myReferralCount],
        });
        myRank = Number(rankRes.rows[0].cnt) + 1;
      } else {
        myRank = null; // no referrals yet — unranked
      }
    }

    res.json({
      ok: true,
      leaderboard,
      my_rank: myRank,
      my_referral_count: myReferralCount,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
