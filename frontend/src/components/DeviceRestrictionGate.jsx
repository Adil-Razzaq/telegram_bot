import { useEffect, useState } from 'react';
import { api } from '../api';

/**
 * Hard, non-dismissible block shown when this account's device_id was
 * already associated with a DIFFERENT Telegram account at signup time
 * (see db.js's users.multi_account_flagged and middleware/
 * telegramAuth.js). Title/message are admin-editable — see settings.js's
 * device_restriction_title/device_restriction_message.
 *
 * Unlike ChannelGate, there's nothing actionable for the user to do
 * here (no "verify" button) — this is a dead end for this account/
 * device pairing, by design.
 *
 * Same fail-open principle as ChannelGate: any error checking this
 * NEVER blocks the app — only a confirmed flag does.
 */
export default function DeviceRestrictionGate({ children }) {
  const [status, setStatus] = useState(null); // null = loading

  useEffect(() => {
    api
      .deviceRestrictionStatus()
      .then((r) => setStatus(r))
      .catch(() => setStatus({ restricted: false }));
  }, []);

  if (!status || !status.restricted) return children;

  return (
    <div className="channel-gate-overlay">
      <div className="channel-gate-card">
        <div className="channel-gate-emoji">🚫</div>
        <h2 className="channel-gate-title">{status.title}</h2>
        <p className="channel-gate-subtitle">{status.message}</p>
      </div>
    </div>
  );
}
