const ZONE_ID = import.meta.env?.VITE_MONETAG_ZONE_ID;

/**
 * Monetag's script tag (see index.html) exposes a global function named
 * show_<yourZoneId> — the name itself embeds your zone ID, which is why
 * this reads it dynamically off `window` rather than importing a fixed
 * function name.
 */
export function showRewardedAd(nonce) {
  const showFn = window[`show_${ZONE_ID}`];
  if (typeof showFn !== 'function') {
    return Promise.reject(new Error('Monetag SDK not loaded — check VITE_MONETAG_ZONE_ID and index.html'));
  }
  // type: 'end' = show a Rewarded Interstitial and resolve once it's
  // closed. ymid is echoed back in Monetag's server-side postback, which
  // is what actually confirms the reward — this promise resolving only
  // means the ad was displayed, not that it's been confirmed yet.
  return showFn({ type: 'end', ymid: nonce });
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
