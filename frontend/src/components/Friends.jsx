import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { withConfirmationRetry } from '../monetag';
import { showActionAd } from '../adNetwork';

const COOLDOWN_SECONDS = 60;

function timeAgo(iso) {
  const seconds = Math.floor((Date.now() - new Date(iso + 'Z').getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export default function Friends({ telegramId, onBalanceChange }) {
  const [status, setStatus] = useState(null);
  const [invited, setInvited] = useState(null);
  const [error, setError] = useState(null);
  const [claiming, setClaiming] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [copied, setCopied] = useState(false);
  // Only needed for showActionAd's network switch (action_ads_network /
  // adsgram_block_id) — nothing else here reads it.
  const [adConfig, setAdConfig] = useState(null);
  const timerRef = useRef(null);

  const botUsername = import.meta.env?.VITE_BOT_USERNAME;
  // startapp= (not start=) — opens the Mini App DIRECTLY, no bot-chat
  // detour, and delivers the referral code via
  // initDataUnsafe.start_param (read in App.jsx). This works reliably
  // regardless of whether the bot's webhook is registered/working —
  // start= alone depends entirely on that webhook, which is the whole
  // reason referrals were silently failing before.
  const refLink =
    telegramId && botUsername ? `https://t.me/${botUsername}?startapp=ref_${telegramId}` : null;

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
    api.referralInvited().then((r) => setInvited(r.invited)).catch(() => setInvited([]));
    api.getConfig().then(setAdConfig).catch(() => {});
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
      await showActionAd(nonce, adConfig);
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
      <h2 className="page-title">Friends</h2>
      <p className="page-subtitle">Invite friends to boost mining speed!</p>

      <div className="glass-card">
        <span className="glass-card-icon round">🔗</span>
        <div className="glass-card-body">
          <p className="glass-card-title">Your Invite Link</p>
          <p className="glass-card-subtitle">
            {refLink || 'Link unavailable — contact support'}
          </p>
        </div>
        <button className="gold-button" onClick={copyLink} disabled={!refLink}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>

      <div className="glass-card">
        <span className="glass-card-icon round" style={{ background: 'rgba(59,130,246,0.12)', color: '#3b82f6' }}>
          👥
        </span>
        <div className="glass-card-body">
          <p className="glass-card-title">Your Referrals</p>
          <p className="glass-card-subtitle">
            {status.successful_referrals ?? 0} successful · {status.total_referrals ?? 0} total
          </p>
        </div>
      </div>

      <div className="glass-card">
        <span className="glass-card-icon round" style={{ background: 'rgba(239,68,68,0.12)', color: '#ef4444' }}>
          🎁
        </span>
        <div className="glass-card-body">
          <p className="glass-card-title">Referral Reward</p>
          <p className="glass-card-subtitle">
            {availableClaims} available · +{status.reward_per_claim ?? 100} ADLX each
          </p>
        </div>
        <button className="gold-button" onClick={handleClaim} disabled={!canClaim}>
          {claiming ? '…' : secondsLeft > 0 ? `${secondsLeft}s` : 'Claim'}
        </button>
      </div>

      {/* Not backed by real data yet — see chat for what a genuine
          multi-level network-earnings mechanic would need. Shown
          disabled rather than with a fabricated number. */}
      <div className="glass-card" style={{ opacity: 0.6 }}>
        <span className="glass-card-icon round" style={{ background: 'rgba(245,158,11,0.12)', color: '#f59e0b' }}>
          💼
        </span>
        <div className="glass-card-body">
          <p className="glass-card-title">Team Wallet</p>
          <p className="glass-card-subtitle">Earnings from your network</p>
        </div>
        <span className="coming-soon-badge">Coming soon</span>
      </div>

      {error && <p className="friends-error">{error}</p>}

      <div className="glass-card friends-invited-card">
        <div className="friends-invited-header">
          <p className="glass-card-title" style={{ margin: 0 }}>Latest invited friends</p>
        </div>
        {invited === null ? (
          <p className="page-subtitle" style={{ margin: '8px 0 0' }}>Loading…</p>
        ) : invited.length === 0 ? (
          <p className="page-subtitle" style={{ margin: '8px 0 0' }}>No invited friends yet.</p>
        ) : (
          <ul className="friends-invited-list">
            {invited.map((u) => (
              <li key={u.telegram_id}>
                <span className="friends-invited-avatar">
                  {(u.username || String(u.telegram_id))[0].toUpperCase()}
                </span>
                <span className="friends-invited-name">{u.username ? `@${u.username}` : `User ${u.telegram_id}`}</span>
                <span className="friends-invited-time">{timeAgo(u.created_at)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
