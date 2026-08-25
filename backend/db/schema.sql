-- Core schema as specified, plus a small number of additions (marked below)
-- that are required for the daily-limit logic to actually work: SQLite has
-- no built-in "reset this counter at midnight" behavior, so we track the
-- date a counter was last reset and zero it out lazily when a new day is
-- detected. Nothing here changes the point/probability model.

CREATE TABLE IF NOT EXISTS users (
    telegram_id INTEGER PRIMARY KEY,
    main_balance INTEGER DEFAULT 0,
    pending_referral_balance INTEGER DEFAULT 0,
    daily_ref_claims_count INTEGER DEFAULT 0,
    last_ref_claim_at DATETIME,
    -- ADDED: lets us lazily reset daily_ref_claims_count once per calendar day
    daily_ref_reset_date TEXT DEFAULT (date('now')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS spin_pool (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    current_pool_points INTEGER DEFAULT 1000,
    daily_collected INTEGER DEFAULT 0,
    -- ADDED: lets us lazily reset daily_collected once per calendar day
    daily_reset_date TEXT DEFAULT (date('now'))
);

CREATE TABLE IF NOT EXISTS withdrawals (
    id TEXT PRIMARY KEY,
    telegram_id INTEGER NOT NULL,
    usdt_bep20_address TEXT NOT NULL,
    amount_usd REAL NOT NULL,
    points_deducted INTEGER NOT NULL,
    status TEXT CHECK(status IN ('PENDING', 'COMPLETED', 'REJECTED')) DEFAULT 'PENDING',
    tx_hash TEXT DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    processed_at DATETIME,
    FOREIGN KEY (telegram_id) REFERENCES users(telegram_id)
);

-- ADDED: append-only ledger for every balance-affecting event, so admin
-- profit margin, ad-revenue-vs-payout, and any single user's balance can be
-- audited/reconstructed from history alone. Nothing in the spec asked for
-- this, but a real-money system without an audit trail is very hard to
-- debug or defend if a payout is ever disputed.
CREATE TABLE IF NOT EXISTS ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id INTEGER NOT NULL,
    type TEXT NOT NULL, -- 'spin_entry' | 'spin_payout' | 'referral_grant' | 'referral_claim' | 'withdrawal_request' | 'withdrawal_completed' | 'withdrawal_rejected'
    points_delta INTEGER NOT NULL, -- positive = credited to user, negative = debited
    meta TEXT, -- JSON blob with context (segment index, referral source, withdrawal id, etc.)
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_withdrawals_status ON withdrawals(status);
CREATE INDEX IF NOT EXISTS idx_ledger_telegram_id ON ledger(telegram_id);

INSERT OR IGNORE INTO spin_pool (id, current_pool_points, daily_collected) VALUES (1, 1000, 0);
