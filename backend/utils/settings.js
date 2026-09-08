const { client } = require('../db/db');

/**
 * Every tunable in this app that a real operator would want to change
 * without a code deploy lives here — not just numbers anymore. Each
 * entry in SETTING_DEFS declares its own type so getAllSettings() can
 * cast DB values (always stored as TEXT) back to the right JS type, and
 * setSetting() can validate incoming values correctly per type instead
 * of assuming everything is a positive number.
 *
 * Cached for CACHE_MS so a settings change via the admin panel takes up
 * to that long to apply everywhere — unchanged from before.
 */

const CACHE_MS = 15000;
let cache = null;
let cacheAt = 0;

const SETTING_DEFS = {
  points_per_usd: { type: 'number', default: 10000, min: 0.0001 }, // 10,000 points = $1
  referral_reward: { type: 'number', default: 100, min: 0 }, // points granted to the referrer per successful ad-watched claim
  miner_daily_points: { type: 'number', default: 150, min: 0 }, // total points available from the miner per day, across all cycles
  miner_cycles_per_day: { type: 'number', default: 4, min: 1 },
  miner_cycle_hours: { type: 'number', default: 6, min: 0.1 }, // 4 x 6 = a full 24h day, by design — see minerService.js
  // Boost: watching an ad raises the accrual RATE by this multiplier
  // for miner_boost_duration_minutes, then reverts — renewable with
  // another ad once it expires. See minerService.js's
  // prepareBoost/activateBoost/boostBonusPoints.
  miner_boost_multiplier: { type: 'number', default: 3, min: 1 },
  miner_boost_duration_minutes: { type: 'number', default: 60, min: 1 },
  spin_entry_fee: { type: 'number', default: 100, min: 0 }, // charged per spin once free spins are used up
  spin_free_spins: { type: 'number', default: 3, min: 0 }, // first N spins for a new user skip the entry fee (still requires watching an ad)
  spin_payout_1: { type: 'number', default: 10, min: 0 },
  spin_payout_2: { type: 'number', default: 20, min: 0 },
  spin_payout_3: { type: 'number', default: 50, min: 0 },
  spin_payout_4: { type: 'number', default: 100, min: 0 },
  spin_payout_5: { type: 'number', default: 200, min: 0 },
  spin_payout_6: { type: 'number', default: 500, min: 0 },

  // --- Ad controls (added for admin-managed ads) ---

  // Master switch for every reward-gated ad (spin, miner start, miner
  // claim, referral claim, task claim, watch-ad tasks). When off, those
  // actions proceed WITHOUT requiring an ad — see each service's use of
  // this flag before calling startAdEvent/consumeAdEvent.
  action_ads_enabled: { type: 'boolean', default: true },
  // Which network serves those SAME reward-gated actions (spin, miner
  // start/claim, referral claim) — switchable independent of the
  // passive auto-ad's network below. Does NOT cover the two dedicated
  // task-bar watch-ad slots (those are explicitly one-of-each by
  // design, see adWatchService.js) or admin-created generic watch_ad
  // tasks (those stay Monetag-only — see the note in taskService.js).
  action_ads_network: { type: 'enum', default: 'monetag', options: ['monetag', 'adsgram'] },

  // Passive auto-ad (Monetag In-App Interstitial or Adsgram shown on a
  // timer) — see frontend/src/components/AutoAds.jsx.
  auto_ad_enabled: { type: 'boolean', default: true },
  // Separate from auto_ad_enabled above: that's the overall kill switch
  // for the whole passive system; this one just controls whether the
  // very FIRST ad (the one auto_ad_first_delay_seconds after open)
  // fires. Off = skip that first one but keep the recurring
  // interval-based ones running on schedule — see AutoAds.jsx.
  auto_ad_first_enabled: { type: 'boolean', default: true },
  auto_ad_network: { type: 'enum', default: 'monetag', options: ['monetag', 'adsgram'] },
  auto_ad_first_delay_seconds: { type: 'number', default: 30, min: 1 },
  auto_ad_interval_seconds: { type: 'number', default: 45, min: 1 },
  // Monetag-only auto-ad tuning (Adsgram has no equivalent frequency-cap
  // API — its auto-ad is just shown on our own timer, see AutoAds.jsx).
  auto_ad_frequency: { type: 'number', default: 6, min: 1 },
  auto_ad_capping_hours: { type: 'number', default: 1, min: 0.1 },

  // Zone/Block IDs — editable here instead of hardcoded in frontend env
  // vars, so they can change without a frontend redeploy.
  monetag_zone_id: { type: 'string', default: '11654422' },
  // Adsgram Rewarded block — used for spin/miner/referral/streak reward
  // actions AND the daily_watch:adsgram task (see monetagAds.js/bot.js
  // notes on why those share one block + one Reward Url).
  adsgram_block_id: { type: 'string', default: '' },
  // Adsgram Interstitial block — a DIFFERENT block type/ID in Adsgram's
  // dashboard than adsgram_block_id above. Rewarded and Interstitial
  // are separate ad units on Adsgram's side even though our SDK wrapper
  // calls the same init()/show() shape for both — see adsgram.js. Used
  // only by the passive/auto ad in AutoAds.jsx; falls back to
  // adsgram_block_id if left blank so existing setups keep working.
  adsgram_interstitial_block_id: { type: 'string', default: '' },

  // Task-bar watch-ad rewards & limits — one Monetag task (revenue-
  // based, see taskService.js) and one Adsgram task (fixed points, since
  // Adsgram's Reward Url carries no ad-value — see monetagAds.js).
  monetag_task_reward_percent: { type: 'number', default: 50, min: 0, max: 100 },
  adsgram_task_reward_points: { type: 'number', default: 50, min: 0 },
  watch_ad_daily_limit_monetag: { type: 'number', default: 3, min: 0 },
  watch_ad_daily_limit_adsgram: { type: 'number', default: 3, min: 0 },

  // --- Adsgram "Task" format banner (Tasks tab) ---
  // This is a DIFFERENT Adsgram block type than adsgram_block_id above
  // (that one is Reward/Interstitial, shown via show()) — Task blocks
  // are a passive web-component ad Adsgram rotates on its own schedule,
  // firing a 'reward' event whenever it decides a view counted. See
  // services/taskBannerService.js and components/AdsgramTaskBanner.jsx.
  adsgram_task_banner_block_id: { type: 'string', default: 'task-46328' },
  adsgram_task_banner_reward_points: { type: 'number', default: 20, min: 0 },
  adsgram_task_banner_daily_limit: { type: 'number', default: 5, min: 0 },

  // Optional platform fee on withdrawals — both 0 means off (the
  // default; payout equals face value exactly like before this
  // existed). Expressed in the SAME unit as what the user requested
  // (points), added together: total fee = flat + percent-of-requested —
  // shown to the user as a Requested/Fee/You Will Receive breakdown
  // (see requestWithdrawal below), same shape as a typical "network
  // fee" display. The user's balance is still debited the FULL
  // requested points regardless — the fee only reduces the payout.
  withdrawal_fee_flat_points: { type: 'number', default: 0, min: 0 },
  withdrawal_fee_percent: { type: 'number', default: 0, min: 0, max: 100 },
  // Minimum points a user must request per withdrawal. Was previously a
  // hardcoded constant (MIN_WITHDRAWAL_POINTS = 500) in
  // withdrawalService.js — now admin-editable here instead, same 500
  // default so nothing changes for existing deployments until an admin
  // actually changes it.
  min_withdrawal_points: { type: 'number', default: 500, min: 0 },

  // Live Payouts board (Profile tab) display mode. Off (default) =
  // current behavior: a single foldable list showing everything.
  // On = only the 3 most recent show inline, plus two buttons: one to
  // your public Telegram payout channel, one that opens an in-app
  // scrollable popup with the full list. Either mode still satisfies
  // "proof of payout is visible" for ad-network moderation — this is
  // purely a display choice.
  live_payouts_compact_mode: { type: 'boolean', default: false },
  // Your public Telegram channel where payouts are also announced
  // (separate from WITHDRAWAL_ANNOUNCE_CHANNEL in .env, which is the
  // channel ID the BOT posts to — this is the public https://t.me/...
  // link shown to users to open it). Only used when compact mode above
  // is on.
  payout_channel_url: { type: 'string', default: '' },

  // --- 7-day login streak (Leaderboard & Streak tab) ---
  // One ad-watch per day maintains it; each day's point value is its
  // own editable setting (same "one field per slot" pattern as
  // spin_payout_1..6 above) — a typical escalating curve by default,
  // tune freely. Missing a day resets back to day 1 — see
  // streakService.js.
  streak_day1_points: { type: 'number', default: 10, min: 0 },
  streak_day2_points: { type: 'number', default: 15, min: 0 },
  streak_day3_points: { type: 'number', default: 20, min: 0 },
  streak_day4_points: { type: 'number', default: 25, min: 0 },
  streak_day5_points: { type: 'number', default: 35, min: 0 },
  streak_day6_points: { type: 'number', default: 50, min: 0 },
  streak_day7_points: { type: 'number', default: 100, min: 0 },
  // Which network's ad maintains the streak — independent of
  // action_ads_network and auto_ad_network, own dedicated switch as
  // requested.
  streak_ad_network: { type: 'enum', default: 'monetag', options: ['monetag', 'adsgram'] },

  // --- Anti-bot-farm gating (referral qualification + withdrawal channel gate) ---
  // Comma-separated Telegram channel usernames/IDs (e.g.
  // "@YourChannel,@YourSecondChannel") treated as "official channels" by
  // BOTH gates below. Same requirement as telegram_join tasks: the bot
  // must be an admin of every channel listed, or membership checks fail
  // closed (see taskService.js's checkOfficialChannelsMembership).
  // Empty by default = nothing to check, so turning either gate on below
  // has no effect until you actually list a channel here.
  official_channels: { type: 'string', default: '' },
  // How many mining cycles a REFERRED user must complete (lifetime,
  // users.total_miner_cycles_completed) before their referrer is
  // credited. 0 (default) = OFF, meaning referrals are credited
  // instantly on /start exactly like before this setting existed —
  // nothing changes for an existing deployment until this is raised.
  referral_qualify_miner_cycles: { type: 'number', default: 0, min: 0 },
  // When true, a referred user must also have joined every channel in
  // official_channels before their referrer is credited. Default off —
  // same "no behavior change until explicitly turned on" reasoning as
  // above. If official_channels is empty this has no effect even when
  // true.
  referral_require_channel_join: { type: 'boolean', default: false },
  // When true, a user must have joined every channel in
  // official_channels before they can request (or even prepare) a
  // withdrawal. Default off; if official_channels is empty this has no
  // effect even when true.
  withdrawal_require_channel_join: { type: 'boolean', default: false },
};

