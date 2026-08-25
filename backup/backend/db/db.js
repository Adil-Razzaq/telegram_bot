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

async function migrate() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  // libSQL's executeMultiple runs a whole .sql file of statements at once
  await client.executeMultiple(schema);
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
