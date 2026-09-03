/**
 * Zone ID is now admin-editable (Settings → Monetag Zone ID), not a
 * build-time env var — so the SDK script tag can't be static HTML
 * anymore (its data-zone would be baked in at build time). Instead
 * initMonetag(zoneId) injects the <script> tag at runtime once App.jsx
 * has fetched /user/config and knows the current zone ID. Every other
 * function here reads that same zoneId back from module state, so
 * existing callers (showRewardedAd(nonce), etc.) don't need to change.
 */

let currentZoneId = null;
let loadPromise = null;

/** Call once, as early as possible after /user/config resolves. */
export function initMonetag(zoneId) {
  if (!zoneId) return Promise.reject(new Error('No Monetag zone ID configured — set one in the admin panel'));
  if (currentZoneId === zoneId && loadPromise) return loadPromise;

  currentZoneId = zoneId;
  // If a previous zone's script tag is still around (shouldn't normally
  // happen — this only runs once per app load — but harmless to guard),
  // remove it so window[`show_${zoneId}`] gets freshly registered.
  document.querySelectorAll('script[data-monetag-loader]').forEach((el) => el.remove());

  loadPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '//libtl.com/sdk.js';
    script.setAttribute('data-zone', zoneId);
    script.setAttribute('data-sdk', `show_${zoneId}`);
    script.setAttribute('data-monetag-loader', '1');
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Failed to load Monetag SDK'));
    document.head.appendChild(script);
  });
  return loadPromise;
}

function getShowFn() {
  if (!currentZoneId) throw new Error('Monetag not initialized — initMonetag(zoneId) must run first');
  const showFn = window[`show_${currentZoneId}`];
  if (typeof showFn !== 'function') {
    throw new Error('Monetag SDK not loaded yet — try again in a moment');
  }
  return showFn;
}

/**
 * Rewarded Interstitial — a full-screen ad shown directly inside the app;
 * the Promise resolves once the user has watched it through and closed
 * it. Every reward placement in the app uses this format (spin, referral
 * claim, miner start/claim, and any watch_ad tasks) — a single
 * show_<zoneId>() call with `ymid` set so our nonce round-trips through
 * Monetag's postback.
 *
 * type: 'end' is Monetag's explicit name for this format (see their SDK
 * reference) — omitting `type` defaults to the same thing, but naming it
 * keeps this readable next to enableInAppInterstitial below.
 */
export function showRewardedAd(nonce) {
  let showFn;
  try {
    showFn = getShowFn();
  } catch (e) {
    return Promise.reject(e);
  }
  return showFn({ type: 'end', ymid: nonce });
}

/**
 * In-App Interstitial — passive, non-rewarded full-screen ads Monetag
 * displays automatically: first after `timeoutSeconds` from app open,
 * then every `interval` seconds, up to `frequency` times per `capping`
 * hours. `everyPage: true` is what makes it keep firing across tab
 * switches within the app rather than only once on the very first
 * screen. No nonce/postback handling needed here — these aren't
 * reward-gated, Monetag pays on CPM for the impressions themselves, so
 * nothing on the backend needs to know about them.
 *
 * All five knobs come from admin Settings (see AutoAds.jsx) — call once
 * on app mount; calling it again resets/duplicates the auto-session
 * timer per Monetag's docs, so this is NOT meant to be called from
 * individual screens.
 */
export function enableInAppInterstitial({
  frequency = 6,
  capping = 1,
  interval = 45,
  timeoutSeconds = 7,
  everyPage = true,
} = {}) {
  let showFn;
  try {
    showFn = getShowFn();
  } catch (e) {
    return;
  }
  showFn({
    type: 'inApp',
    inAppSettings: { frequency, capping, interval, timeout: timeoutSeconds, everyPage },
  }).catch(() => {});
}

/**
 * The backend won't credit a reward until Monetag's postback has
 * confirmed the nonce, and that postback can land a second or two after
 * the ad-shown promise above resolves. Rather than fail immediately,
 * retry the confirm-and-spend call briefly.
 */
export async function withConfirmationRetry(callFn, { attempts = 5, delayMs = 1500 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await callFn();
    } catch (e) {
      lastErr = e;
      if (!e.message.includes('not yet confirmed')) throw e;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastErr;
}
