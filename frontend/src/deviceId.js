/**
 * One-device-one-account (best-effort — see backend/db/db.js's comment
 * on users.device_id for the honest limitations: this is a browser-
 * stored ID, not a hardware fingerprint, and is trivially reset by
 * clearing storage or switching browsers/devices). Generated once and
 * persisted in localStorage; sent on every API call via the
 * X-Device-Id header (see api.js).
 */

const STORAGE_KEY = 'deviceId';

export function getDeviceId() {
  try {
    let id = localStorage.getItem(STORAGE_KEY);
    if (!id) {
      id = crypto.randomUUID ? crypto.randomUUID() : `dev_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      localStorage.setItem(STORAGE_KEY, id);
    }
    return id;
  } catch (e) {
    // localStorage unavailable (private browsing, disabled, etc.) —
    // fall back to a per-session-only ID rather than breaking the app.
    return null;
  }
}
