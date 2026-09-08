import { showRewardedAd } from './monetag';
import { showAdsgramRewardedAd } from './adsgram';

function showViaNetwork(network, nonce, adConfig) {
  if (network === 'adsgram') {
    if (!adConfig?.adsgram_block_id) {
      return Promise.reject(new Error('Adsgram is selected but no Block ID is set in the admin panel'));
    }
    return showAdsgramRewardedAd(adConfig.adsgram_block_id);
  }
  return showRewardedAd(nonce);
}

/**
 * Shared by every ad-gated flow that can be switched between networks
 * per its OWN admin setting — action_ads_network (spin/miner/referral),
 * streak_ad_network (the streak tab), each independent of the others
 * and of auto_ad_network. `network` is that setting's current value,
 * `adConfig` is the full /user/config object (needed for
 * adsgram_block_id when network is 'adsgram').
 *
 * A falsy nonce (the relevant *_ads_enabled flag is off — see
 * monetagAds.js's *IfRequired helpers) is a normal case, not an error:
 * just skip showing an ad at all and let the caller proceed straight to
 * its claim/confirm step.
 *
 * NO cross-network fallback: only the admin-selected network is tried.
 * If it has no fill (or is misconfigured), this rejects and the caller
 * (spin/miner/referral/streak) never proceeds to its claim step — no ad
 * watched still means no reward. (Previously this retried the other
 * network with the same nonce before giving up — removed on request.)
 */
export function showAdForNetwork(nonce, network, adConfig) {
  if (!nonce) return Promise.resolve();
  return showViaNetwork(network, nonce, adConfig);
}

/** Convenience wrapper for the spin/miner/referral flows specifically. */
export function showActionAd(nonce, adConfig) {
  return showAdForNetwork(nonce, adConfig?.action_ads_network, adConfig);
}

/** Convenience wrapper for the streak tab specifically. */
export function showStreakAd(nonce, adConfig) {
  return showAdForNetwork(nonce, adConfig?.streak_ad_network, adConfig);
}

