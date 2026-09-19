const TELEGRAM_API = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;

async function sendTelegramMessage(chatId, text, { parseMode, replyMarkup } = {}) {
  const res = await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: parseMode, reply_markup: replyMarkup }),
  });
  const data = await res.json();
  // Telegram often returns a normal HTTP 200 even on failure (e.g. "bot
  // isn't a member of this chat") — the actual result is in the body, not
  // the status code, so this check is what makes failures visible instead
  // of silent.
  if (!data.ok) {
    throw new Error(data.description || 'Telegram API returned an error');
  }
  return data;
}

// Sends an image Buffer (e.g. a generated contest-results graphic) as
// a photo message, with the same optional caption/keyboard a text
// message can carry. Telegram's sendPhoto needs multipart/form-data
// for a raw file upload — Node 18+'s global FormData/Blob handle that
// without any extra dependency.
async function sendTelegramPhoto(chatId, imageBuffer, { caption, parseMode, replyMarkup, filename = 'image.png' } = {}) {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  if (caption) form.append('caption', caption);
  if (parseMode) form.append('parse_mode', parseMode);
  if (replyMarkup) form.append('reply_markup', JSON.stringify(replyMarkup));
  form.append('photo', new Blob([imageBuffer], { type: 'image/png' }), filename);

  const res = await fetch(`${TELEGRAM_API}/sendPhoto`, { method: 'POST', body: form });
  const data = await res.json();
  if (!data.ok) {
    throw new Error(data.description || 'Telegram API returned an error');
  }
  return data;
}

module.exports = { sendTelegramMessage, sendTelegramPhoto };
