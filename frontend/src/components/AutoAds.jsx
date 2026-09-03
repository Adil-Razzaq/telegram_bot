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
 * Monetag: Monetag's own SDK handles ALL scheduling internally
 * (first-delay, interval, frequency/capping, AND re-showing on tab
 * switches via everyPage:true) — enableInAppInterstitial is called once
 * and Monetag does the rest; no JS timers needed on our side.
 *
 * Adsgram: has no equivalent scheduling API — show() just shows one ad
 * immediately when called. So the first-delay timer, repeat interval,
 * tab-switch detection (via the Page Visibility API), and frequency cap
 * are all implemented here in plain JS.
 */
export default function AutoAds({ config }) {
  const shownTimestamps = useRef([]);

  useEffect(() => {
    if (!config?.auto_ad_enabled) return undefined;

    const firstEnabled = config.auto_ad_first_enabled !== false;

    if (config.auto_ad_network === 'monetag') {
      // Monetag's own scheduler bundles "first" + "repeat" into one
      // internal timer (timeout, then interval from then on) — there's
      // no separate on/off for just the first one in their API. To
      // honor auto_ad_first_enabled = false, we just start that
      // internal timer later: at first_delay + interval instead of
      // first_delay, so its own "first" firing lands where the SECOND
      // one would have been, and every firing after that follows the
      // normal interval from there.
      const startDelay = firstEnabled
        ? config.auto_ad_first_delay_seconds
        : config.auto_ad_first_delay_seconds + config.auto_ad_interval_seconds;
      const t = setTimeout(() => {
        enableInAppInterstitial({
          frequency: config.auto_ad_frequency,
          capping: config.auto_ad_capping_hours,
          interval: config.auto_ad_interval_seconds,
          timeoutSeconds: 0, // we already waited startDelay via this setTimeout
          everyPage: true,
        });
      }, startDelay * 1000);
      return () => clearTimeout(t);
    }

    // network === 'adsgram'
    const blockId = config.adsgram_block_id;
    if (!blockId) return undefined;

    const cappingMs = config.auto_ad_capping_hours * 60 * 60 * 1000;

    function underCap() {
      const now = Date.now();
      shownTimestamps.current = shownTimestamps.current.filter((ts) => now - ts < cappingMs);
      return shownTimestamps.current.length < config.auto_ad_frequency;
    }

    function tryShow() {
      if (!underCap()) return;
      shownTimestamps.current.push(Date.now());
      showAdsgramInterstitial(blockId).catch(() => {});
    }

    // firstEnabled = false just skips THIS call — the interval timer
    // below still starts counting from mount either way, so the
    // recurring schedule is unaffected by skipping the first one.
    const firstTimer = setTimeout(() => {
      if (firstEnabled) tryShow();
    }, config.auto_ad_first_delay_seconds * 1000);
    const intervalTimer = setInterval(tryShow, config.auto_ad_interval_seconds * 1000);

    // "when tab switches" — fires when the user returns to this tab
    // after switching away (or reopening a minimized Telegram app).
    function onVisibilityChange() {
      if (document.visibilityState === 'visible') tryShow();
    }
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      clearTimeout(firstTimer);
      clearInterval(intervalTimer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [
    config?.auto_ad_enabled,
    config?.auto_ad_first_enabled,
    config?.auto_ad_network,
    config?.adsgram_block_id,
    config?.auto_ad_first_delay_seconds,
    config?.auto_ad_interval_seconds,
    config?.auto_ad_frequency,
    config?.auto_ad_capping_hours,
  ]);

  return null;
}
