const TELEGRAM_API = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;

async function sendTelegramMessage(chatId, text, { parseMode } = {}) {
  const res = await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: parseMode }),
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

module.exports = { sendTelegramMessage };
