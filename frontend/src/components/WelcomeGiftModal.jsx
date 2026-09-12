import { useEffect, useState } from 'react';
import { api } from '../api';
import { withConfirmationRetry } from '../monetag';
import { showAdsgramRewardedAd } from '../adsgram';

/**
 * Full-screen popup shown on app open to a NEW user who arrived via
 * someone's referral link and hasn't claimed their one-time welcome
 * gift yet (see backend/services/inviteGiftService.js). Personalized
 * with the user's own Telegram name/ID (straight from
 * Telegram.WebApp.initDataUnsafe.user — no extra request needed for
 * that part) and, when available, who referred them.
 *
 * Dismissible — this is an incentive, not a hard gate (compare the
 * official-channels gate, which IS a hard gate — see ChannelGate.jsx).
 */
export default function WelcomeGiftModal({ onBalanceChange }) {
  const [status, setStatus] = useState(null); // null = loading/not-yet-checked
  const [dismissed, setDismissed] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const [error, setError] = useState(null);

  const tg = typeof window !== 'undefined' ? window.Telegram?.WebApp : null;
  const me = tg?.initDataUnsafe?.user;
  const myName = me ? [me.first_name, me.last_name].filter(Boolean).join(' ') || me.username : null;

  useEffect(() => {
    api.inviteGiftStatus().then((r) => setStatus(r.status)).catch(() => setStatus({ eligible: false }));
  }, []);

  async function handleClaim() {
    setError(null);
    setClaiming(true);
    try {
      const { nonce } = await api.prepareInviteGift();
      await showAdsgramRewardedAd(status.block_id);
      const result = await withConfirmationRetry(() => api.claimInviteGift(nonce));
      onBalanceChange(result.main_balance);
      setStatus((prev) => ({ ...prev, eligible: false }));
    } catch (e) {
      setError(e.message);
    } finally {
      setClaiming(false);
    }
  }

  if (!status?.eligible || dismissed) return null;

  return (
    <div className="welcome-gift-overlay">
      <div className="welcome-gift-card">
        <button className="welcome-gift-close" onClick={() => setDismissed(true)} aria-label="Dismiss">
          ✕
        </button>
        <div className="welcome-gift-emoji">🎉</div>
        <h2 className="welcome-gift-title">
          {myName ? `Welcome, ${myName}!` : 'Welcome!'}
        </h2>
        {me?.id && <p className="welcome-gift-id">Telegram ID: {me.id}</p>}
        {status.referrer_username ? (
          <p className="welcome-gift-subtitle">
            You were invited by <strong>@{status.referrer_username}</strong>
          </p>
        ) : status.referrer_telegram_id ? (
          <p className="welcome-gift-subtitle">
            You were invited by user <strong>{status.referrer_telegram_id}</strong>
          </p>
        ) : null}
        <p className="welcome-gift-offer">
          Watch one quick ad to claim <strong>+{status.new_user_points} ADLX</strong> — your friend
          gets <strong>+{status.referrer_points} ADLX</strong> too!
        </p>
        {error && <p className="welcome-gift-error">{error}</p>}
        <button className="welcome-gift-claim-button" onClick={handleClaim} disabled={claiming}>
          {claiming ? 'Loading…' : 'Watch Ad & Claim'}
        </button>
        <button className="welcome-gift-later-button" onClick={() => setDismissed(true)}>
          Maybe later
        </button>
      </div>
    </div>
  );
}
