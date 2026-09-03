/**
 * Adsgram — second ad network alongside Monetag. Unlike Monetag,
 * Adsgram's server-side "Reward Url" confirmation has no way to pass a
 * custom token: per their docs it's a plain GET with only the Telegram
 * user ID substituted in (`?userid=[userId]`). No nonce, no ad-value.
 * That's why confirmation on the backend matches "the oldest still-
 * pending event for this user+action" instead of an exact nonce — see
 * confirmOldestPendingByUser in utils/monetagAds.js and the
 * /bot/adsgram-postback/:secret/:action route in routes/bot.js.
 *
 * `blockId` is admin-configurable (see /admin Settings → Ad Zones) and
 * passed in from wherever this is called, not hardcoded — mirrors how
 * monetag.js's ZONE_ID works, just threaded through as an argument since
 * Adsgram's init() needs it explicitly rather than reading a data-*
 * attribute off a <script> tag.
 */

const controllers = new Map(); // blockId -> AdController, per Adsgram's "init once per blockId" guidance

function getController(blockId) {
  if (!blockId) throw new Error('Adsgram blockId not configured — set it in the admin panel');
  if (!window.Adsgram) throw new Error('Adsgram SDK not loaded — check index.html');
  if (!controllers.has(blockId)) {
    controllers.set(blockId, window.Adsgram.init({ blockId }));
  }
  return controllers.get(blockId);
}

/**
 * Rewarded ad. The nonce is NOT passed to Adsgram (it has no field for
 * it) — it's only used locally afterwards, when polling our own backend
 * to see if the postback (matched by telegram_id+action) has confirmed.
 */
export function showAdsgramRewardedAd(blockId) {
  return getController(blockId).show();
}

/**
 * Passive Interstitial — Adsgram's non-rewarded auto-shown format.
 * Unlike Monetag's In-App Interstitial, Adsgram has no built-in
 * scheduling (frequency/interval/timeout) — that timing is handled on
 * our side (see AutoAds.jsx), this just shows one ad immediately when
 * called.
 */
export function showAdsgramInterstitial(blockId) {
  return getController(blockId).show();
}
