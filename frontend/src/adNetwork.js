import { showRewardedAd } from './monetag';
import { showAdsgramRewardedAd } from './adsgram';

/**
 * Used by every fixed-action reward flow (spin, miner start/claim,
 * referral claim) to show the ad from whichever network the admin has
 * currently set (Settings → action_ads_network), instead of each
 * component hardcoding Monetag. `adConfig` is the object from
 * api.getConfig() (i.e. /user/config) — needs at minimum
 * action_ads_network and, when that's 'adsgram', adsgram_block_id.
 *
 * A falsy nonce (action_ads_enabled is off — see monetagAds.js's
 * *IfRequired helpers) is a normal case, not an error: just skip
 * showing an ad at all and let the caller proceed straight to its
 * claim/confirm step.
 */
export function showActionAd(nonce, adConfig) {
  if (!nonce) return Promise.resolve();
  if (adConfig?.action_ads_network === 'adsgram') {
    if (!adConfig.adsgram_block_id) {
      return Promise.reject(new Error('Adsgram is selected but no Block ID is set in the admin panel'));
    }
    return showAdsgramRewardedAd(adConfig.adsgram_block_id);
  }
  return showRewardedAd(nonce);
}
