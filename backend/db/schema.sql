-- Core schema as specified, plus a small number of additions (marked below)
-- that are required for the daily-limit logic to actually work: SQLite has
-- no built-in "reset this counter at midnight" behavior, so we track the
-- date a counter was last reset and zero it out lazily when a new day is
-- detected. Nothing here changes the point/probability model.

CREATE TABLE IF NOT EXISTS users (
    telegram_id INTEGER PRIMARY KEY,
    username TEXT,
    main_balance INTEGER DEFAULT 0,
    pending_referral_balance INTEGER DEFAULT 0,
    daily_ref_claims_count INTEGER DEFAULT 0,
    last_ref_claim_at DATETIME,
    -- ADDED: last spin timestamp, used as a minimum-interval abuse check
    -- (see notes in utils/adsgram.js on why this exists instead of a
    -- verified ad token — Adsgram doesn't issue one at this traffic tier)
    last_spin_at DATETIME,
    -- ADDED: who referred this user, set once on their first /start.
    -- This is what makes referral crediting reliable and idempotent.
    referred_by INTEGER,
    -- ADDED: locks to whichever Telegram account first connects this
    -- wallet — see the unique index below and walletService.js. This is
    -- deliberately NOT a way to merge balances across accounts; it's
    -- purely identity/ownership, to close the multi-account exploit path.
    wallet_address TEXT,
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

-- ADDED: "Earn Rewards" task list (join channel, follow X, subscribe
-- YouTube, etc.) — task_type distinguishes tasks we can actually verify
-- (telegram_join, checked against the real Telegram API) from ones we
-- can't (generic — honor system, no platform gives a way to check X
-- follows or YouTube subscriptions without OAuth integrations well
-- beyond this app's current scope).
CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    reward_points INTEGER NOT NULL,
    link_url TEXT NOT NULL,
    task_type TEXT CHECK(task_type IN ('telegram_join', 'generic')) DEFAULT 'generic',
    telegram_channel_id TEXT, -- required for task_type = 'telegram_join', e.g. @YourChannel
    icon TEXT DEFAULT '⭐',
    active INTEGER DEFAULT 1,
    sort_order INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS task_completions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id INTEGER NOT NULL,
    task_id INTEGER NOT NULL,
    completed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(telegram_id, task_id)
);
CREATE INDEX IF NOT EXISTS idx_task_completions_telegram ON task_completions(telegram_id);

-- ADDED: Adsgram's optional "Reward URL" pings this with ?userid=<telegramId>
-- after independently confirming an ad was watched (see utils/adsgram.js).
-- We log it rather than gate on it, since Adsgram only recommends wiring
-- this up once you're past ~50k daily users — logging it now costs
-- nothing and gives you a real audit trail to compare "claims made" vs
-- "ad views Adsgram actually confirmed" once volume picks up.
CREATE TABLE IF NOT EXISTS ad_reward_pings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id INTEGER NOT NULL,
    received_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ADDED: tracks completed Task-format ads (Adsgram's native ad unit — e.g.
-- "join this channel"). Each row is one user completing one task, ever —
-- the UNIQUE constraint is what stops a task from being claimed twice.
CREATE TABLE IF NOT EXISTS task_completions (
    telegram_id INTEGER NOT NULL,
    task_id TEXT NOT NULL,
    completed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (telegram_id, task_id)
);

-- ADDED: tracks a rewarded-ad flow from start to confirmation. A row is
-- created (status='pending') right before the frontend shows a Monetag
-- ad, carrying a random nonce as the `ymid` Monetag echoes back in its
-- postback. Only once Monetag's own server confirms the ad was watched
-- (status='confirmed') can that nonce be spent on a spin or referral
-- claim — this is what makes the reward server-verified instead of a
-- client-side promise the frontend could fake by just calling the API.
CREATE TABLE IF NOT EXISTS pending_ad_events (
    nonce TEXT PRIMARY KEY,
    telegram_id INTEGER NOT NULL,
    action TEXT NOT NULL, -- 'spin' | 'referral_claim'
    status TEXT CHECK(status IN ('pending', 'confirmed', 'consumed')) DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    confirmed_at DATETIME
);
CREATE INDEX IF NOT EXISTS idx_pending_ad_events_telegram ON pending_ad_events(telegram_id);

-- ADDED: passive "Miner" feature. accumulation_started_at marks when the
-- current earning window began; claiming credits everything accrued
-- since then (capped, see minerService.js) and resets it to now.
CREATE TABLE IF NOT EXISTS miner_state (
    telegram_id INTEGER PRIMARY KEY,
    accumulation_started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (telegram_id) REFERENCES users(telegram_id)
);

INSERT OR IGNORE INTO spin_pool (id, current_pool_points, daily_collected) VALUES (1, 1000, 0);
