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
 * The banner is auto-generated (see routes/referral.js's
 * /banner/:telegramId.png and services/referralBannerService.js) unless
 * invite_share_banner_image_url is set to a custom image — no admin
 * setup required either way.
 *
 * `baseUrl` is this server's own public origin (e.g.
 * "https://your-app.onrender.com"), needed to build an absolute URL for
 * the auto-generated banner — pass req.protocol + '://' + req.get('host')
 * from the route handler; Telegram's servers need a real HTTPS URL to
 * fetch, a relative path won't work.
 */
async function preparePhotoShare({ telegramId, refLink, baseUrl }) {
  const customBannerUrl = await getSetting('invite_share_banner_image_url');
  const bannerUrl = customBannerUrl || `${baseUrl}/api/referral/banner/${telegramId}.png`;

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
