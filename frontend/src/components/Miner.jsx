import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { withConfirmationRetry } from '../monetag';
import { showActionAd } from '../adNetwork';
import { playNotificationSound } from '../sound';

function formatDuration(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.floor(totalSeconds % 60);
  return { h: String(h).padStart(2, '0'), m: String(m).padStart(2, '0'), s: String(s).padStart(2, '0') };
}

// The single source of truth for the ticking display: a stable anchor
// (cycle_started_at, which only changes on a fresh Start) plus a rate —
// never re-derived from a periodically-floored snapshot (accrued_now),
// which is what caused the "counts up then snaps back to a whole
// number" glitch this replaces. Both Start and Boost responses, and
// every 15s poll, all funnel through this one function so the number
// only ever climbs, never resets.
function computeSyncFromStatus(s) {
  if (!s || s.status !== 'running') return { startedAt: 0, rate: 0, cap: 0 };
  return {
    startedAt: new Date(s.cycle_started_at + 'Z').getTime(),
    rate: s.rate_per_second,
    cap: s.current_cycle_points,
  };
}
function readSync(sync) {
  if (!sync.rate) return 0;
  const elapsed = (Date.now() - sync.startedAt) / 1000;
  return Math.min(sync.cap, sync.rate * elapsed);
}

function shortAddress(addr) {
  if (!addr) return '';
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

// Purely a "don't show a blank flash while refetching" cache — never
// trusted for anything that pays out. A full Telegram Mini App
// close-and-reopen destroys all React state, so without this the miner
// screen would briefly show "Loading miner…" (blank, no numbers) before
// the real /miner/status call resolves, which reads as "it reset" even
// though the server-side progress was never actually lost. Reading this
// stale cache first — then immediately overwriting it with the real
// server response — closes that visual gap.
const STATUS_CACHE_KEY = 'miner_status_cache_v1';
function readCachedStatus() {
  try {
    const raw = localStorage.getItem(STATUS_CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}
function writeCachedStatus(status) {
  try {
    localStorage.setItem(STATUS_CACHE_KEY, JSON.stringify(status));
  } catch (e) {
    // Storage full/unavailable — fine, this is a pure UX nicety.
  }
}

export default function Miner({
  displayName,
  mainBalance,
  onBalanceChange,
  connectedWallet,
  walletConnecting,
  onConnectWallet,
  onDisconnectWallet,
}) {
  const cached = useRef(readCachedStatus()).current;
  const [status, setStatus] = useState(cached?.status ?? null);
  const [config, setConfig] = useState(null);
  const [secondsLeft, setSecondsLeft] = useState(() => {
    if (!cached?.status || cached.status.status !== 'running') return 0;
    // Adjust for wall-clock time that passed while the app was fully
    // closed — a raw replay of the cached number would count down from
    // a stale, too-high value for a moment before the real fetch
    // corrects it.
    const elapsedSinceCache = (Date.now() - cached.cachedAt) / 1000;
    return Math.max(0, cached.status.seconds_remaining_in_cycle - elapsedSinceCache);
  });
  // Live-ticking accrued amount — derived continuously from
  // computeSyncFromStatus/readSync (see those for why), not directly
  // from the cached snapshot's accrued_now.
  const [liveAccrued, setLiveAccrued] = useState(() => readSync(computeSyncFromStatus(cached?.status)));
  const [starting, setStarting] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const [boosting, setBoosting] = useState(false);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);

  const tickRef = useRef(null);
  const pollRef = useRef(null);
  const toastTimerRef = useRef(null);
  // Deliberately NOT keyed off accrued_now (a floored integer, re-sent
  // every 15s poll) — animating from that caused the exact glitch being
  // fixed here: the decimal climbs smoothly for 15s then snaps back to
  // a whole number the instant a poll lands. Instead this derives the
  // displayed value purely from elapsed time × rate, anchored to
  // cycle_started_at, which never changes between polls (only a fresh
  // Start/Boost legitimately changes it) — so there's nothing to snap
  // back to, the number only ever climbs.
  const syncRef = useRef(computeSyncFromStatus(cached?.status));

  async function refreshStatus() {
    try {
      const s = await api.minerStatus();
      setStatus(s);
      setSecondsLeft(s.seconds_remaining_in_cycle);
      syncRef.current = computeSyncFromStatus(s);
      setLiveAccrued(readSync(syncRef.current));
      writeCachedStatus({ status: s, cachedAt: Date.now() });
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
      setLiveAccrued(readSync(syncRef.current));
    }, 150); // smooth-ish ticking without being wasteful
    return () => clearInterval(tickRef.current);
  }, []);

  function showToast(points) {
    setToast(points);
    playNotificationSound();
    clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), 4000);
  }

  async function handleStart() {
    if (starting) return;
    setStarting(true);
    setError(null);
    try {
      const { nonce } = await api.prepareMinerStart();
      await showActionAd(nonce, config);
      const result = await withConfirmationRetry(() => api.startMiner(nonce));
      setStatus(result);
      setSecondsLeft(result.seconds_remaining_in_cycle);
      syncRef.current = computeSyncFromStatus(result);
      setLiveAccrued(readSync(syncRef.current));
      writeCachedStatus({ status: result, cachedAt: Date.now() });
    } catch (e) {
      setError(e.message);
    } finally {
      setStarting(false);
    }
  }

  // Claim works ANY TIME while a cycle is running — pays out whatever's
  // accrued so far (server recomputes it independently, never trusts
  // the client's number) and ends that cycle. Ad-gated, same pattern as
  // Start.
  async function handleClaim() {
    if (claiming) return;
    setClaiming(true);
    setError(null);
    try {
      const { nonce } = await api.prepareMinerClaim();
      await showActionAd(nonce, config);
      const result = await withConfirmationRetry(() => api.minerClaim(nonce));
      onBalanceChange(result.main_balance);
      showToast(result.earned_points);
      await refreshStatus();
    } catch (e) {
      setError(e.message);
    } finally {
      setClaiming(false);
    }
  }

  // Once per cycle: watch an ad to MULTIPLY this cycle's point target by
  // status.boost_multiplier (server-controlled, e.g. 3x — 25 becomes 75,
  // not "reached faster"). Timing is untouched. Server re-derives
  // current_cycle_points/rate_per_second/accrued_now itself; applying
  // the response directly here picks up the bigger numbers immediately.
  async function handleBoost() {
    if (boosting) return;
    setBoosting(true);
    setError(null);
    try {
      const { nonce } = await api.prepareMinerBoost();
      await showActionAd(nonce, config);
      const result = await withConfirmationRetry(() => api.activateMinerBoost(nonce));
      setStatus(result);
      setSecondsLeft(result.seconds_remaining_in_cycle);
      syncRef.current = computeSyncFromStatus(result);
      setLiveAccrued(readSync(syncRef.current));
      writeCachedStatus({ status: result, cachedAt: Date.now() });
      playNotificationSound();
    } catch (e) {
      setError(e.message);
    } finally {
      setBoosting(false);
    }
  }

  if (!status) {
    return <div className="miner-container">Loading miner…</div>;
  }

  const pointsPerUsd = config?.points_per_usd || 10000;
  const holding = mainBalance;
  const pool = liveAccrued;
  const assets = holding + pool;
  const isRunning = status.status === 'running';
  // Client-side derived from the locally-ticked countdown (not just
  // status.cycle_complete from the last poll) so the UI flips the
  // instant the timer visually hits zero, rather than lagging up to the
  // 15s poll interval. Payout is always server-recomputed at claim time
  // regardless, so there's no trust issue in acting on this early.
  const cycleComplete = isRunning && secondsLeft <= 0;
  const activelyRunning = isRunning && !cycleComplete;
  const canRestart = status.status === 'idle' && status.cycles_remaining_today > 0;
  const outOfCycles = status.status === 'idle' && status.cycles_remaining_today === 0;

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

      {/* Mine-tab-only header: real name left, wallet status right.
          "Verified" elsewhere in the app (Profile) is derived from this
          same connectedWallet value — one wallet, one source of truth. */}
      <div className="miner-header">
        <span className="miner-header-name">{displayName || 'Player'}</span>
        {connectedWallet ? (
          <span className="miner-header-wallet connected">🔗 {shortAddress(connectedWallet)}</span>
        ) : (
          <button
            className="miner-header-wallet connect"
            onClick={onConnectWallet}
            disabled={walletConnecting}
          >
            {walletConnecting ? 'Connecting…' : 'Connect Wallet'}
          </button>
        )}
      </div>

      <div className="miner-assets">
        <p className="miner-assets-label">Assets</p>
        <h1 className="miner-assets-value num">
          {assets.toFixed(4)} <span className="miner-assets-unit">ADLX</span>
        </h1>
        <div className="miner-wallet-pills">
          <div className="miner-wallet-pill">
            <span>Holding Wallet:</span>
            <strong className="num">{holding.toFixed(3)} ADLX</strong>
          </div>
          <div className="miner-wallet-pill pool">
            <span>Pool Wallet:</span>
            <strong className="num">{pool.toFixed(4)} ADLX</strong>
          </div>
        </div>
      </div>

      {isRunning && (
        <div className="miner-live-rate num">+{liveAccrued.toFixed(4)}</div>
      )}
      {status.boost_active && (
        <div className="miner-boost-badge">⚡ {status.boost_multiplier}x boost active</div>
      )}

      <div className={`miner-coin-wrap${cycleComplete ? ' miner-coin-complete' : ''}`}>
        <div className="miner-coin-glow" />
        {activelyRunning && (
          <>
            <div className="miner-coin-ring r1" />
            <div className="miner-coin-ring r2" />
            <div className="miner-coin-ring r3" />
          </>
        )}
        <div className="miner-coin">
          <img src="/coin.png" alt="Coin" />
        </div>
      </div>

      {activelyRunning && (
        <>
          <div className="miner-countdown">
            {(() => {
              const { h, m, s } = formatDuration(secondsLeft);
              return (
                <>
                  <span className="miner-countdown-seg">
                    <span className="miner-countdown-num">{h}</span>
                    <span className="miner-countdown-label">HRS</span>
                  </span>
                  <span className="miner-countdown-colon">:</span>
                  <span className="miner-countdown-seg">
                    <span className="miner-countdown-num">{m}</span>
                    <span className="miner-countdown-label">MIN</span>
                  </span>
                  <span className="miner-countdown-colon">:</span>
                  <span className="miner-countdown-seg">
                    <span className="miner-countdown-num">{s}</span>
                    <span className="miner-countdown-label">SEC</span>
                  </span>
                </>
              );
            })()}
          </div>
          <p className="miner-copy">
            left in this cycle — claim anytime for what's accrued so far, or wait for it to finish.
          </p>
        </>
      )}
      {cycleComplete && (
        <p className="miner-copy miner-copy-complete">
          Cycle complete — {liveAccrued.toFixed(4)} ADLX ready. Tap below to claim it.
        </p>
      )}
      {canRestart && (
        <p className="miner-copy">
          Watch a short ad to start a {status.cycle_hours}h cycle worth ~{status.next_cycle_points} ADLX.
          {' '}({status.cycles_remaining_today} of {status.cycles_per_day} cycles left today)
        </p>
      )}
      {outOfCycles && (
        <p className="miner-copy">
          You've used all {status.cycles_per_day} mining cycles today — come back tomorrow.
        </p>
      )}

      {status.can_boost && (
        <button className="miner-boost-button" onClick={handleBoost} disabled={boosting}>
          {boosting ? 'Loading…' : `⚡ Watch ad for ${status.boost_multiplier}x rewards`}
        </button>
      )}
      {isRunning && (
        <button className="miner-claim-button" onClick={handleClaim} disabled={claiming}>
          {claiming ? 'Claiming…' : 'Watch ad & Claim'}
        </button>
      )}
      {canRestart && (
        <button className="miner-claim-button" onClick={handleStart} disabled={starting}>
          {starting ? 'Loading…' : status.cycles_completed_today > 0 ? 'Restart Cycle' : 'Start Mining'}
        </button>
      )}

      {error && <p className="miner-error">{error}</p>}
    </div>
  );
}
