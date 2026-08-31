import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { showRewardedAd, withConfirmationRetry } from '../monetag';

// Redesigned from a passive always-on miner into: tap Start (watch a
// Rewarded Popup ad) -> runs for a fixed cycle length -> stops on its
// own -> tap Claim (this is the ONLY moment a toast notification
// appears, per spec) -> tap Start again for the next cycle, up to a
// daily cap. Every number (cycle length, cycles/day, daily points, $
// value) comes from the backend's /user/config + /miner/status, not
// hardcoded — an admin can change all of it live via Settings.

function formatDuration(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.floor(totalSeconds % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export default function Miner({ onBalanceChange }) {
  const [status, setStatus] = useState(null);
  const [config, setConfig] = useState(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [starting, setStarting] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);
  const tickRef = useRef(null);
  const pollRef = useRef(null);
  const toastTimerRef = useRef(null);

  async function refreshStatus() {
    try {
      const s = await api.minerStatus();
      setStatus(s);
      setSecondsLeft(s.seconds_remaining_in_cycle);
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }

  useEffect(() => {
    api.getConfig().then(setConfig).catch(() => {});
    refreshStatus();
    pollRef.current = setInterval(refreshStatus, 15000);
    return () => clearInterval(pollRef.current);
  }, []);

  useEffect(() => {
    tickRef.current = setInterval(() => {
      setSecondsLeft((s) => (s > 0 ? s - 1 : 0));
    }, 1000);
    return () => clearInterval(tickRef.current);
  }, []);

  function showToast(points) {
    setToast(points);
    clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), 4000);
  }

  async function handleStart() {
    if (starting) return;
    setStarting(true);
    setError(null);
    try {
      const { nonce } = await api.prepareMinerStart();
      await showRewardedAd(nonce);
      const result = await withConfirmationRetry(() => api.startMiner(nonce));
      setStatus(result);
      setSecondsLeft(result.seconds_remaining_in_cycle);
    } catch (e) {
      setError(e.message);
    } finally {
      setStarting(false);
    }
  }

  async function handleClaim() {
    if (claiming) return;
    setClaiming(true);
    setError(null);
    try {
      const result = await api.minerClaim();
      onBalanceChange(result.main_balance);
      showToast(result.earned_points); // ONLY place in the app a claim toast fires
      await refreshStatus();
    } catch (e) {
      setError(e.message);
    } finally {
      setClaiming(false);
    }
  }

  if (!status) {
    return <div className="miner-container">Loading miner…</div>;
  }

  const pointsPerUsd = config?.points_per_usd || 10000;
  const cycleFinished = status.status === 'running' && secondsLeft <= 0;

  return (
    <div className="miner-container">
      {toast !== null && (
        <div className="miner-toast">
          <span className="miner-toast-icon">✓</span>
          <div>
            <div className="miner-toast-title">Claimed!</div>
            <div className="miner-toast-body">
              Added {toast} ADLX (${(toast / pointsPerUsd).toFixed(4)}) to your balance.
            </div>
          </div>
        </div>
      )}

      <div className="miner-stats-row">
        <div className="miner-stat-pill">
          <span className="miner-stat-label">Daily total</span>
          <span className="miner-stat-value num">{status.daily_points} ADLX</span>
        </div>
        <div className="miner-stat-pill">
          <span className="miner-stat-label">Cycles left today</span>
          <span className="miner-stat-value num">
            {status.cycles_remaining_today} / {status.cycles_per_day}
          </span>
        </div>
      </div>

      <div className="miner-coin-wrap">
        <div className="miner-coin-glow" />
        <div className="miner-coin-ring r1" />
        <div className="miner-coin-ring r2" />
        <div className="miner-coin-ring r3" />
        <div className="miner-coin">
          <img src="/coin.png" alt="Coin" />
        </div>
      </div>

      {status.status === 'idle' && status.cycles_remaining_today > 0 && (
        <>
          <p className="miner-copy">
            Watch a short ad to start a {status.cycle_hours}h mining cycle worth ~
            {status.next_cycle_points} points (${(status.next_cycle_points / pointsPerUsd).toFixed(4)}).
          </p>
          <button className="miner-claim-button" onClick={handleStart} disabled={starting}>
            {starting ? 'Loading…' : 'Watch ad & Start mining'}
          </button>
        </>
      )}

      {status.status === 'running' && !cycleFinished && (
        <>
          <div className="miner-live-ticker num">{formatDuration(secondsLeft)}</div>
          <p className="miner-copy">Mining in progress — come back when the timer finishes.</p>
        </>
      )}

      {cycleFinished && (
        <>
          <p className="miner-copy">Cycle finished! Claim your points.</p>
          <button className="miner-claim-button" onClick={handleClaim} disabled={claiming}>
            {claiming ? 'Claiming…' : 'Claim'}
          </button>
        </>
      )}

      {status.status === 'idle' && status.cycles_remaining_today === 0 && (
        <p className="miner-copy">
          You've used all {status.cycles_per_day} mining cycles today — come back tomorrow.
        </p>
      )}

      {error && <p className="miner-error">{error}</p>}
    </div>
  );
}
