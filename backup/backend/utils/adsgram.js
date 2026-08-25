const crypto = require('crypto');

/**
 * IMPORTANT: Adsgram's exact server-side reward-verification contract
 * (webhook payload / signature scheme) isn't something to guess at here —
 * confirm it against Adsgram's current publisher docs before going live,
 * since ad-network APIs change and a wrong assumption here is a direct
 * hole in your economic model (anyone could fake ad completions and mint
 * points for free).
 *
 * This module gives you one place to plug that in. Two strategies are
 * supported out of the box; pick whichever matches what Adsgram gives you:
 *
 * 1. SERVER-TO-SERVER CALLBACK (recommended): Adsgram calls YOUR backend
 *    directly when a user finishes a rewarded ad, signed with a shared
 *    secret. You'd store a short-lived "reward ticket" in a table/cache
 *    keyed by (telegram_id, purpose) when that callback arrives, and
 *    verifyAdCompletion() below just checks the ticket exists and hasn't
 *    been consumed yet.
 *
 * 2. CLIENT-SUBMITTED TOKEN + SIGNATURE: the frontend gets a signed token
 *    back from the Adsgram SDK after ad completion and sends it to your
 *    API. verifyAdCompletion() checks the signature against
 *    ADSGRAM_VERIFY_SECRET. This is weaker (a compromised client secret
 *    or replay of a captured token is a risk) — prefer strategy 1 if
 *    Adsgram supports it.
 *
 * The stub below implements strategy 2 defensively (signature + one-time
 * use via the `usedAdTokens` in-memory set) so the rest of the app has a
 * concrete contract to call. Swap the body out once you've confirmed
 * Adsgram's real payload shape.
 */

const usedAdTokens = new Set(); // swap for a DB/Redis table in production (multi-process safe)

function verifyAdCompletion({ telegramId, adToken, purpose }) {
  if (!adToken || typeof adToken !== 'string') {
    return { ok: false, reason: 'missing_token' };
  }
  if (usedAdTokens.has(adToken)) {
    return { ok: false, reason: 'token_already_used' };
  }

  const secret = process.env.ADSGRAM_VERIFY_SECRET;
  if (!secret) {
    return { ok: false, reason: 'server_misconfigured' };
  }

  // Expected token shape: base64(payload).hex(hmac)
  const [payloadB64, sig] = adToken.split('.');
  if (!payloadB64 || !sig) {
    return { ok: false, reason: 'malformed_token' };
  }

  const expectedSig = crypto.createHmac('sha256', secret).update(payloadB64).digest('hex');
  const sigBuf = Buffer.from(sig, 'hex');
  const expectedBuf = Buffer.from(expectedSig, 'hex');
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return { ok: false, reason: 'bad_signature' };
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64').toString('utf8'));
  } catch (e) {
    return { ok: false, reason: 'bad_payload' };
  }

  if (String(payload.telegramId) !== String(telegramId)) {
    return { ok: false, reason: 'user_mismatch' };
  }
  if (purpose && payload.purpose !== purpose) {
    return { ok: false, reason: 'purpose_mismatch' };
  }
  if (!payload.ts || Date.now() / 1000 - payload.ts > 300) {
    return { ok: false, reason: 'token_expired' };
  }

  usedAdTokens.add(adToken);
  return { ok: true };
}

module.exports = { verifyAdCompletion };
