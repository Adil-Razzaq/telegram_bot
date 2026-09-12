import { useEffect, useState } from 'react';
import { api } from '../api';

/**
 * Shown to the REFERRER (not the new user — see WelcomeGiftModal.jsx
 * for that side) the next time they open the app after one or more
 * friends joined via their referral link. Pulls any not-yet-shown
 * joins (see db.js's users.referral_notified) and acknowledges them
 * once dismissed, so this never repeats for the same join.
 *
 * Dismissible — purely a nice-to-know, not a hard gate.
 */
export default function NewReferralPopup() {
  const [data, setData] = useState(null); // null = loading/not-yet-checked
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    api.newReferralJoins().then(setData).catch(() => setData({ joins: [] }));
  }, []);

  function handleDismiss() {
    setDismissed(true);
    api.ackNewReferralJoins().catch(() => {});
  }

  if (!data || data.joins.length === 0 || dismissed) return null;

  const names = data.joins.map((j) => j.name).join(', ');
  const message = (data.message_template || '').replace('{names}', names);

  return (
    <div className="welcome-gift-overlay">
      <div className="welcome-gift-card">
        <button className="welcome-gift-close" onClick={handleDismiss} aria-label="Dismiss">
          ✕
        </button>
        <div className="welcome-gift-emoji">🎉</div>
        <h2 className="welcome-gift-title">{data.title}</h2>
        <p className="welcome-gift-offer">{message}</p>
        <button className="welcome-gift-claim-button" onClick={handleDismiss}>
          Nice!
        </button>
      </div>
    </div>
  );
}
