import { useEffect, useRef, useState } from 'react';
import { api } from '../api';

const POINTS_PER_USD = 10000;

export default function Miner({ mainBalance, onBalanceChange }) {
  const [status, setStatus] = useState(null);
  const [liveAccrued, setLiveAccrued] = useState(0);
  const [claiming, setClaiming] = useState(false);
  const [error, setError] = useState(null);
  const tickRef = useRef(null);
  const pollRef = useRef(null);
  const snapshotRef = useRef({ accruedAt: 0, value: 0, ratePerSecond: 0 });

  async function refreshStatus() {
    try {
      const s = await api.minerStatus();
      setStatus(s);
      snapshotRef.current = {
        accruedAt: Date.now(),
        value: s.accrued_now,
        ratePerSecond: s.rate_per_second,
      };
      setLiveAccrued(s.accrued_now);
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }

  useEffect(() => {
    refreshStatus();
    // Re-sync with the server periodically (it's the source of truth —
    // this local ticking is just a smooth visual between syncs)
    pollRef.current = setInterval(refreshStatus, 20000);
    return () => clearInterval(pollRef.current);
  }, []);

  useEffect(() => {
    tickRef.current = setInterval(() => {
      const { accruedAt, value, ratePerSecond } = snapshotRef.current;
      const elapsed = (Date.now() - accruedAt) / 1000;
      setLiveAccrued(value + elapsed * ratePerSecond);
    }, 150);
    return () => clearInterval(tickRef.current);
  }, []);

  async function handleClaim() {
    setClaiming(true);
    setError(null);
    try {
      const result = await api.minerClaim();
      onBalanceChange(result.main_balance);
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

  const usdValue = liveAccrued / POINTS_PER_USD;
  const canClaim = !claiming && liveAccrued >= 1;

  return (
    <div className="miner-container">
      <div className="miner-stats-row">
        <div className="miner-stat-pill">
          <span className="miner-stat-label">Rate</span>
          <span className="miner-stat-value num">{status.rate_per_day.toFixed(0)} ADLX/day</span>
        </div>
        <div className="miner-stat-pill">
          <span className="miner-stat-label">Boost</span>
          <span className="miner-stat-value num">+{status.boost_percent}%</span>
        </div>
      </div>

      <div className="miner-live-ticker num">
        +{liveAccrued.toFixed(4)}
        <span className="miner-live-ticker-usd">≈ ${usdValue.toFixed(5)}</span>
      </div>

      <div className="miner-coin-wrap">
        <div className="miner-coin-glow" />
        <div className="miner-coin">
          <span>USDT</span>
        </div>
      </div>

      <div className="miner-tier-progress">
        {status.referral_count} referrals · {status.next_tier.referrals_needed} more for
        +{status.next_tier.next_boost_percent}% speed
      </div>

      <button className="miner-claim-button" onClick={handleClaim} disabled={!canClaim}>
        {claiming ? 'Claiming…' : canClaim ? 'Claim' : 'Accumulating…'}
      </button>

      {error && <p className="miner-error">{error}</p>}
    </div>
  );
}
