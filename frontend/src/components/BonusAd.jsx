import { useState } from 'react';
import { api } from '../api';
import { showRewardedAd, withConfirmationRetry } from '../monetag';

/**
 * The ONLY ad placement left in the app, and it's entirely optional —
 * nothing else (spin, miner, referral status) requires it. The reward
 * isn't a flat number: it's 50% of whatever Monetag actually reports the
 * ad earned (see backend/services/bonusAdService.js), so it scales with
 * real ad revenue instead of ever being a flat amount disconnected from it.
 */
export default function BonusAd({ onBalanceChange }) {
  const [loading, setLoading] = useState(false);
  const [lastReward, setLastReward] = useState(null);
  const [error, setError] = useState(null);

  async function handleWatchAd() {
    if (loading) return;
    setError(null);
    setLastReward(null);
    setLoading(true);
    try {
      const { nonce } = await api.prepareBonusAd();
      await showRewardedAd(nonce);
      const result = await withConfirmationRetry(() => api.claimBonusAd(nonce));
      setLastReward(result.points_awarded);
      onBalanceChange(result.main_balance);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="bonus-ad">
      <h3>Bonus points</h3>
      <p className="bonus-ad-copy">
        Optional — watch a short ad and get points based on what it earns. Everything else in
        the app works with zero ads.
      </p>
      <button className="bonus-ad-button" onClick={handleWatchAd} disabled={loading}>
        {loading ? 'Loading…' : 'Watch ad for bonus points'}
      </button>
      {lastReward !== null && <p className="bonus-ad-success">+{lastReward} points, thanks!</p>}
      {error && <p className="bonus-ad-error">{error}</p>}
    </div>
  );
}
