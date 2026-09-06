import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { withConfirmationRetry } from '../monetag';
import { playNotificationSound } from '../sound';

/**
 * Adsgram's "Task" format block — a passive web component
 * (<adsgram-task>, registered globally once sad.min.js loads in
 * index.html) that Adsgram rotates and displays on ITS OWN schedule,
 * firing a `reward` custom event whenever it decides a view counted.
 * Unlike every other ad flow in this app, there's no button click to
 * hang a "prepare a nonce, then show the ad" sequence off of — the ad
 * just appears and rewards whenever it feels like it.
 *
 * So instead: keep exactly one nonce "armed" (nonceRef) at all times
 * while watching is still allowed today. When `reward` fires, grab
 * whatever's currently armed and try to claim it — same
 * nonce-plus-server-postback confirmation as everywhere else, just
 * triggered by the widget's event instead of a click handler. After a
 * claim attempt (success or fail), re-arm a fresh nonce if the daily
 * limit hasn't been hit.
 */
export default function AdsgramTaskBanner({ onBalanceChange }) {
  const [status, setStatus] = useState(null);
  const containerRef = useRef(null);
  const nonceRef = useRef(null);
  const armingRef = useRef(false); // guards against double-arming from overlapping calls

  async function refreshStatus() {
    try {
      const res = await api.taskBannerStatus();
      setStatus(res.status);
      return res.status;
    } catch (e) {
      return null;
    }
  }

  async function armNonce(currentStatus) {
    if (armingRef.current) return;
    if (!currentStatus?.can_watch || nonceRef.current) return;
    armingRef.current = true;
    try {
      const { nonce } = await api.prepareTaskBanner();
      nonceRef.current = nonce;
    } catch (e) {
      // Likely hit the daily limit between status check and prepare —
      // fine, just don't arm; the widget staying blocked is correct.
    } finally {
      armingRef.current = false;
    }
  }

  useEffect(() => {
    refreshStatus().then(armNonce);
  }, []);

  // Attach the `reward` listener directly on the custom element (React
  // has no prop for custom DOM events), and re-attach if the element
  // itself gets replaced (e.g. block ID changes and React remounts it
  // via the key below).
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return undefined;

    async function onReward() {
      const nonce = nonceRef.current;
      nonceRef.current = null; // consumed (or about to fail) either way — never reused
      if (!nonce) return;
      try {
        const result = await withConfirmationRetry(() => api.claimTaskBanner(nonce));
        onBalanceChange?.(result.main_balance);
        playNotificationSound();
      } catch (e) {
        // Network's own postback never confirmed it (e.g. a non-valued
        // view) — nothing to credit, same "network decides" principle
        // as every other ad flow here.
      }
      const fresh = await refreshStatus();
      armNonce(fresh);
    }

    el.addEventListener('reward', onReward);
    return () => el.removeEventListener('reward', onReward);
  }, [status?.block_id]);

  if (!status || !status.block_id || !status.can_watch) return null;

  return (
    <div className="task-banner-wrap">
      {/* key forces a clean remount if the admin changes the block ID
          mid-session, rather than the custom element trying to react
          to an attribute change on its own. */}
      <adsgram-task
        key={status.block_id}
        ref={containerRef}
        data-block-id={status.block_id}
        class="task-banner-widget"
      />
    </div>
  );
}
