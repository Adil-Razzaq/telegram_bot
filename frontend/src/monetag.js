const ZONE_ID = import.meta.env?.VITE_MONETAG_ZONE_ID;

/**
 * Rewarded Popup — opens the advertiser's page in a new tab/window and
 * resolves once that's happened (not after any "watching" — it's a
 * click-through format, which is why it commands a much higher CPM than
 * Rewarded Interstitial). Every ad placement in the app uses this format
 * now (spin, referral claim, miner start, and any watch_ad tasks) — a
 * single show_<zoneId>() call, same as Monetag's own integration
 * snippet, just with `ymid` added so our nonce round-trips through their
 * postback the same way it did with the Interstitial format.
 *
 * MUST be called directly inside a user gesture (a click handler) — the
 * browser blocks the new tab if anything is awaited before this call.
 */
export function showRewardedAd(nonce) {
  const showFn = window[`show_${ZONE_ID}`];
  if (typeof showFn !== 'function') {
    return Promise.reject(new Error('Monetag SDK not loaded — check VITE_MONETAG_ZONE_ID and index.html'));
  }
  return showFn({ type: 'pop', ymid: nonce });
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
