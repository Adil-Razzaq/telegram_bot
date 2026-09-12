const { getSetting } = require('../utils/settings');

const TELEGRAM_API = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;

/**
 * Image-based invite share: prepares a rich inline message (photo +
 * caption + an "Open App" button) via Telegram's savePreparedInlineMessage
 * Bot API method, which the frontend then hands to
 * Telegram.WebApp.shareMessage() (Bot API client 7.10+) — this opens
 * Telegram's own native chat/contact picker with the ACTUAL banner
 * image attached, unlike the plain t.me/share/url link (which only
 * carries text and whatever preview Telegram generates on its own).
 *
 * Requires invite_share_banner_image_url to be set to a real, publicly
 * reachable HTTPS image URL — returns a clear error otherwise, and the
 * frontend is expected to fall back to the plain-link share in that
 * case (see components/Friends.jsx's shareLink()).
 */
async function preparePhotoShare({ telegramId, refLink }) {
  const bannerUrl = await getSetting('invite_share_banner_image_url');
  if (!bannerUrl) {
    const err = new Error('Image-based share is not configured');
    err.statusCode = 400;
    throw err;
  }
  if (!/^https:\/\/t\.me\//.test(refLink)) {
    const err = new Error('Invalid invite link');
    err.statusCode = 400;
    throw err;
  }

  const result = {
    type: 'photo',
    id: `invite_${telegramId}_${Date.now()}`,
    photo_url: bannerUrl,
    thumbnail_url: bannerUrl,
    caption: 'Join me and start earning — tap the button below!',
    reply_markup: {
      inline_keyboard: [[{ text: 'Open App', url: refLink }]],
    },
  };

  let data;
  try {
    const res = await fetch(`${TELEGRAM_API}/savePreparedInlineMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id: telegramId,
        result,
        allow_user_chats: true,
        allow_bot_chats: false,
        allow_group_chats: true,
        allow_channel_chats: true,
      }),
    });
    data = await res.json();
  } catch (e) {
    console.error('savePreparedInlineMessage request failed:', e.message);
    const err = new Error('Could not prepare share — network error contacting Telegram');
    throw err;
  }

  if (!data.ok) {
    console.error('savePreparedInlineMessage failed:', data.description);
    const err = new Error(data.description || 'Telegram rejected the share request');
    throw err;
  }

  return { id: data.result.id, expiration_date: data.result.expiration_date };
}

module.exports = { preparePhotoShare };
