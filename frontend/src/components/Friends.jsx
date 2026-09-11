import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { withConfirmationRetry } from '../monetag';
import { showActionAd } from '../adNetwork';
import { showAdsgramRewardedAd } from '../adsgram';

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
  // adsgram_block_id) — nothing else here reads it, EXCEPT the cooldown
  // ref below, which pulls referral_claim_cooldown_seconds off this
  // same config object once it loads.
  const [adConfig, setAdConfig] = useState(null);
  const timerRef = useRef(null);
  // Admin-editable (default 60) — was a hardcoded constant. A ref (not
  // state) so refreshStatus/handleClaim always read the latest value
  // without needing to be redeclared as a dependency of either.
  const cooldownSecondsRef = useRef(60);
  // Invite Gift — one-time, ad-funded welcome bonus for a NEW user who
  // opened via a referral link (see services/inviteGiftService.js).
  // null while loading, then either { eligible: false } or the full
  // status object once fetched.
  const [inviteGift, setInviteGift] = useState(null);
  const [claimingGift, setClaimingGift] = useState(false);
  const [shared, setShared] = useState(false);

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
        setSecondsLeft(Math.max(0, Math.ceil(cooldownSecondsRef.current - elapsed)));
      }
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    refreshStatus();
    api.referralInvited().then((r) => setInvited(r.invited)).catch(() => setInvited([]));
    api.getConfig()
      .then((cfg) => {
        setAdConfig(cfg);
        if (cfg?.referral_claim_cooldown_seconds != null) {
          cooldownSecondsRef.current = cfg.referral_claim_cooldown_seconds;
        }
      })
      .catch(() => {});
    api.inviteGiftStatus().then((r) => setInviteGift(r.status)).catch(() => setInviteGift({ eligible: false }));
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
      setSecondsLeft(cooldownSecondsRef.current);
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

  // Opens Telegram's own native share/forward picker (choose a contact
  // or group to send the invite to) instead of relying on the user to
  // paste a copied link somewhere themselves — meaningfully lower
  // friction, so meaningfully more actual invites sent per user who
  // taps this.
  function shareLink() {
    if (!refLink) return;
    const text = 'Join me and start earning — tap to open!';
    const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(refLink)}&text=${encodeURIComponent(text)}`;
    const tg = window.Telegram?.WebApp;
    if (tg?.openTelegramLink) {
      tg.openTelegramLink(shareUrl);
    } else {
      window.open(shareUrl, '_blank');
    }
    setShared(true);
    setTimeout(() => setShared(false), 2000);
  }

  async function handleClaimGift() {
    setError(null);
    setClaimingGift(true);
    try {
      const { nonce } = await api.prepareInviteGift();
      await showAdsgramRewardedAd(inviteGift.block_id);
      const result = await withConfirmationRetry(() => api.claimInviteGift(nonce));
      onBalanceChange(result.main_balance);
      setInviteGift({ eligible: false });
    } catch (e) {
      setError(e.message);
    } finally {
      setClaimingGift(false);
    }
  }

  if (!status) {
    return <div className="friends-container">Loading…</div>;
  }

  const availableClaims = status.available_claims ?? 0;
  const canClaim = !claiming && secondsLeft === 0 && availableClaims > 0;
  const pendingQualificationCount = status.pending_qualification_count ?? 0;
  const lockedBonusEstimate = status.locked_referral_bonus_estimate ?? 0;
  const requiredCycles = status.referral_qualify_miner_cycles ?? 0;

  return (
    <div className="friends-container">
      <h2 className="page-title">Friends</h2>
      <p className="page-subtitle">Invite friends to boost mining speed!</p>

      {/* Shown ONLY to a NEW user who opened via someone's referral
          link and hasn't claimed this yet — see
          services/inviteGiftService.js. Separate from and in addition
          to the Referral Reward card below (that one pays the
          REFERRER once cycles are done; this one pays BOTH sides
          instantly, funded by a single ad view). */}
      {inviteGift?.eligible && (
        <div className="glass-card" style={{ background: 'rgba(250,204,21,0.12)', borderColor: 'rgba(250,204,21,0.3)' }}>
          <span className="glass-card-icon round" style={{ background: 'rgba(250,204,21,0.18)', color: '#facc15' }}>
            🎉
          </span>
          <div className="glass-card-body">
            <p className="glass-card-title">Welcome Gift</p>
            <p className="glass-card-subtitle">
              Watch one ad to claim +{inviteGift.new_user_points} ADLX — your friend gets +{inviteGift.referrer_points} too!
            </p>
          </div>
          <button className="gold-button" onClick={handleClaimGift} disabled={claimingGift}>
            {claimingGift ? '…' : 'Claim'}
          </button>
        </div>
      )}

      <div className="glass-card">
        <span className="glass-card-icon round">🔗</span>
        <div className="glass-card-body">
          <p className="glass-card-title">Your Invite Link</p>
          <p className="glass-card-subtitle">
            {refLink || 'Link unavailable — contact support'}
          </p>
        </div>
        <button className="gold-button" onClick={shareLink} disabled={!refLink} style={{ marginRight: 6 }}>
          {shared ? 'Shared' : 'Share'}
        </button>
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

      {/* ADDED: only shown when admin has referral_qualify_miner_cycles > 0
          (gating is actually on) and at least one referral is still
          waiting on it — otherwise this card would just be permanent
          clutter for every referrer whose invites are all instantly
          credited, which is still the default. Same icon-chip + title +
          subtitle + trailing-value layout as the Referral Reward card
          above, so it reads as part of the same set instead of a
          different kind of thing — the purple trailing chip (vs. the
          gold Claim button) is what signals "not claimable yet". This
          is an estimate of what moves into that gold card once each
          pending friend finishes enough mining cycles — never a real,
          spendable balance on its own. */}
      {requiredCycles > 0 && pendingQualificationCount > 0 && (
        <div className="glass-card">
          <span
            className="glass-card-icon round"
            style={{ background: 'rgba(168,85,247,0.12)', color: '#c084fc' }}
          >
            🔒
          </span>
          <div className="glass-card-body">
            <p className="glass-card-title">Locked Referral Bonus</p>
            <p className="glass-card-subtitle">
              {pendingQualificationCount} friend{pendingQualificationCount === 1 ? '' : 's'} not
              active yet · unlocks after {requiredCycles} cycle{requiredCycles === 1 ? '' : 's'}
            </p>
          </div>
          <span className="locked-chip">+{lockedBonusEstimate}</span>
        </div>
      )}

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
            {invited.map((u) => {
              // ADDED: qualification badge. When gating is off
              // (requiredCycles === 0, the existing default) every
              // referred user was credited instantly as before, so
              // referral_qualified is always 1 and this renders exactly
              // like the old "just the timestamp" row.
              const isQualified = !!u.referral_qualified;
              const cyclesDone = u.total_miner_cycles_completed || 0;
              return (
                <li key={u.telegram_id}>
                  <span className="friends-invited-avatar">
                    {(u.username || String(u.telegram_id))[0].toUpperCase()}
                  </span>
                  <span className="friends-invited-name">
                    {u.username ? `@${u.username}` : `User ${u.telegram_id}`}
                  </span>
                  {isQualified ? (
                    requiredCycles > 0 ? (
                      // Gating is on: make "already earned" an explicit,
                      // permanent state — not just a plain timestamp
                      // that looks identical to how every referral
                      // looked before this feature existed.
                      <span className="active-badge" title={timeAgo(u.created_at)}>
                        Active
                      </span>
                    ) : (
                      <span className="friends-invited-time">{timeAgo(u.created_at)}</span>
                    )
                  ) : (
                    <span
                      className="pending-badge"
                      title="Commission unlocks once this friend finishes enough mining cycles"
                    >
                      Pending{requiredCycles > 0 ? ` · ${cyclesDone}/${requiredCycles}` : ''}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