// Flat key -> default value, kept for backward compatibility with code
// that only needs default values or the list of known keys (e.g.
// routes/admin.js's `known_keys: Object.keys(DEFAULTS)`).
const DEFAULTS = Object.fromEntries(Object.entries(SETTING_DEFS).map(([k, d]) => [k, d.default]));

function castValue(key, rawText) {
  const def = SETTING_DEFS[key];
  if (rawText === undefined) return def.default;
  if (def.type === 'boolean') return rawText === '1' || rawText === 'true';
  if (def.type === 'number') return Number(rawText);
  return rawText; // 'string' | 'enum'
}

function encodeValue(key, value) {
  const def = SETTING_DEFS[key];
  if (def.type === 'boolean') return value ? '1' : '0';
  if (def.type === 'number') return String(value);
  return String(value);
}

async function loadAll() {
  const res = await client.execute('SELECT key, value FROM settings');
  const fromDb = {};
  for (const row of res.rows) fromDb[row.key] = row.value;
  const normalized = {};
  for (const key of Object.keys(SETTING_DEFS)) {
    normalized[key] = castValue(key, fromDb[key]);
  }
  return normalized;
}

async function getAllSettings({ forceRefresh = false } = {}) {
  if (!forceRefresh && cache && Date.now() - cacheAt < CACHE_MS) return cache;
  cache = await loadAll();
  cacheAt = Date.now();
  return cache;
}

