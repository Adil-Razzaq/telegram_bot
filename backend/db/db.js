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

// Columns that have been added to users/spin_pool over time. migrate()
// checks each one against the live database and ALTERs it in if missing —
// this is what makes it safe to redeploy after a schema change without a
// manual migration step, whether the database is brand new or already has
// data in it.
const COLUMNS_TO_ENSURE = [
  { table: 'users', column: 'username', ddl: 'TEXT' },
  { table: 'users', column: 'last_spin_at', ddl: 'DATETIME' },
  { table: 'users', column: 'referred_by', ddl: 'INTEGER' },
  { table: 'users', column: 'wallet_address', ddl: 'TEXT' },
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
  // libSQL's executeMultiple runs a whole .sql file of statements at once.
  // CREATE TABLE IF NOT EXISTS handles brand-new tables fine, but it's a
  // no-op on a table that already exists — it will NOT add new columns to
  // it. That's what the loop below is for.
  await client.executeMultiple(schema);
  for (const { table, column, ddl } of COLUMNS_TO_ENSURE) {
    await ensureColumn(table, column, ddl);
  }

  // This index depends on wallet_address, which the loop above may have
  // JUST added on an existing database — so it has to run after that
  // loop, never bundled into the schema.sql batch above (which runs
  // before any column-healing and would fail with "no such column" on a
  // database that predates this feature).
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

module.exports = { client, migrate, rolloverDailyCountersIfNeeded, rolloverUserRefCounterIfNeeded };
