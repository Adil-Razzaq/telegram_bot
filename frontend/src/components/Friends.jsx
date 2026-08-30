import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { showRewardedAd, withConfirmationRetry } from '../monetag';

const COOLDOWN_SECONDS = 60;

export default function Friends({ telegramId, onBalanceChange }) {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [claiming, setClaiming] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [copied, setCopied] = useState(false);
  const timerRef = useRef(null);

  const botUsername = import.meta.env?.VITE_BOT_USERNAME;
  const refLink =
    telegramId && botUsername ? `https://t.me/${botUsername}?start=ref_${telegramId}` : null;

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
      const { nonce } = await api.prepareClaim();
      await showRewardedAd(nonce);
      const claimResult = await withConfirmationRetry(() => api.claimReferral(nonce));
      setStatus((prev) => ({ ...prev, ...claimResult }));
      onBalanceChange(claimResult.main_balance);
      setSecondsLeft(COOLDOWN_SECONDS);
      await refreshStatus();
    } catch (e) {
      setError(e.message);
    } finally {
      setClaiming(false);
    }
  }

  function copyLink() {
    if (!refLink) return;
    navigator.clipboard?.writeText(refLink);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  if (!status) {
    return <div className="friends-container">Loading…</div>;
  }

  const availableClaims = status.available_claims ?? 0;
  const canClaim = !claiming && secondsLeft === 0 && availableClaims > 0;

  return (
    <div className="friends-container">
      <h2>Friends</h2>
      <p className="friends-subtitle">Invite friends to boost mining speed!</p>

      <div className="friends-card">
        <span className="friends-card-icon">🔗</span>
        <div className="friends-card-info">
          <span className="friends-card-label">Your Invite Link</span>
          <span className="friends-card-value friends-link-text">{refLink || 'Set VITE_BOT_USERNAME to generate your link'}</span>
        </div>
        <button className="friends-action-button" onClick={copyLink} disabled={!refLink}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>

      <div className="friends-card">
        <span className="friends-card-icon">👥</span>
        <div className="friends-card-info">
          <span className="friends-card-label">Your Referrals</span>
          <span className="friends-card-value">
            {status.successful_referrals ?? 0} successful · {status.total_referrals ?? 0} total
          </span>
        </div>
      </div>

      <div className="friends-card">
        <span className="friends-card-icon">🎁</span>
        <div className="friends-card-info">
          <span className="friends-card-label">Referral Reward</span>
          <span className="friends-card-value">
            {availableClaims} available · +{status.reward_per_claim ?? 120} pts each
          </span>
        </div>
        <button className="friends-action-button" onClick={handleClaim} disabled={!canClaim}>
          {claiming ? '…' : secondsLeft > 0 ? `${secondsLeft}s` : 'Claim'}
        </button>
      </div>

      {error && <p className="friends-error">{error}</p>}
    </div>
  );
}
