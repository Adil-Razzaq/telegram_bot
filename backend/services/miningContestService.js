const { v4: uuidv4 } = require('uuid');
const { client } = require('../db/db');
const { getAllSettings } = require('../utils/settings');
const { sendTelegramMessage } = require('../utils/telegram');

// --- Mining Contest ---
// A recurring, admin-configured prize leaderboard ranked by ACTIVE
// REFERRALS: how many people someone referred DURING the current
// round have gone on to complete at least `active_referral_cycles`
// mining cycles (lifetime — users.total_miner_cycles_completed). This
// is a referral-QUALITY contest, not a raw referral-count one — it's
// the direct fix for "the top spot can be someone who referred a lot
// once and then went inactive": only referrals gained in the CURRENT
// window count at all, and only once the referred person has actually
// used the app enough to be real, not just a signup.
//
// Lifecycle (see ensureActiveMiningContest, run on a timer from
// server.js exactly like reconcileStuckReferrals/sendBreakingSoonReminders):
//   1. No active contest + mining_contest_enabled → start one.
//   2. Active contest whose ends_at has passed → finalize it (freeze
//      final standings into `results`, pay the top 3, DM the winners)
//      regardless of the enabled flag, so disabling the feature
//      mid-contest can never strand an already-running contest
//      without ever paying out.

function displayName(row) {
  if (row.username) return `@${row.username}`;
  const id = String(row.telegram_id);
  return `Player…${id.slice(-4)}`;
}

// Shared ranking query — used for both the live in-app leaderboard and
// the final frozen results at contest end. `activeReferralCycles` is
// always the CONTEST'S OWN snapshotted threshold (never the current
// settings value — see the schema.sql comment on why), so it stays
// correct even if the admin changes the setting mid-round.
async function computeStandings(startsAt, endsAt, activeReferralCycles, limit) {
  const res = await client.execute({
    sql: `
      SELECT ref.referred_by AS telegram_id, u.username,
             COUNT(*) AS active_referrals
      FROM users ref
      JOIN users u ON u.telegram_id = ref.referred_by
      WHERE ref.referred_by IS NOT NULL
        AND ref.created_at >= ? AND ref.created_at < ?
        AND ref.total_miner_cycles_completed >= ?
      GROUP BY ref.referred_by
      ORDER BY active_referrals DESC, ref.referred_by ASC
      LIMIT ?
    `,
    args: [startsAt, endsAt, activeReferralCycles, limit],
  });
  return res.rows.map((row, i) => ({
    rank: i + 1,
    telegram_id: row.telegram_id,
    display_name: displayName(row),
    active_referrals: row.active_referrals,
  }));
}

async function getActiveContest() {
  const res = await client.execute(
    `SELECT * FROM mining_contests WHERE status = 'active' ORDER BY created_at DESC LIMIT 1`
  );
  return res.rows[0] || null;
}

// Live standings for the app's Ranks tab. Returns null when no contest
// is currently running (frontend just hides the section).
async function getCurrentContestStatus({ telegramId, limit = 20 } = {}) {
  const contest = await getActiveContest();
  if (!contest) return null;

  const leaderboard = await computeStandings(contest.starts_at, contest.ends_at, contest.active_referral_cycles, limit);
  let you = leaderboard.find((r) => r.telegram_id === telegramId) || null;
  if (!you && telegramId != null) {
    const ownRes = await client.execute({
      sql: `
        SELECT COUNT(*) AS active_referrals
        FROM users
        WHERE referred_by = ? AND created_at >= ? AND created_at < ? AND total_miner_cycles_completed >= ?
      `,
      args: [telegramId, contest.starts_at, contest.ends_at, contest.active_referral_cycles],
    });
    you = { rank: null, display_name: 'You', ...ownRes.rows[0] };
  }

  const endsAtMs = new Date(contest.ends_at + 'Z').getTime();
  return {
    contest_id: contest.id,
    starts_at: contest.starts_at,
    ends_at: contest.ends_at,
    duration_days: contest.duration_days,
    active_referral_cycles: contest.active_referral_cycles,
    seconds_remaining: Math.max(0, Math.ceil((endsAtMs - Date.now()) / 1000)),
    prizes: { first: contest.prize_1st, second: contest.prize_2nd, third: contest.prize_3rd },
    min_active_referrals: {
      first: contest.min_active_referrals_1st,
      second: contest.min_active_referrals_2nd,
      third: contest.min_active_referrals_3rd,
    },
    leaderboard,
    you,
  };
}

