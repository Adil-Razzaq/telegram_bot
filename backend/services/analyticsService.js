const { client } = require('../db/db');
const { getSetting } = require('../utils/settings');

/**
 * Backs the admin panel's Analytics page (backend/public/analytics.html).
 * Every function here is read-only aggregation over existing tables —
 * nothing here writes anything. See:
 *   - users.last_seen_at / users.country — populated by telegramAuth.js
 *   - ad_postback_log — raw record of every confirmed ad impression,
 *     from BOTH networks (see routes/bot.js)
 *   - pending_ad_events — used here only to recover WHICH button
 *     (action) a Monetag impression belonged to, via ymid.
 */

async function getOverview() {
  const [userCounts, minWithdrawalPoints, withdrawalTotals, revenue] = await Promise.all([
    client.execute(`
      SELECT
        COUNT(*) AS total_users,
        SUM(CASE WHEN last_seen_at >= datetime('now', '-1 day') THEN 1 ELSE 0 END) AS active_1d,
        SUM(CASE WHEN last_seen_at >= datetime('now', '-3 day') THEN 1 ELSE 0 END) AS active_3d,
        SUM(CASE WHEN last_seen_at >= datetime('now', '-7 day') THEN 1 ELSE 0 END) AS active_7d,
        SUM(CASE WHEN created_at >= datetime('now', '-1 day') THEN 1 ELSE 0 END) AS new_1d,
        SUM(CASE WHEN created_at >= datetime('now', '-7 day') THEN 1 ELSE 0 END) AS new_7d
      FROM users
    `),
    getSetting('min_withdrawal_points'),
    client.execute(`
      SELECT
        SUM(CASE WHEN status = 'PENDING' THEN 1 ELSE 0 END) AS pending_count,
        SUM(CASE WHEN status = 'PENDING' THEN amount_usd ELSE 0 END) AS pending_amount_usd,
        SUM(CASE WHEN status = 'COMPLETED' THEN amount_usd ELSE 0 END) AS completed_amount_usd
      FROM withdrawals
    `),
    // Monetag reports real per-impression revenue (estimated_price);
    // Adsgram doesn't send one, so this total is Monetag-only — see
    // the impressions breakdown for the network split.
    client.execute(`
      SELECT COALESCE(SUM(estimated_price), 0) AS total_usd
      FROM ad_postback_log
      WHERE network = 'monetag'
    `),
  ]);

  const eligibleRes = await client.execute({
    sql: `SELECT COUNT(*) AS count FROM users WHERE main_balance >= ?`,
    args: [minWithdrawalPoints],
  });

  const u = userCounts.rows[0];
  const w = withdrawalTotals.rows[0];

  return {
    total_users: u.total_users || 0,
    active_last_1d: u.active_1d || 0,
    active_last_3d: u.active_3d || 0,
    active_last_7d: u.active_7d || 0,
    new_users_last_1d: u.new_1d || 0,
    new_users_last_7d: u.new_7d || 0,
    withdraw_eligible_count: eligibleRes.rows[0]?.count || 0,
    min_withdrawal_points: minWithdrawalPoints,
    pending_withdrawals_count: w.pending_count || 0,
    pending_withdrawals_amount_usd: w.pending_amount_usd || 0,
    completed_withdrawals_amount_usd: w.completed_amount_usd || 0,
    estimated_monetag_revenue_usd: revenue.rows[0]?.total_usd || 0,
  };
}

async function getNewUsersSeries({ days = 30 } = {}) {
  const res = await client.execute({
    sql: `
      SELECT date(created_at) AS day, COUNT(*) AS count
      FROM users
      WHERE created_at >= datetime('now', ?)
      GROUP BY day
      ORDER BY day ASC
    `,
    args: [`-${Number(days)} days`],
  });
  return res.rows;
}

async function getCountryBreakdown() {
  const res = await client.execute(`
    SELECT COALESCE(country, 'Unknown') AS country, COUNT(*) AS count
    FROM users
    GROUP BY country
    ORDER BY count DESC
  `);
  const total = res.rows.reduce((sum, r) => sum + r.count, 0) || 1;
  return res.rows.map((r) => ({
    country: r.country,
    count: r.count,
    percent: Math.round((r.count / total) * 1000) / 10, // one decimal place
  }));
}

