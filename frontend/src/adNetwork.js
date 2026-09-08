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
 * FALLBACK: if the admin-selected network has no fill (or is
 * misconfigured), automatically try the OTHER network with the SAME
 * nonce before giving up — see monetagAds.js: confirmation matches by
 * exact nonce (Monetag) or oldest-pending-row-for-this-user (Adsgram),
 * neither cares which network the frontend actually showed the ad
 * through. This can only ever result in a reward if a real ad from
 * EITHER network gets confirmed by its own postback; if both networks
 * fail to serve one, this rejects and the caller (spin/miner/referral/
 * streak) never proceeds to its claim step — no ad watched still means
 * no reward, exactly as before, just resilient to one network's
 * temporary no-fill instead of blocking the user outright.
 */
export function showAdForNetwork(nonce, network, adConfig) {
  if (!nonce) return Promise.resolve();
  const fallbackNetwork = network === 'adsgram' ? 'monetag' : 'adsgram';
  return showViaNetwork(network, nonce, adConfig).catch((primaryErr) =>
    showViaNetwork(fallbackNetwork, nonce, adConfig).catch(() => {
      // Surface the ORIGINAL (admin-selected network's) error — more
      // actionable for debugging than the fallback's, which is often
      // just "no Block ID configured" for whichever network isn't the
      // primary one in use.
      throw primaryErr;
    })
  );
}

/** Convenience wrapper for the spin/miner/referral flows specifically. */
export function showActionAd(nonce, adConfig) {
  return showAdForNetwork(nonce, adConfig?.action_ads_network, adConfig);
}

/** Convenience wrapper for the streak tab specifically. */
export function showStreakAd(nonce, adConfig) {
  return showAdForNetwork(nonce, adConfig?.streak_ad_network, adConfig);
}
