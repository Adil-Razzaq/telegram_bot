-- Core schema as specified, plus additions needed for the daily-limit
-- logic and referral tracking to actually work.

CREATE TABLE IF NOT EXISTS users (
    telegram_id INTEGER PRIMARY KEY,
    username TEXT,
    main_balance INTEGER DEFAULT 0,
    pending_referral_balance INTEGER DEFAULT 0,
    daily_ref_claims_count INTEGER DEFAULT 0,
    last_ref_claim_at DATETIME,
    last_spin_at DATETIME,
    -- ADDED: who referred this user, set once on their first /start.
    -- This is what makes referral crediting reliable and idempotent —
    -- previously nothing set this at all.
    referred_by INTEGER,
    daily_ref_reset_date TEXT DEFAULT (date('now')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS spin_pool (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    current_pool_points INTEGER DEFAULT 1000,
    daily_collected INTEGER DEFAULT 0,
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

CREATE TABLE IF NOT EXISTS ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    points_delta INTEGER NOT NULL,
    meta TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ad_reward_pings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id INTEGER NOT NULL,
    received_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_withdrawals_status ON withdrawals(status);
CREATE INDEX IF NOT EXISTS idx_ledger_telegram_id ON ledger(telegram_id);

INSERT OR IGNORE INTO spin_pool (id, current_pool_points, daily_collected) VALUES (1, 1000, 0);