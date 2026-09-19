const { v4: uuidv4 } = require('uuid');
const { client } = require('../db/db');
const { getAllSettings } = require('../utils/settings');
const { sendTelegramMessage, sendTelegramPhoto } = require('../utils/telegram');
const { generateResultsImage } = require('./contestImageService');

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

  // A round already in progress is intentionally left to finish and pay
  // out its winners on its own schedule (see ensureActiveMiningContest)
  // even if the admin flips this off mid-round — that's what keeps a
  // round from being stranded without ever paying anyone. But the APP
  // itself should revert to the plain leaderboard the moment it's
  // turned off, not keep showing a contest nobody can see is "off"
  // from their end — so the display is gated here, separately from
  // whether the round itself keeps running.
  const settings = await getAllSettings();
  if (!settings.mining_contest_enabled) return null;

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
    subtitle: (settings.mining_contest_subtitle_text || '').replace('{cycles}', contest.active_referral_cycles),
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

  // Generated once and reused for every winner DM plus the public
  // announcement post below, rather than re-rendering per recipient.
  let resultsImage = null;
  try {
    resultsImage = await generateResultsImage({ ...contest, results });
  } catch (err) {
    // A rendering failure must never block the actual prize payouts
    // below — winners still get paid and a text DM either way, they
    // just miss the shareable graphic for this one round.
    console.error(`Contest results image generation failed for ${contest.id}:`, err.message);
  }

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
      const caption = `${medal} <b>Congratulations!</b> You placed <b>${place}</b> in the Active Referral Contest with ${winner.active_referrals} active referrals — <b>+${winner.prize_awarded} ADLX</b> has been added to your balance!\n\nShare this to show off your win 🎉`;

      // The image IS the shareable/viral part — a winner is far more
      // likely to repost an actual graphic than a plain text message.
      // Falls back to text-only if the image failed to generate above,
      // so a rendering bug never costs a winner their notification.
      if (resultsImage) {
        await sendTelegramPhoto(winner.telegram_id, resultsImage, { caption, parseMode: 'HTML' });
      } else {
        await sendTelegramMessage(winner.telegram_id, caption, { parseMode: 'HTML' });
      }
    } catch (err) {
      // A failed DM (blocked bot, etc.) must never block the payout
      // that already committed above, or the next winner in this loop.
      console.error(`Mining contest payout/notify failed for ${winner.telegram_id}:`, err.message);
    }
  }

  // Optional public promotion — posts the same graphic to an
  // admin-configured channel/group so it isn't only ever seen by the
  // 3 winners. Never lets a failure here (bot not admin of that chat,
  // bad chat ID, etc.) affect anything above, which has already fully
  // committed by this point.
  try {
    const settings = await getAllSettings();
    if (resultsImage && settings.mining_contest_announce_chat_id) {
      await sendTelegramPhoto(settings.mining_contest_announce_chat_id, resultsImage, {
        caption: '🏆 <b>Active Referral Contest — Round Results</b>',
        parseMode: 'HTML',
      });
    }
  } catch (err) {
    console.error(`Mining contest public announcement failed for ${contest.id}:`, err.message);
  }

  await client.execute({
    sql: `UPDATE mining_contests SET status = 'completed', results = ?, results_image = ? WHERE id = ?`,
    args: [JSON.stringify(results), resultsImage, contest.id],
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

  // Public "a new round just started" announcement — separate from the
  // results announcement in finalizeContest, which only fires once a
  // round ENDS. Posted to the same channel, since it's the same
  // audience; never blocks the round actually starting if this fails
  // (bad chat ID, bot not admin there, etc.) or if no channel is set.
  try {
    if (settings.mining_contest_announce_chat_id) {
      const text = (settings.mining_contest_start_message || '')
        .replace('{days}', days)
        .replace('{cycles}', settings.mining_contest_active_referral_cycles)
        .replace('{prize1}', settings.mining_contest_prize_1st)
        .replace('{prize2}', settings.mining_contest_prize_2nd)
        .replace('{prize3}', settings.mining_contest_prize_3rd);
      await sendTelegramMessage(settings.mining_contest_announce_chat_id, text, { parseMode: 'HTML' });
    }
  } catch (err) {
    console.error('Mining contest start announcement failed:', err.message);
  }
}

// Runs on a timer (server.js) purely to FINALIZE a round once its time
// is up — pay the top 3, freeze results, DM winners. It deliberately
// does NOT auto-start the next round anymore: starting a round is a
// separate, explicit admin action (see startContestManually) so
// flipping `mining_contest_enabled` on/off only ever controls whether
// an existing round is shown in the app, never whether a new one
// begins. This avoids rounds silently kicking off back-to-back the
// moment one finishes, or the instant an admin re-enables the display
// toggle.
async function ensureActiveMiningContest() {
  try {
    const active = await getActiveContest();
    if (!active) return;

    const endsAtMs = new Date(active.ends_at + 'Z').getTime();
    if (Date.now() >= endsAtMs) {
      await finalizeContest(active);
    }
  } catch (err) {
    console.error('ensureActiveMiningContest failed:', err.message);
  }
}

// Explicit admin action — the ONLY way a new round now begins. Refuses
// to start one while a round is already active, so an accidental
// double-click can't silently orphan the current round's remaining
// time/standings.
async function startContestManually() {
  const active = await getActiveContest();
  if (active) {
    const err = new Error('A round is already running — wait for it to finish, or it will finalize on its own once its time is up.');
    err.statusCode = 400;
    throw err;
  }
  const settings = await getAllSettings();
  await startNewContest(settings);
}

// Explicit admin action to close out the current round right now,
// instead of waiting for its scheduled ends_at. ends_at is moved back
// to the current moment FIRST (rather than just calling
// finalizeContest on the unmodified row) so two things stay accurate:
// the standings query's own end-of-window cutoff, and the round dates
// shown in the results image/CSV — both would otherwise still say the
// original future end date even though the round actually stopped
// today.
async function endContestManually() {
  const active = await getActiveContest();
  if (!active) {
    const err = new Error('No round is currently running.');
    err.statusCode = 400;
    throw err;
  }
  await client.execute({ sql: `UPDATE mining_contests SET ends_at = datetime('now') WHERE id = ?`, args: [active.id] });
  const updated = await getActiveContest();
  await finalizeContest(updated);
}

// --- Admin: history + public sharing ---

async function getContestHistory({ limit = 20 } = {}) {
  const res = await client.execute({
    sql: `
      SELECT id, starts_at, ends_at, duration_days, active_referral_cycles,
             min_active_referrals_1st, min_active_referrals_2nd, min_active_referrals_3rd,
             prize_1st, prize_2nd, prize_3rd, status, results, created_at,
             results_image IS NOT NULL AS has_image
      FROM mining_contests ORDER BY created_at DESC LIMIT ?
    `,
    args: [limit],
  });
  return res.rows.map((row) => ({
    ...row,
    results: row.results ? JSON.parse(row.results) : null,
  }));
}

async function getContestById(id) {
  const res = await client.execute({
    sql: `
      SELECT id, starts_at, ends_at, duration_days, active_referral_cycles,
             min_active_referrals_1st, min_active_referrals_2nd, min_active_referrals_3rd,
             prize_1st, prize_2nd, prize_3rd, status, results, created_at
      FROM mining_contests WHERE id = ?
    `,
    args: [id],
  });
  const row = res.rows[0];
  if (!row) {
    const err = new Error('Contest not found');
    err.statusCode = 404;
    throw err;
  }
  return { ...row, results: row.results ? JSON.parse(row.results) : null };
}

// The one place that actually needs the raw image bytes — kept
// separate from getContestById so the BLOB is never pulled into
// memory for requests that don't need it (the history list, the CSV
// export).
async function getContestImage(id) {
  const res = await client.execute({ sql: `SELECT results_image FROM mining_contests WHERE id = ?`, args: [id] });
  const row = res.rows[0];
  if (!row || !row.results_image) {
    const err = new Error('No image available for this contest');
    err.statusCode = 404;
    throw err;
  }
  return row.results_image;
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
  startContestManually,
  endContestManually,
  getCurrentContestStatus,
  getContestHistory,
  getContestById,
  getContestImage,
  toCsv,
};
