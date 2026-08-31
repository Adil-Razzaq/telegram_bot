const ZONE_ID = import.meta.env?.VITE_MONETAG_ZONE_ID;

/**
 * Rewarded Interstitial — a full-screen ad shown directly inside the app;
 * the Promise resolves once the user has watched it through and closed
 * it. Every reward placement in the app uses this format (spin, referral
 * claim, miner start, and any watch_ad tasks) — a single show_<zoneId>()
 * call with `ymid` set so our nonce round-trips through Monetag's
 * postback the same way it did with the Popup format before it.
 *
 * type: 'end' is Monetag's explicit name for this format (see their SDK
 * reference) — omitting `type` defaults to the same thing, but naming it
 * keeps this readable next to enableInAppInterstitial below.
 */
export function showRewardedAd(nonce) {
  const showFn = window[`show_${ZONE_ID}`];
  if (typeof showFn !== 'function') {
    return Promise.reject(new Error('Monetag SDK not loaded — check VITE_MONETAG_ZONE_ID and index.html'));
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
 * Call once, on app mount — calling it again resets/duplicates the
 * auto-session timer per Monetag's docs, so this is NOT meant to be
 * called from individual screens.
 */
export function enableInAppInterstitial({
  frequency = 6,
  capping = 1,
  interval = 45,
  timeoutSeconds = 7,
  everyPage = true,
} = {}) {
  const showFn = window[`show_${ZONE_ID}`];
  if (typeof showFn !== 'function') return;
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