import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { withConfirmationRetry } from '../monetag';
import { showActionAd } from '../adNetwork';

function formatDuration(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.floor(totalSeconds % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function shortAddress(addr) {
  if (!addr) return '';
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
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
  const [status, setStatus] = useState(null);
  const [config, setConfig] = useState(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  // Live-ticking accrued amount — synced from the server on each poll,
  // then animated locally between polls using rate_per_second so it
  // reads as continuously moving (matching the mockup's pulsing
  // "+70.0379") without hitting the server every frame.
  const [liveAccrued, setLiveAccrued] = useState(0);
  const [starting, setStarting] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const [boosting, setBoosting] = useState(false);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);

  const tickRef = useRef(null);
  const pollRef = useRef(null);
  const toastTimerRef = useRef(null);
  const syncRef = useRef({ accrued: 0, rate: 0, syncedAt: 0 });

  async function refreshStatus() {
    try {
      const s = await api.minerStatus();
      setStatus(s);
      setSecondsLeft(s.seconds_remaining_in_cycle);
      setLiveAccrued(s.accrued_now);
      syncRef.current = { accrued: s.accrued_now, rate: s.rate_per_second, syncedAt: Date.now() };
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
      const { accrued, rate, syncedAt } = syncRef.current;
      if (rate > 0) {
        const elapsedSinceSync = (Date.now() - syncedAt) / 1000;
        // Capped at the cycle's full point target — otherwise once the
        // timer hits zero this local animation just keeps climbing past
        // the true value until the next 15s poll corrects it.
        const cap = status?.current_cycle_points ?? Infinity;
        setLiveAccrued(Math.min(cap, accrued + rate * elapsedSinceSync));
      }
    }, 150); // smooth-ish ticking without being wasteful
    return () => clearInterval(tickRef.current);
  }, [status?.current_cycle_points]);

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
      await showActionAd(nonce, config);
      const result = await withConfirmationRetry(() => api.startMiner(nonce));
      setStatus(result);
      setSecondsLeft(result.seconds_remaining_in_cycle);
      setLiveAccrued(result.accrued_now);
      syncRef.current = { accrued: result.accrued_now, rate: result.rate_per_second, syncedAt: Date.now() };
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

  // Once per cycle: watch an ad to compress the REMAINING time by
  // status.boost_multiplier (server-controlled, e.g. 3x) — same total
  // reward for this cycle, just reached sooner. Server re-derives the
  // new cycle_ends_at itself; refreshStatus() below picks up the
  // shortened countdown and the faster rate_per_second automatically.
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
      setLiveAccrued(result.accrued_now);
      syncRef.current = { accrued: result.accrued_now, rate: result.rate_per_second, syncedAt: Date.now() };
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
        <p className="miner-copy">
          {formatDuration(secondsLeft)} left in this cycle — claim anytime for what's accrued so far,
          or wait for it to finish.
        </p>
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
          {boosting ? 'Loading…' : `⚡ Watch ad for ${status.boost_multiplier}x speed`}
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