async function getSetting(key) {
  const all = await getAllSettings();
  return all[key];
}

async function setSetting(key, value) {
  const def = SETTING_DEFS[key];
  if (!def) {
    const err = new Error(`Unknown setting key: ${key}. Known keys: ${Object.keys(SETTING_DEFS).join(', ')}`);
    err.statusCode = 400;
    throw err;
  }

  if (def.type === 'boolean') {
    const truthy = value === true || value === '1' || value === 'true' || value === 1;
    const falsy = value === false || value === '0' || value === 'false' || value === 0;
    if (!truthy && !falsy) {
      const err = new Error(`Setting ${key} must be a boolean (true/false)`);
      err.statusCode = 400;
      throw err;
    }
    await writeSetting(key, encodeValue(key, truthy));
  } else if (def.type === 'number') {
    const num = Number(value);
    if (!Number.isFinite(num)) {
      const err = new Error(`Setting ${key} must be a number`);
      err.statusCode = 400;
      throw err;
    }
    if (def.min !== undefined && num < def.min) {
      const err = new Error(`Setting ${key} must be >= ${def.min}`);
      err.statusCode = 400;
      throw err;
    }
    if (def.max !== undefined && num > def.max) {
      const err = new Error(`Setting ${key} must be <= ${def.max}`);
      err.statusCode = 400;
      throw err;
    }
    await writeSetting(key, encodeValue(key, num));
  } else if (def.type === 'enum') {
    if (!def.options.includes(value)) {
      const err = new Error(`Setting ${key} must be one of: ${def.options.join(', ')}`);
      err.statusCode = 400;
      throw err;
    }
    await writeSetting(key, encodeValue(key, value));
  } else {
    // 'string' — zone/block IDs etc. Trimmed, no other constraint (an
    // empty string is valid — e.g. adsgram_block_id before it's set).
    await writeSetting(key, encodeValue(key, String(value).trim()));
  }
}

async function writeSetting(key, encoded) {
  await client.execute({
    sql: `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
    args: [key, encoded],
  });
  await getAllSettings({ forceRefresh: true });
}

module.exports = { getAllSettings, getSetting, setSetting, DEFAULTS, SETTING_DEFS };