// granularity: 'day' | 'week' | 'month'
function bucketExpr(granularity) {
  if (granularity === 'month') return `strftime('%Y-%m', ad_postback_log.received_at)`;
  if (granularity === 'week') {
    // Sunday-starting week, labeled by that Sunday's date.
    return `date(ad_postback_log.received_at, '-' || strftime('%w', ad_postback_log.received_at) || ' days')`;
  }
  return `date(ad_postback_log.received_at)`;
}

async function getImpressions({ granularity = 'day', days = 30 } = {}) {
  const bucket = bucketExpr(granularity);
  const res = await client.execute({
    sql: `
      SELECT
        ${bucket} AS bucket,
        ad_postback_log.network AS network,
        -- Adsgram's own postback already carries the action name
        -- directly (see routes/bot.js's handleAdsgramPostback) since
        -- it has no pending_ad_events correlation column; Monetag rows
        -- carry a ymid instead, which we recover the original action
        -- from via pending_ad_events. '(any)' is Adsgram's own marker
        -- for "matched whichever action was oldest-pending" (used when
        -- Settings -> action_ads_network is set to adsgram) — labeled
        -- here as a generic reward_action bucket since the specific
        -- one isn't recoverable from that postback alone.
        CASE
          WHEN ad_postback_log.network = 'adsgram' THEN
            CASE WHEN ad_postback_log.event_type = '(any)' THEN 'reward_action (adsgram, unspecified)'
                 ELSE ad_postback_log.event_type END
          ELSE COALESCE(pending_ad_events.action, 'other/unmatched')
        END AS type,
        COUNT(*) AS count
      FROM ad_postback_log
      LEFT JOIN pending_ad_events ON pending_ad_events.nonce = ad_postback_log.ymid
      WHERE ad_postback_log.received_at >= datetime('now', ?)
      GROUP BY bucket, network, type
      ORDER BY bucket ASC
    `,
    args: [`-${Number(days)} days`],
  });
  return res.rows;
}

async function getUserProfile(telegramId) {
  const id = Number(telegramId);
  if (!Number.isInteger(id)) {
    const err = new Error('Invalid telegram ID');
    err.statusCode = 400;
    throw err;
  }

  const [userRes, minerRes, streakRes, ledgerRes, withdrawalsRes, adEventsRes, referralCountRes] =
    await Promise.all([
      client.execute({ sql: `SELECT * FROM users WHERE telegram_id = ?`, args: [id] }),
      client.execute({ sql: `SELECT * FROM miner_state WHERE telegram_id = ?`, args: [id] }),
      client.execute({ sql: `SELECT * FROM user_streak WHERE telegram_id = ?`, args: [id] }),
      client.execute({
        sql: `SELECT type, points_delta, meta, created_at FROM ledger WHERE telegram_id = ? ORDER BY created_at DESC LIMIT 25`,
        args: [id],
      }),
      client.execute({
        sql: `SELECT id, amount_usd, points_deducted, status, created_at, processed_at FROM withdrawals WHERE telegram_id = ? ORDER BY created_at DESC LIMIT 10`,
        args: [id],
      }),
      client.execute({
        sql: `SELECT action, status, COUNT(*) AS count FROM pending_ad_events WHERE telegram_id = ? GROUP BY action, status ORDER BY action`,
        args: [id],
      }),
      client.execute({
        sql: `SELECT COUNT(*) AS count FROM users WHERE referred_by = ?`,
        args: [id],
      }),
    ]);

  const user = userRes.rows[0];
  if (!user) {
    const err = new Error('No user found with that Telegram ID');
    err.statusCode = 404;
    throw err;
  }

  return {
    user,
    miner_state: minerRes.rows[0] || null,
    streak: streakRes.rows[0] || null,
    recent_ledger: ledgerRes.rows,
    recent_withdrawals: withdrawalsRes.rows,
    ad_event_summary: adEventsRes.rows,
    referrals_made_count: referralCountRes.rows[0]?.count || 0,
  };
}

module.exports = {
  getOverview,
  getNewUsersSeries,
  getCountryBreakdown,
  getImpressions,
  getUserProfile,
};
