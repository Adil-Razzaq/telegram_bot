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
  // Was hardcoded (DAILY_CLAIM_CAP = 20, COOLDOWN_SECONDS = 60) in
  // referralService.js — now admin-editable. Cooldown is UI-only (the
  // frontend disables the Claim button for this long after a claim,
  // based on last_ref_claim_at) — the daily cap IS enforced
  // server-side.
  referral_daily_claim_cap: { type: 'number', default: 20, min: 1 },
  referral_claim_cooldown_seconds: { type: 'number', default: 60, min: 0 },

  // --- Invite Gift (viral growth feature) ---
  // A ONE-TIME, instant, ad-funded welcome bonus shown to a NEW user
  // the moment they open the app via someone's referral link (i.e. as
  // soon as users.referred_by is set — see referralService.js's
  // grantReferral), completely separate from the slower referral_reward
  // bonus (which still requires referral_qualify_miner_cycles cycles
  // before the REFERRER gets paid). This one pays BOTH sides instantly
  // the moment the new user watches a single Adsgram ad — the new user
  // gets an immediate "why not try this app" payoff (drives real invite
  // link clicks into actual opens), and the referrer gets an instant
  // "your invite worked" moment (drives more sharing) — while the ad
  // view itself is the direct Adsgram revenue tied to every successful
  // invite. See services/inviteGiftService.js. Hidden entirely (no
  // welcome-gift card shown to anyone) while the Block ID is blank.
  invite_gift_adsgram_block_id: { type: 'string', default: '' },
  invite_gift_new_user_points: { type: 'number', default: 200, min: 0 },
  invite_gift_referrer_points: { type: 'number', default: 100, min: 0 },

  // --- Image-based Telegram share (viral growth) ---
  // A publicly reachable HTTPS image URL used as the banner for a rich,
  // photo-attached share via Telegram's savePreparedInlineMessage +
  // Telegram.WebApp.shareMessage() (Bot API 7.10+) — see
  // services/preparedShareService.js. Blank = feature hidden; the
  // frontend falls back to the plain-link share (Telegram's
  // t.me/share/url, no custom image) it already has either way, so
  // this is purely an enhancement, never a requirement.
  invite_share_banner_image_url: { type: 'string', default: '' },

  // --- Editable copy: Invite Gift popup (WelcomeGiftModal.jsx) ---
  // {new_points} and {referrer_points} are replaced client-side with
  // invite_gift_new_user_points / invite_gift_referrer_points.
  invite_gift_popup_title: { type: 'string', default: 'Welcome!' },
  invite_gift_popup_message: {
    type: 'string',
    default: 'Watch one quick ad to claim +{new_points} ADLX — your friend gets +{referrer_points} ADLX too!',
  },
  invite_gift_popup_button_text: { type: 'string', default: 'Watch Ad & Claim' },

  // --- Editable copy: one-device-one-account restriction page ---
  // (ChannelGate's sibling — see components/DeviceRestrictionGate.jsx.)
  // Shown to any account whose device_id was already associated with a
  // DIFFERENT Telegram account at signup — see users.multi_account_flagged.
  device_restriction_title: { type: 'string', default: 'One Account Per Device' },
  device_restriction_message: {
    type: 'string',
    default: 'This device is already linked to another Telegram account. Only one account per device is allowed.',
  },

  // --- Editable copy: "X joined your network" referrer popup ---
  // {names} is replaced client-side with a comma-joined list of the
  // newly-joined friends' display names — see routes/referral.js's
  // /new-joins and components/NewReferralPopup.jsx.
  referral_join_popup_title: { type: 'string', default: 'Congratulations!' },
  referral_join_popup_message: { type: 'string', default: '{names} joined your network via your referral link!' },
  miner_daily_points: { type: 'number', default: 150, min: 0 }, // total points available from the miner per day, across all cycles
  miner_cycles_per_day: { type: 'number', default: 4, min: 1 },
  miner_cycle_hours: { type: 'number', default: 6, min: 0.1 }, // 4 x 6 = a full 24h day, by design — see minerService.js
  // ADDED: the two status lines on the Miner tab (previously hardcoded
  // in Miner.jsx) — {amount}, {hours}, {points} get substituted with
  // the real live values in minerService.js's getStatus.
  miner_cycle_complete_message: {
    type: 'string',
    default: 'Cycle complete — {amount} ADLX Ready. Tap below to claim it.',
  },
  miner_idle_start_message: {
    type: 'string',
    default: 'Start a {hours}h cycle worth ~{points} ADLX.',
  },
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

  // Each reward-gated button now has its OWN independent on/off toggle
  // (below) instead of sharing one switch — every one of these defaults
  // to true, matching the app's previous "ad always required" behavior,
  // but can now be flipped individually per action. action_ads_enabled
  // remains as a fallback used only by admin-created generic watch_ad
  // tasks (see taskService.js) — those aren't one of "the buttons"
  // since each such task already has its own active/inactive control at
  // the task-row level.
  action_ads_enabled: { type: 'boolean', default: true },
  spin_ads_enabled: { type: 'boolean', default: true },
  miner_start_ads_enabled: { type: 'boolean', default: true },
  miner_claim_ads_enabled: { type: 'boolean', default: true },
  miner_boost_ads_enabled: { type: 'boolean', default: true },
  referral_claim_ads_enabled: { type: 'boolean', default: true },
  streak_claim_ads_enabled: { type: 'boolean', default: true },
  withdrawal_ads_enabled: { type: 'boolean', default: true },
  // Which network serves those SAME reward-gated actions (spin, miner
  // start/claim, referral claim) — switchable independent of the
  // passive auto-ad's network below. Does NOT cover the two dedicated
  // task-bar watch-ad slots (those are explicitly one-of-each by
  // design, see adWatchService.js) or admin-created generic watch_ad
  // tasks (those stay Monetag-only — see the note in taskService.js).
  action_ads_network: { type: 'enum', default: 'monetag', options: ['monetag', 'adsgram'] },

  // Passive auto-ad (Monetag In-App Interstitial or Adsgram shown on a
  // timer) — see frontend/src/components/AutoAds.jsx.
  // NOTE these two toggles are fully INDEPENDENT of each other (not one
  // master + one sub-switch) — either can be on with the other off:
  //   - auto_ad_enabled: the REPEAT ads only (interval + tab-switch).
  //   - auto_ad_first_enabled: the STARTUP ad only (fires
  //     auto_ad_first_delay_seconds after open). This one keeps working
  //     even if auto_ad_enabled above is OFF — e.g. "show one ad on
  //     open, no recurring passive ads" is a supported combination.
  auto_ad_enabled: { type: 'boolean', default: true },
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

  // --- Two more fixed, admin-configurable Adsgram task-tab slots ---
  // Each fully independent: its own Rewarded Adsgram Block ID, its own
  // fixed point reward, its own daily limit — same Rewarded/show()
  // format as adsgram_block_id above (NOT the Task-banner format), but
  // with a DEDICATED block instead of sharing the one used for spin/
  // miner/referral. A slot with a blank Block ID is hidden entirely in
  // the Tasks tab (see components/Tasks.jsx) — leave it blank until
  // you're ready to turn a slot on. See services/extraAdTaskService.js.
  adsgram_extra_task1_block_id: { type: 'string', default: '' },
  adsgram_extra_task1_reward_points: { type: 'number', default: 20, min: 0 },
  adsgram_extra_task1_daily_limit: { type: 'number', default: 3, min: 0 },
  adsgram_extra_task2_block_id: { type: 'string', default: '' },
  adsgram_extra_task2_reward_points: { type: 'number', default: 20, min: 0 },
  adsgram_extra_task2_daily_limit: { type: 'number', default: 3, min: 0 },

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
  // ADDED: proactive "your streak is about to break" push — sent as a
  // real Telegram DM (via utils/telegram.js's sendTelegramMessage), not
  // an in-app popup, since a user who hasn't opened the app today
  // won't see an in-app anything. See streakService.js's
  // sendBreakingSoonReminders, run on a timer from server.js exactly
  // like reconcileStuckReferrals. hour_utc controls how late in the
  // UTC day the reminder fires (default 20:00 UTC = 4 hours before the
  // day rolls over and an unclaimed streak actually breaks).
  streak_reminder_enabled: { type: 'boolean', default: true },
  streak_reminder_hour_utc: { type: 'number', default: 20, min: 0, max: 23 },
  // {day} = the streak day they're currently on (about to lose),
  // {points} = the reward they'd get for claiming today, substituted
  // in streakService.js.
  streak_reminder_message: {
    type: 'string',
    default:
      '⏳ <b>Streak Alert:</b> Day {day} ends at midnight UTC — claim now to bank <b>+{points} ADLX</b> and keep it alive.',
  },

  // ADDED: Mining Contest — a recurring, admin-configured prize
  // leaderboard ranked by ACTIVE REFERRALS: how many people someone
  // referred DURING the current round who have since completed at
  // least `mining_contest_active_referral_cycles` mining cycles
  // (lifetime — users.total_miner_cycles_completed). This is
  // deliberately NOT the referrer's own mining activity — it's a
  // referral-quality contest, just measured by real usage instead of
  // a raw referral count that a long-inactive user could still be
  // sitting on top of forever. See services/miningContestService.js.
  mining_contest_enabled: { type: 'boolean', default: false },
  mining_contest_duration_days: { type: 'enum', default: '7', options: ['7', '15', '30'] },
  mining_contest_active_referral_cycles: { type: 'number', default: 2, min: 1 },
  // Below these, that position gets NO prize even if it's #1 — set to
  // 0 to always pay out regardless of how few active referrals anyone has.
  mining_contest_min_active_referrals_1st: { type: 'number', default: 10, min: 0 },
  mining_contest_min_active_referrals_2nd: { type: 'number', default: 8, min: 0 },
  mining_contest_min_active_referrals_3rd: { type: 'number', default: 6, min: 0 },
  mining_contest_prize_1st: { type: 'number', default: 500, min: 0 },
  mining_contest_prize_2nd: { type: 'number', default: 300, min: 0 },
  mining_contest_prize_3rd: { type: 'number', default: 150, min: 0 },
  // Optional: a Telegram channel/group chat ID (e.g. "-100123456789")
  // the bot posts the results IMAGE to automatically once a round
  // finalizes — for public promotion/virality. Leave blank to skip
  // public posting; winners are always DMed their own copy regardless
  // of this setting. The bot must already be an admin of that chat.
  mining_contest_announce_chat_id: { type: 'string', default: '' },
  // Sent to the channel above the moment a new round STARTS (see
  // startNewContest in miningContestService.js) — separate from the
  // results announcement, which only fires when a round ENDS.
  // {days}/{cycles}/{prize1}/{prize2}/{prize3} get substituted.
  mining_contest_start_message: {
    type: 'string',
    default:
      '🎉 <b>A new Active Referral Contest round has started!</b>\n\n⏱ Duration: {days} days\n🎯 Get a referral to {cycles}+ mining cycles to count as active\n🏆 Prizes: 👑 {prize1} · 🥈 {prize2} · 🥉 {prize3} ADLX\n\nRefer friends and help them get active to climb the leaderboard!',
  },
  // Subtitle shown under "Leaderboard" in the app — {cycles} substituted.
  leaderboard_subtitle_text: {
    type: 'string',
    default: 'Ranked by active referrals — referred users who have completed {cycles}+ mining cycles.',
  },
  // Subtitle shown under "Active Referral Contest" in the app — {cycles} substituted.
  mining_contest_subtitle_text: {
    type: 'string',
    default: 'Ranked by active referrals — people you referred this round who have completed {cycles}+ mining cycles.',
  },

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
  // Hard gate on the app itself, checked on every app open — blocks
  // ALL use of the app (not just withdrawal/referral) until every
  // channel in official_channels is joined. Independent of the two
  // settings above — you can have any combination of the three on.
  // Default off; if official_channels is empty this has no effect even
  // when true (same fail-open behavior as the other two — see
  // taskService.js's checkOfficialChannelsMembership).
  app_open_require_channel_join: { type: 'boolean', default: false },
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
