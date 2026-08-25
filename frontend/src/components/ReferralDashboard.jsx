import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';

const DAILY_CAP = 20;
const COOLDOWN_SECONDS = 60;

export default function ReferralDashboard({ telegramId, onBalanceChange }) {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [claiming, setClaiming] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const timerRef = useRef(null);

  const refLink = telegramId ? `https://t.me/YourBot?start=ref_${telegramId}` : '';

  const refreshStatus = useCallback(async () => {
    try {
      const s = await api.referralStatus();
      setStatus(s);
      if (s.last_ref_claim_at) {
        const elapsed = (Date.now() - new Date(s.last_ref_claim_at).getTime()) / 1000;
        setSecondsLeft(Math.max(0, Math.ceil(COOLDOWN_SECONDS - elapsed)));
      }
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);

  useEffect(() => {
    if (secondsLeft <= 0) {
      clearInterval(timerRef.current);
      return;
    }
    timerRef.current = setInterval(() => {
      setSecondsLeft((s) => Math.max(0, s - 1));
    }, 1000);
    return () => clearInterval(timerRef.current);
  }, [secondsLeft]);

  async function handleClaim() {
    setError(null);
    setClaiming(true);
    try {
      if (!window.Adsgram) throw new Error('Adsgram SDK not loaded');
      const AdController = window.Adsgram.init({ blockId: import.meta.env?.VITE_ADSGRAM_BLOCK_ID });
      const result = await AdController.show();
      const adToken = result?.token || result?.rewardToken || null;

      const claimResult = await api.claimReferral(adToken);
      setStatus((prev) => ({ ...prev, ...claimResult }));
      onBalanceChange(claimResult.main_balance);
      setSecondsLeft(COOLDOWN_SECONDS);
    } catch (e) {
      setError(e.message);
    } finally {
      setClaiming(false);
    }
  }

  function copyLink() {
    navigator.clipboard?.writeText(refLink);
  }

  if (!status) {
    return <div className="referral-dashboard">Loading referral status…</div>;
  }

  const claimsUsed = status.daily_ref_claims_count ?? 0;
  const canClaim =
    !claiming &&
    secondsLeft === 0 &&
    claimsUsed < DAILY_CAP &&
    (status.pending_referral_balance ?? 0) >= 500;

  return (
    <div className="referral-dashboard">
      <h2>Invite friends, earn points</h2>

      <div className="referral-link-row">
        <input readOnly value={refLink} onFocus={(e) => e.target.select()} />
        <button onClick={copyLink}>Copy</button>
      </div>

      <div className="referral-stats">
        <div>
          <span className="stat-value">{claimsUsed}/{DAILY_CAP}</span>
          <span className="stat-label">claims today</span>
        </div>
        <div>
          <span className="stat-value">{status.pending_referral_balance ?? 0}</span>
          <span className="stat-label">pending points</span>
        </div>
      </div>

      <button className="claim-button" onClick={handleClaim} disabled={!canClaim}>
        {claiming
          ? 'Claiming…'
          : secondsLeft > 0
          ? `Wait ${secondsLeft}s`
          : claimsUsed >= DAILY_CAP
          ? 'Daily limit reached'
          : (status.pending_referral_balance ?? 0) < 500
          ? 'No reward to claim'
          : 'Watch ad & claim 500 pts'}
      </button>

      {error && <p className="referral-error">{error}</p>}
    </div>
  );
}