async function finalizeContest(contest) {
  const standings = await computeStandings(contest.starts_at, contest.ends_at, contest.active_referral_cycles, 20);
  const prizesByRank = { 1: contest.prize_1st, 2: contest.prize_2nd, 3: contest.prize_3rd };
  const minByRank = {
    1: contest.min_active_referrals_1st,
    2: contest.min_active_referrals_2nd,
    3: contest.min_active_referrals_3rd,
  };

  const results = standings.map((row) => {
    const meetsMinimum = row.rank in minByRank ? row.active_referrals >= minByRank[row.rank] : false;
    return {
      ...row,
      prize_awarded: meetsMinimum ? prizesByRank[row.rank] || 0 : 0,
    };
  });

  for (const winner of results.filter((r) => r.rank <= 3 && r.prize_awarded > 0)) {
    try {
      const tx = await client.transaction('write');
      try {
        await tx.execute({
          sql: 'UPDATE users SET main_balance = main_balance + ? WHERE telegram_id = ?',
          args: [winner.prize_awarded, winner.telegram_id],
        });
        await tx.execute({
          sql: 'INSERT INTO ledger (telegram_id, type, points_delta, meta) VALUES (?, ?, ?, ?)',
          args: [
            winner.telegram_id,
            'contest_prize',
            winner.prize_awarded,
            JSON.stringify({ contestId: contest.id, rank: winner.rank }),
          ],
        });
        await tx.commit();
      } catch (err) {
        await tx.rollback().catch(() => {});
        throw err;
      }

      const medal = winner.rank === 1 ? '🥇' : winner.rank === 2 ? '🥈' : '🥉';
      const place = winner.rank === 1 ? '1st' : winner.rank === 2 ? '2nd' : '3rd';
      await sendTelegramMessage(
        winner.telegram_id,
        `${medal} <b>Congratulations!</b> You placed <b>${place}</b> in the Active Referral Contest with ${winner.active_referrals} active referrals — <b>+${winner.prize_awarded} ADLX</b> has been added to your balance!`,
        { parseMode: 'HTML' }
      );
    } catch (err) {
      // A failed DM (blocked bot, etc.) must never block the payout
      // that already committed above, or the next winner in this loop.
      console.error(`Mining contest payout/notify failed for ${winner.telegram_id}:`, err.message);
    }
  }

  await client.execute({
    sql: `UPDATE mining_contests SET status = 'completed', results = ? WHERE id = ?`,
    args: [JSON.stringify(results), contest.id],
  });
}

async function startNewContest(settings) {
  const days = parseInt(settings.mining_contest_duration_days, 10);
  await client.execute({
    sql: `
      INSERT INTO mining_contests (
        id, starts_at, ends_at, duration_days, active_referral_cycles,
        min_active_referrals_1st, min_active_referrals_2nd, min_active_referrals_3rd,
        prize_1st, prize_2nd, prize_3rd, status
      )
      VALUES (?, datetime('now'), datetime('now', '+' || ? || ' days'), ?, ?, ?, ?, ?, ?, ?, ?, 'active')
    `,
    args: [
      uuidv4(),
      days,
      days,
      settings.mining_contest_active_referral_cycles,
      settings.mining_contest_min_active_referrals_1st,
      settings.mining_contest_min_active_referrals_2nd,
      settings.mining_contest_min_active_referrals_3rd,
      settings.mining_contest_prize_1st,
      settings.mining_contest_prize_2nd,
      settings.mining_contest_prize_3rd,
    ],
  });
}

async function ensureActiveMiningContest() {
  try {
    const settings = await getAllSettings();
    const active = await getActiveContest();

    if (active) {
      const endsAtMs = new Date(active.ends_at + 'Z').getTime();
      if (Date.now() >= endsAtMs) {
        await finalizeContest(active);
        if (settings.mining_contest_enabled) await startNewContest(settings);
      }
      return;
    }

    if (settings.mining_contest_enabled) await startNewContest(settings);
  } catch (err) {
    console.error('ensureActiveMiningContest failed:', err.message);
  }
}

// --- Admin: history + public sharing ---

async function getContestHistory({ limit = 20 } = {}) {
  const res = await client.execute({
    sql: `SELECT * FROM mining_contests ORDER BY created_at DESC LIMIT ?`,
    args: [limit],
  });
  return res.rows.map((row) => ({
    ...row,
    results: row.results ? JSON.parse(row.results) : null,
  }));
}

async function getContestById(id) {
  const res = await client.execute({ sql: `SELECT * FROM mining_contests WHERE id = ?`, args: [id] });
  const row = res.rows[0];
  if (!row) {
    const err = new Error('Contest not found');
    err.statusCode = 404;
    throw err;
  }
  return { ...row, results: row.results ? JSON.parse(row.results) : null };
}

// Plain CSV — opens in Excel/Sheets and is exactly the kind of file
// that's easy to screenshot/repost publicly, which is the actual goal
// ("so we can share publicly") rather than needing a styled image.
function toCsv(contest) {
  const header = 'Rank,User,Telegram ID,Active Referrals,Eligible,Prize Awarded (ADLX)\n';
  const rows = (contest.results || [])
    .map((r) => [r.rank, r.display_name, r.telegram_id, r.active_referrals, r.prize_awarded > 0 ? 'Yes' : 'No', r.prize_awarded || 0].join(','))
    .join('\n');
  return header + rows;
}

module.exports = {
  ensureActiveMiningContest,
  getCurrentContestStatus,
  getContestHistory,
  getContestById,
  toCsv,
};
