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
    -- TON wallet (via TON Connect / Tonkeeper) — see the unique index
    -- below and walletService.js. This is deliberately NOT a way to
    -- merge balances across accounts; it's purely identity/ownership,
    -- to close the multi-account exploit path, and it also doubles as
    -- "login with the same wallet" — reconnecting the same Tonkeeper
    -- account always resolves back to this same telegram_id.
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
    link_url TEXT NOT NULL DEFAULT '', -- unused for task_type='watch_ad'
    task_type TEXT CHECK(task_type IN ('telegram_join', 'generic', 'watch_ad')) DEFAULT 'generic',
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

-- ADDED: tracks a rewarded-ad flow from start to confirmation. A row is
-- created (status='pending') right before the frontend shows a Monetag
-- ad, carrying a random nonce as the `ymid` Monetag echoes back in its
-- postback. Only once Monetag's own server confirms the ad was watched
-- (status='confirmed') can that nonce be spent — this is what makes the
-- reward server-verified instead of a client-side promise the frontend
-- could fake by just calling the API. `action` covers every ad-gated
-- flow: 'spin' | 'referral_claim' | 'miner_start' | 'ad_task:<id>'.
CREATE TABLE IF NOT EXISTS pending_ad_events (
    nonce TEXT PRIMARY KEY,
    telegram_id INTEGER NOT NULL,
    action TEXT NOT NULL,
    status TEXT CHECK(status IN ('pending', 'confirmed', 'consumed')) DEFAULT 'pending',
    estimated_price REAL DEFAULT 0, -- Monetag's real reported revenue for this exact ad view (USD)
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    confirmed_at DATETIME
);
CREATE INDEX IF NOT EXISTS idx_pending_ad_events_telegram ON pending_ad_events(telegram_id);

-- ADDED: a raw, append-only log of EVERY Monetag postback received,
-- whether or not it matched a pending_ad_events row, whether or not it
-- was a paid ("yes"/"valued") event. This is what lets you answer "how
-- much did this specific click actually earn" directly from the
-- database — pending_ad_events only tells you about events THIS app
-- triggered and is waiting to confirm; this table is the full raw
-- record of what Monetag's server told you, matching their macro names
-- 1:1, for real analytics/auditing independent of the reward logic.
CREATE TABLE IF NOT EXISTS ad_postback_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ymid TEXT,
    telegram_id_macro TEXT, -- the {telegram_id} macro Monetag sends, kept separate from our own verified telegram_id
    zone_id TEXT,
    sub_zone_id TEXT,
    event_type TEXT, -- 'impression' | 'click'
    reward_event_type TEXT, -- 'yes'/'no' per Monetag's dashboard, though 'valued'/'not_valued' also seen in their docs — both accepted, see routes/bot.js
    estimated_price REAL DEFAULT 0,
    request_var TEXT,
    matched_pending_event INTEGER DEFAULT 0, -- 1 if this ymid matched a real pending_ad_events row
    received_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_ad_postback_log_ymid ON ad_postback_log(ymid);

-- ADDED: cycle-based Miner. Redesigned from a passive always-accruing
-- model to: user taps Start (after watching an ad) -> miner runs for
-- exactly settings.miner_cycle_hours -> stops on its own and must be
-- manually restarted -> capped at settings.miner_cycles_per_day starts
-- per calendar day. status/cycle_started_at/cycle_ends_at track the
-- CURRENT cycle only; cycles_completed_today + cycles_reset_date are
-- what let the daily cap reset itself at midnight without a cron job.
CREATE TABLE IF NOT EXISTS miner_state (
    telegram_id INTEGER PRIMARY KEY,
    status TEXT CHECK(status IN ('idle', 'running')) DEFAULT 'idle',
    cycle_started_at DATETIME,
    cycle_ends_at DATETIME,
    cycles_completed_today INTEGER DEFAULT 0,
    cycles_reset_date TEXT DEFAULT (date('now')),
    FOREIGN KEY (telegram_id) REFERENCES users(telegram_id)
);

-- ADDED: every admin-tunable number in the app lives here instead of
-- being hardcoded — one place to change points_per_usd, referral_reward,
-- miner timing, etc. via the admin panel, with no deploy needed.
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ADDED: generic on/off switches with a custom message, editable live
-- from the admin panel — built for "withdrawals" first, but reusable
-- for any future feature that might need an emergency pause with an
-- explanation shown to users (the message is free text, so it can say
-- "Coming Soon", "Maintenance", "Emergency Pause — investigating", or
-- anything else, renamed anytime with no deploy).
CREATE TABLE IF NOT EXISTS feature_flags (
    key TEXT PRIMARY KEY,
    enabled INTEGER DEFAULT 1,
    message TEXT DEFAULT '',
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ADDED: the bot's /start welcome message (caption, button labels, link
-- URLs) as admin-editable content instead of hardcoded strings/env vars
-- — see utils/botContent.js and the admin panel's Bot Message section.
CREATE TABLE IF NOT EXISTS bot_content (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT '',
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ADDED: the two fixed, always-present "watch an ad" task-bar slots
-- (one Monetag, one Adsgram) — repeatable daily up to
-- watch_ad_daily_limit_monetag/adsgram (Settings), unlike the
-- one-time-per-row `tasks` table above. Not a row in `tasks` because
-- those are admin-created and one-time-per-user by design (task_type
-- 'watch_ad' there still works the old way for anyone using it); these
-- two are system slots with their own daily-reset counter. See
-- services/adWatchService.js.
CREATE TABLE IF NOT EXISTS daily_ad_watch_state (
    telegram_id INTEGER NOT NULL,
    network TEXT NOT NULL CHECK(network IN ('monetag', 'adsgram')),
    watch_date TEXT NOT NULL, -- 'YYYY-MM-DD', UTC calendar day
    watch_count INTEGER DEFAULT 0,
    PRIMARY KEY (telegram_id, network, watch_date)
);

-- ADDED: 7-day login/watch-ad streak. `consecutive_days` counts every
-- unbroken daily claim (NOT capped at 7 — this is what lets "best
-- streak" mean something past a single week); the reward for any given
-- claim is looked up from settings.streak_day_N_points using
-- ((consecutive_days - 1) % 7) + 1, so the 7-day reward calendar simply
-- repeats every week for as long as the streak stays unbroken. Missing
-- a calendar day (UTC) resets consecutive_days back to 1 on the next
-- claim — see services/streakService.js.
CREATE TABLE IF NOT EXISTS streak_state (
    telegram_id INTEGER PRIMARY KEY,
    consecutive_days INTEGER DEFAULT 0,
    last_claim_date TEXT, -- 'YYYY-MM-DD', UTC calendar day of the last successful claim
    best_streak INTEGER DEFAULT 0,
    total_claims INTEGER DEFAULT 0,
    FOREIGN KEY (telegram_id) REFERENCES users(telegram_id)
);

INSERT OR IGNORE INTO spin_pool (id, current_pool_points, daily_collected) VALUES (1, 1000, 0);
