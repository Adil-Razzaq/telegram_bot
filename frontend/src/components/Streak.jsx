import { useEffect, useState } from 'react';
import { api } from '../api';
import { showRewardedAd, withConfirmationRetry } from '../monetag';
import { showAdsgramRewardedAd } from '../adsgram';
import { playNotificationSound } from '../sound';

export default function Streak({ onBalanceChange }) {
  const [status, setStatus] = useState(null);
  const [config, setConfig] = useState(null);
  const [claimingNetwork, setClaimingNetwork] = useState(null);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);

  async function refresh() {
    try {
      const s = await api.streakStatus();
      setStatus(s);
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }

  useEffect(() => {
    refresh();
    api.getConfig().then(setConfig).catch(() => {});
  }, []);

  // Same nonce -> show ad -> confirm-and-spend pattern as the daily
  // watch-ad task slots (see Tasks.jsx / adWatchService.js) — the user
  // picks which network's ad to watch to claim today's streak reward.
  async function handleClaim(network) {
    setClaimingNetwork(network);
    setError(null);
    try {
      const { nonce } = await api.prepareStreak(network);
      if (network === 'monetag') await showRewardedAd(nonce);
      else await showAdsgramRewardedAd(config?.adsgram_block_id);
      const result = await withConfirmationRetry(() => api.claimStreak(network, nonce));
      onBalanceChange(result.main_balance);
      setToast(result);
      playNotificationSound();
      await refresh();
      setTimeout(() => setToast(null), 4000);
    } catch (e) {
      setError(e.message);
    } finally {
      setClaimingNetwork(null);
    }
  }

  if (!status) {
    return (
      <div className="streak-page">
        <p className="tasks-empty">Loading streak…</p>
      </div>
    );
  }

  const adsgramAvailable = !!config?.adsgram_block_id;

  return (
    <div className="streak-page">
      <h2 className="page-title">7-Day Streak</h2>
      <p className="page-subtitle">Watch an ad every day to keep your streak alive</p>

      {toast && (
        <div className="miner-toast">
          <span className="miner-toast-icon">✓</span>
          <div>
            <div className="miner-toast-title">Streak claimed!</div>
            <div className="miner-toast-body">
              Day {toast.position} — +{toast.earned_points} ADLX added to your balance.
            </div>
          </div>
        </div>
      )}

      <div className="glass-card streak-summary-card">
        <span className="glass-card-icon round streak-fire-icon">🔥</span>
        <div className="glass-card-body">
          <p className="glass-card-title">Current streak</p>
          <p className="glass-card-subtitle">
            {status.consecutive_days} day{status.consecutive_days === 1 ? '' : 's'} in a row · best {status.best_streak}
          </p>
        </div>
      </div>

      <div className="streak-day-grid">
        {status.rewards.map((points, idx) => {
          const day = idx + 1;
          const isCurrent = !status.claimed_today && status.next_position === day;
          const isPast = status.current_position > 0 && day <= status.current_position && !isCurrent;
          return (
            <div
              key={day}
              className={`streak-day-cell${isPast ? ' claimed' : ''}${isCurrent ? ' current' : ''}`}
            >
              <span className="streak-day-label">Day {day}</span>
              <span className="streak-day-points">+{points}</span>
              {isPast && <span className="streak-day-check">✓</span>}
            </div>
          );
        })}
      </div>

      {status.will_reset && (
        <p className="streak-warning">
          You missed a day — claiming now restarts your streak at Day 1.
        </p>
      )}

      {status.claimed_today ? (
        <div className="glass-card">
          <div className="glass-card-body">
            <p className="glass-card-title">Come back tomorrow</p>
            <p className="glass-card-subtitle">You've already claimed today's reward.</p>
          </div>
        </div>
      ) : (
        <>
          <p className="streak-copy">
            Watch an ad to claim Day {status.next_position} — +{status.next_reward} ADLX.
          </p>
          <div className="streak-claim-buttons">
            <button
              className="gold-button streak-claim-button"
              onClick={() => handleClaim('monetag')}
              disabled={claimingNetwork !== null}
            >
              {claimingNetwork === 'monetag' ? 'Loading…' : 'Watch Monetag ad'}
            </button>
            {adsgramAvailable && (
              <button
                className="gold-button streak-claim-button"
                onClick={() => handleClaim('adsgram')}
                disabled={claimingNetwork !== null}
              >
                {claimingNetwork === 'adsgram' ? 'Loading…' : 'Watch Adsgram ad'}
              </button>
            )}
          </div>
        </>
      )}

      {error && <p className="friends-error">{error}</p>}
    </div>
  );
}
