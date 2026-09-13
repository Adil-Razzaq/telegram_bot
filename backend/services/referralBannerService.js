const sharp = require('sharp');
const { getSetting } = require('../utils/settings');

const WIDTH = 1200;
const HEIGHT = 630;

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Keeps a very long name (or a pasted-in username with no natural break)
// from overflowing the fixed-width banner. Truncate BEFORE escaping —
// escaping first and truncating after can cut an entity in half (e.g.
// "&am" instead of "&amp;"), which breaks the XML.
function truncateName(name, max = 22) {
  const s = String(name || '').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function buildSvg({ appName, referrerName }) {
  const safeAppName = escapeXml(truncateName(appName, 28).toUpperCase());
  const safeReferrerName = escapeXml(truncateName(referrerName, 22));

  return `<svg width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#1c1e26"/>
        <stop offset="100%" stop-color="#0b0e14"/>
      </linearGradient>
      <radialGradient id="glow" cx="50%" cy="0%" r="75%">
        <stop offset="0%" stop-color="#d69e2e" stop-opacity="0.35"/>
        <stop offset="100%" stop-color="#d69e2e" stop-opacity="0"/>
      </radialGradient>
      <linearGradient id="gold" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stop-color="#ffeaa7"/>
        <stop offset="100%" stop-color="#d69e2e"/>
      </linearGradient>
    </defs>
    <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#bg)"/>
    <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#glow)"/>
    <circle cx="1080" cy="120" r="140" fill="#d69e2e" opacity="0.08"/>
    <circle cx="90" cy="540" r="180" fill="#d69e2e" opacity="0.06"/>
    <text x="80" y="150" font-family="'Segoe UI', Arial, sans-serif" font-size="34" font-weight="700" fill="url(#gold)" letter-spacing="1">${safeAppName}</text>
    <text x="80" y="290" font-family="'Segoe UI', Arial, sans-serif" font-size="60" font-weight="800" fill="#ffffff">${safeReferrerName} invites you!</text>
    <text x="80" y="360" font-family="'Segoe UI', Arial, sans-serif" font-size="32" fill="#c9ccd6">Join now and start earning together</text>
    <rect x="80" y="430" width="340" height="84" rx="18" fill="url(#gold)"/>
    <text x="250" y="483" text-anchor="middle" font-family="'Segoe UI', Arial, sans-serif" font-size="32" font-weight="700" fill="#1a1300">Open App</text>
  </svg>`;
}

/**
 * Renders a branded, personalized referral banner (PNG) server-side —
 * no image asset needed from the admin. Used as the default photo_url
 * for the image-based Telegram share (see preparedShareService.js);
 * invite_share_banner_image_url overrides this with a custom image if
 * the admin sets one.
 *
 * Honest limitation: this renders via a system-installed font on
 * whatever platform the backend runs on. Latin-script names render
 * reliably everywhere; names in scripts your server's OS doesn't have
 * a matching font for (some CJK/Arabic/etc. environments on a minimal
 * container image) may render as empty boxes. If that turns out to be
 * common for your users, switch invite_share_banner_image_url to a
 * custom static image instead.
 */
async function generateBannerPng({ referrerName }) {
  const appName = await getSetting('invite_share_app_name');
  const svg = buildSvg({ appName, referrerName });
  return sharp(Buffer.from(svg)).png().toBuffer();
}

module.exports = { generateBannerPng };
