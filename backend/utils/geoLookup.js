/**
 * Best-effort IP -> country lookup for the admin Analytics page's
 * country breakdown. Telegram's initData carries no country field, so
 * this is the only source available short of asking the user directly.
 *
 * Uses ip-api.com's free endpoint (no API key, no signup) — fine at
 * this app's scale since it's only ever called ONCE per user (see
 * telegramAuth.js: only when users.country IS NULL), not per request.
 * Free tier is rate-limited (45 req/min) and HTTP-only (no HTTPS on
 * the free plan) — acceptable here since no sensitive data is sent,
 * just an IP address, and failures are silently swallowed either way.
 *
 * If this ever needs to scale past that limit, swap the URL below for
 * a paid geo-IP provider — every caller already treats a null/failed
 * lookup as "Unknown" and moves on.
 */

const LOOKUP_TIMEOUT_MS = 3000;

/**
 * @param {string} ip
 * @returns {Promise<string|null>} ISO country name (e.g. "Pakistan"), or null if unknown/unresolvable.
 */
async function lookupCountry(ip) {
  if (!ip) return null;
  // Loopback/private addresses (local dev, or a misconfigured proxy
  // chain) will never resolve to a real country — skip the call.
  if (
    ip === '127.0.0.1' ||
    ip === '::1' ||
    ip.startsWith('10.') ||
    ip.startsWith('192.168.') ||
    ip.startsWith('::ffff:127.')
  ) {
    return null;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);
    const res = await fetch(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,country`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const data = await res.json();
    if (data.status !== 'success' || !data.country) return null;
    return data.country;
  } catch (err) {
    // Network hiccup, timeout, rate-limit — never let this block or
    // fail the request it was triggered from.
    return null;
  }
}

module.exports = { lookupCountry };
