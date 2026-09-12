import { useEffect, useState } from 'react';
import { api } from '../api';

/**
 * Hard, non-dismissible gate shown on app open when
 * app_open_require_channel_join is on and the user hasn't joined every
 * channel in official_channels yet — blocks the ENTIRE app (unlike the
 * separate, per-action referral/withdrawal channel gates). See
 * backend/routes/user.js's /user/channel-gate-status.
 *
 * Renders nothing (returns null) once the gate is satisfied, the
 * setting is off, or the check itself is still loading — App.jsx
 * should render this ABOVE everything else and let it decide whether
 * to show its blocking overlay or get out of the way entirely.
 */
export default function ChannelGate({ children }) {
  const [gate, setGate] = useState(null); // null = loading
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState(null);

  async function check() {
    try {
      const { gate: g } = await api.channelGateStatus();
      setGate(g);
    } catch (e) {
      // Same fail-open reasoning as the backend route itself — never
      // let a broken check lock every user out of the app entirely.
      setGate({ required: false, joined: true, channels: [] });
    }
  }

  useEffect(() => {
    check();
  }, []);

  async function handleVerify() {
    setVerifying(true);
    setError(null);
    try {
      await check();
    } catch (e) {
      setError(e.message);
    } finally {
      setVerifying(false);
    }
  }

  function openChannel(url) {
    const tg = window.Telegram?.WebApp;
    if (tg?.openTelegramLink && url) tg.openTelegramLink(url);
    else if (url) window.open(url, '_blank');
  }

  // Still loading, feature off, or already satisfied — get out of the way.
  if (!gate || !gate.required || gate.joined) return children;

  return (
    <div className="channel-gate-overlay">
      <div className="channel-gate-card">
        <div className="channel-gate-emoji">📢</div>
        <h2 className="channel-gate-title">Join Our Official Channels</h2>
        <p className="channel-gate-subtitle">
          Please join all of the channels below to continue using the app.
        </p>
        <div className="channel-gate-list">
          {gate.channels.map((ch) => (
            <div className="channel-gate-item" key={ch.id}>
              <span className="channel-gate-item-name">{ch.id}</span>
              {ch.joined ? (
                <span className="channel-gate-joined-chip">✓ Joined</span>
              ) : ch.join_url ? (
                <button className="channel-gate-join-button" onClick={() => openChannel(ch.join_url)}>
                  Join
                </button>
              ) : (
                <span className="channel-gate-nolink-chip">Contact support</span>
              )}
            </div>
          ))}
        </div>
        {error && <p className="channel-gate-error">{error}</p>}
        <button className="channel-gate-verify-button" onClick={handleVerify} disabled={verifying}>
          {verifying ? 'Checking…' : "I've Joined — Verify"}
        </button>
      </div>
    </div>
  );
}
