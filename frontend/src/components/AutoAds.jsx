import { useEffect, useRef } from 'react';
import { enableInAppInterstitial } from '../monetag';
import { showAdsgramInterstitial } from '../adsgram';

/**
 * Renders nothing — just sets up the passive/auto ad schedule per admin
 * Settings (auto_ad_enabled, auto_ad_first_enabled, auto_ad_network,
 * auto_ad_first_delay_seconds, auto_ad_interval_seconds,
 * auto_ad_frequency, auto_ad_capping_hours, adsgram_block_id). Mounted
 * once from App.jsx after /user/config has loaded (and, since rewarded
 * ads always need it too, after initMonetag() has already been kicked
 * off there).
 *
 * Adsgram block id: uses adsgram_interstitial_block_id (a separate
 * block from the Rewarded one used for actions), falling back to
 * adsgram_block_id if that's not set.
 *
 * DECOUPLED ON PURPOSE, in two separate effects below:
 *   - Effect 1 (STARTUP): the very first ad on app open. Gated ONLY by
 *     auto_ad_first_enabled — runs regardless of auto_ad_enabled, so
 *     turning off the "rest" of passive ads never removes the startup
 *     one.
 *   - Effect 2 (REPEAT): the interval + tab-switch re-shows. Gated by
 *     auto_ad_enabled, entirely independent of Effect 1.
 * Both can be on, either alone, or neither — every combination works.
 *
 * Monetag: Monetag's own SDK handles scheduling internally per show_()
 * call. Effect 1 asks for exactly one impression (frequency: 1, a huge
 * capping window) so it never repeats on its own; Effect 2 (if enabled)
 * makes its own separate call with the admin's real frequency/interval/
 * capping and everyPage:true. Calling show_() a second time with new
 * inAppSettings just updates Monetag's running session rather than
 * stacking two competing schedules, so having both effects call it is
 * safe.
 *
 * Adsgram: has no scheduling API — show() just shows one ad immediately
 * when called. So Effect 1's delay and Effect 2's interval/tab-switch
 * detection (Page Visibility API) and frequency cap are implemented
 * here in plain JS. Both effects share one `shownTimestamps` ref so the
 * cap counts every impression, startup included.
 */
export default function AutoAds({ config }) {
  const shownTimestamps = useRef([]);

  function underCap(cappingHours, frequency) {
    const cappingMs = cappingHours * 60 * 60 * 1000;
    const now = Date.now();
    shownTimestamps.current = shownTimestamps.current.filter((ts) => now - ts < cappingMs);
    return shownTimestamps.current.length < frequency;
  }

  // Effect 1 — STARTUP ad. Independent of auto_ad_enabled.
  useEffect(() => {
    if (!config || config.auto_ad_first_enabled === false) return undefined;

    if (config.auto_ad_network === 'monetag') {
      const t = setTimeout(() => {
        enableInAppInterstitial({
          frequency: 1,
          capping: 24 * 365, // ~once a year via THIS call = effectively a single one-off show
          interval: config.auto_ad_interval_seconds,
          timeoutSeconds: 0, // we already waited via this setTimeout
          everyPage: false,
        });
      }, config.auto_ad_first_delay_seconds * 1000);
      return () => clearTimeout(t);
    }

    // network === 'adsgram'
    const blockId = config.adsgram_interstitial_block_id || config.adsgram_block_id;
    if (!blockId) return undefined;

    const t = setTimeout(() => {
      if (!underCap(config.auto_ad_capping_hours, config.auto_ad_frequency)) return;
      shownTimestamps.current.push(Date.now());
      showAdsgramInterstitial(blockId).catch(() => {});
    }, config.auto_ad_first_delay_seconds * 1000);
    return () => clearTimeout(t);
  }, [
    config?.auto_ad_first_enabled,
    config?.auto_ad_network,
    config?.auto_ad_first_delay_seconds,
    config?.adsgram_block_id,
    config?.adsgram_interstitial_block_id,
    config?.auto_ad_capping_hours,
    config?.auto_ad_frequency,
  ]);

  // Effect 2 — REPEAT ads (interval + tab-switch). Independent of
  // auto_ad_first_enabled / Effect 1 above.
  useEffect(() => {
    if (!config?.auto_ad_enabled) return undefined;

    if (config.auto_ad_network === 'monetag') {
      // Own separate call from Effect 1 — see comment above the
      // component for why running both is safe. First REPEAT fire is
      // one full interval after mount (Effect 1 already covers the
      // very first impression when it's enabled; when it's not, this
      // is simply the first ad the user sees).
      enableInAppInterstitial({
        frequency: config.auto_ad_frequency,
        capping: config.auto_ad_capping_hours,
        interval: config.auto_ad_interval_seconds,
        timeoutSeconds: config.auto_ad_interval_seconds,
        everyPage: true,
      });
      return undefined;
    }

    // network === 'adsgram'
    const blockId = config.adsgram_interstitial_block_id || config.adsgram_block_id;
    if (!blockId) return undefined;

    function tryShow() {
      if (!underCap(config.auto_ad_capping_hours, config.auto_ad_frequency)) return;
      shownTimestamps.current.push(Date.now());
      showAdsgramInterstitial(blockId).catch(() => {});
    }

    const intervalTimer = setInterval(tryShow, config.auto_ad_interval_seconds * 1000);

    // "when tab switches" — fires when the user returns to this tab
    // after switching away (or reopening a minimized Telegram app).
    function onVisibilityChange() {
      if (document.visibilityState === 'visible') tryShow();
    }
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      clearInterval(intervalTimer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [
    config?.auto_ad_enabled,
    config?.auto_ad_network,
    config?.adsgram_block_id,
    config?.adsgram_interstitial_block_id,
    config?.auto_ad_interval_seconds,
    config?.auto_ad_frequency,
    config?.auto_ad_capping_hours,
  ]);

  return null;
}
