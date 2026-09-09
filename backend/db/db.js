const path = require('path');
const fs = require('fs');
const { createClient } = require('@libsql/client');

// Turso (libSQL) instead of a local SQLite file: a local file on Render's
// free tier is wiped every time the service restarts (which happens
// automatically after 15 min idle) — unacceptable for real point/money
// balances. Turso is SQLite-compatible but lives on Turso's servers, so
// it survives restarts, redeploys, and the free host sleeping.
if (!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN) {
  throw new Error(
    'Missing TURSO_DATABASE_URL / TURSO_AUTH_TOKEN — see backend/.env.example and the deployment README'
  );
}

const client = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const COLUMNS_TO_ENSURE = [
  { table: 'users', column: 'username', ddl: 'TEXT' },
  { table: 'users', column: 'last_spin_at', ddl: 'DATETIME' },
  { table: 'users', column: 'referred_by', ddl: 'INTEGER' },
  { table: 'users', column: 'wallet_address', ddl: 'TEXT' },
  { table: 'miner_state', column: 'status', ddl: "TEXT DEFAULT 'idle'" },
  { table: 'miner_state', column: 'cycle_started_at', ddl: 'DATETIME' },
  { table: 'miner_state', column: 'cycle_ends_at', ddl: 'DATETIME' },
  { table: 'miner_state', column: 'cycles_completed_today', ddl: 'INTEGER DEFAULT 0' },
  // SQLite forbids non-constant defaults (e.g. date('now')) on ALTER TABLE
  // ADD COLUMN, so this is added plain and backfilled below in migrate().
  { table: 'miner_state', column: 'cycles_reset_date', ddl: 'TEXT' },
  // Tracks whether the one-per-cycle ad-boost has been used — see
  // services/minerService.js's prepareBoost/activateBoost. Constant
  // default (0) is fine for ALTER ADD COLUMN, unlike cycles_reset_date
  // above.
  // Deprecated — replaced by the two columns below (hourly-renewable
  // boost windows instead of a once-per-cycle permanent flag). Left in
  // place rather than dropped to avoid an ALTER TABLE DROP COLUMN
  // migration; simply unused by minerService.js now.
  { table: 'miner_state', column: 'boost_active', ddl: 'INTEGER DEFAULT 0' },
  // When the CURRENTLY active boost window ends (NULL = no active
  // window). Constant NULL default is fine for ALTER ADD COLUMN.
  { table: 'miner_state', column: 'boost_expires_at', ddl: 'TEXT' },
  // Bonus points already earned from PAST, now-expired boost windows
  // this cycle — see boostBonusPoints in minerService.js.
  { table: 'miner_state', column: 'boost_bonus_banked', ddl: 'REAL DEFAULT 0' },
  { table: 'pending_ad_events', column: 'estimated_price', ddl: 'REAL DEFAULT 0' },
  // Distinguishes which network sent this row now that both Monetag and
  // Adsgram write into the same log table (see routes/bot.js). Constant
  // string default is fine for ALTER ADD COLUMN, unlike the date('now')
  // issue above — every pre-existing row really was Monetag, since
  // Adsgram didn't exist in this table before now.
  { table: 'ad_postback_log', column: 'network', ddl: "TEXT DEFAULT 'monetag'" },
  { table: 'users', column: 'free_spins_used', ddl: 'INTEGER DEFAULT 0' },
  // ADDED (referral anti-bot-farm gating): lifetime count of completed
  // mining cycles, separate from miner_state.cycles_completed_today
  // (which resets daily) — this is what referralService.maybeQualifyReferral
  // compares against settings.referral_qualify_miner_cycles. Incremented
  // in minerService.js's claim(), never reset.
  { table: 'users', column: 'total_miner_cycles_completed', ddl: 'INTEGER DEFAULT 0' },
  // ADDED: set to 1 the moment a referral's reward has actually been
  // credited to the referrer (whether instantly, when qualification
  // gating is off, or later once maybeQualifyReferral's conditions are
  // met). Prevents a referral from ever being rewarded twice.
  { table: 'users', column: 'referral_qualified', ddl: 'INTEGER DEFAULT 0' },
  // ADDED (admin Analytics page): updated on every authenticated
  // request (see middleware/telegramAuth.js) — what "active in the
  // last 1/3/7 days" is computed from in analyticsService.js. Constant
  // NULL default is fine for ALTER ADD COLUMN.
  { table: 'users', column: 'last_seen_at', ddl: 'DATETIME' },
  // ADDED (admin Analytics page): best-effort IP->country lookup, done
  // ONCE per user (only when still NULL) the first time they're seen
  // after this column exists — see utils/geoLookup.js and
  // telegramAuth.js. NULL/failed lookups show up as "Unknown" in the
  // country breakdown rather than blocking anything.
  { table: 'users', column: 'country', ddl: 'TEXT' },
];

async function ensureColumn(table, column, ddl) {
  const info = await client.execute(`PRAGMA table_info(${table})`);
  const exists = info.rows.some((row) => row.name === column);
  if (!exists) {
    await client.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
    console.log(`migrate: added missing column ${table}.${column}`);
  }
}

async function migrate() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await client.executeMultiple(schema);
  for (const { table, column, ddl } of COLUMNS_TO_ENSURE) {
    await ensureColumn(table, column, ddl);
  }

  // One-time backfill: cycles_reset_date has no DB-level default, so any
  // row that just got the column added still has it NULL. Set it explicitly.
  await client.execute(
    `UPDATE miner_state SET cycles_reset_date = date('now') WHERE cycles_reset_date IS NULL`
  );

  await client.execute(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_users_wallet_address ON users(wallet_address) WHERE wallet_address IS NOT NULL'
  );
}

async function rolloverDailyCountersIfNeeded() {
  const today = new Date().toISOString().slice(0, 10);
  await client.execute({
    sql: `UPDATE spin_pool SET daily_collected = 0, daily_reset_date = ?
          WHERE id = 1 AND daily_reset_date != ?`,
    args: [today, today],
  });
}

async function rolloverUserRefCounterIfNeeded(telegramId) {
  const today = new Date().toISOString().slice(0, 10);
  await client.execute({
    sql: `UPDATE users SET daily_ref_claims_count = 0, daily_ref_reset_date = ?
          WHERE telegram_id = ? AND daily_ref_reset_date != ?`,
    args: [today, telegramId, today],
  });
}

async function rolloverMinerCyclesIfNeeded(telegramId) {
  const today = new Date().toISOString().slice(0, 10);
  await client.execute({
    sql: `UPDATE miner_state SET cycles_completed_today = 0, cycles_reset_date = ?
          WHERE telegram_id = ? AND cycles_reset_date != ? AND status = 'idle'`,
    args: [today, telegramId, today],
  });
}

module.exports = {
  client,
  migrate,
  rolloverDailyCountersIfNeeded,
  rolloverUserRefCounterIfNeeded,
  rolloverMinerCyclesIfNeeded,
};