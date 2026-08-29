const crypto = require('crypto');
const { client } = require('../db/db');

/**
 * Validates Telegram WebApp `initData` per Telegram's documented algorithm:
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 *
 * Expects the raw initData string in the `X-Telegram-Init-Data` header.
 * On success, attaches req.telegramUser = { id, first_name, ... } and
 * ensures a row exists for that user in `users`.
 */
async function telegramAuth(req, res, next) {
  try {
    const initData = req.header('X-Telegram-Init-Data');
    if (!initData) {
      return res.status(401).json({ error: 'Missing X-Telegram-Init-Data header' });
    }

    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken) {
      // Fail closed: never accept unverified users in a real-money system.
      return res.status(500).json({ error: 'Server misconfigured: TELEGRAM_BOT_TOKEN not set' });
    }

    let parsed;
    try {
      parsed = new URLSearchParams(initData);
    } catch (e) {
      return res.status(401).json({ error: 'Malformed initData' });
    }

    const receivedHash = parsed.get('hash');
    if (!receivedHash) {
      return res.status(401).json({ error: 'initData missing hash' });
    }

    // auth_date freshness check — reject stale/replayed initData older than 24h
    const authDate = Number(parsed.get('auth_date'));
    if (!authDate || Date.now() / 1000 - authDate > 60 * 60 * 24) {
      return res.status(401).json({ error: 'initData expired' });
    }

    const dataCheckEntries = [];
    for (const [key, value] of parsed.entries()) {
      if (key === 'hash') continue;
      dataCheckEntries.push(`${key}=${value}`);
    }
    dataCheckEntries.sort();
    const dataCheckString = dataCheckEntries.join('\n');

    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

    const receivedBuf = Buffer.from(receivedHash, 'hex');
    const computedBuf = Buffer.from(computedHash, 'hex');
    if (receivedBuf.length !== computedBuf.length || !crypto.timingSafeEqual(receivedBuf, computedBuf)) {
      return res.status(401).json({ error: 'Invalid initData signature' });
    }

    let userObj;
    try {
      userObj = JSON.parse(parsed.get('user'));
    } catch (e) {
      return res.status(401).json({ error: 'initData missing/invalid user field' });
    }
    if (!userObj || !userObj.id) {
      return res.status(401).json({ error: 'initData missing user id' });
    }

    req.telegramUser = userObj;

    // Create the user row if this is their first-ever request, and keep
    // username in sync on every request after that too — Telegram sends
    // it fresh in initData every time. The previous version only ever
    // did INSERT OR IGNORE, which never touches username at all, so
    // anyone who opened the Mini App without ever sending /start to the
    // bot (very common — most people use the menu button directly) had
    // a permanently NULL username in the database.
    await client.execute({
      sql: `INSERT INTO users (telegram_id, username) VALUES (?, ?)
            ON CONFLICT(telegram_id) DO UPDATE SET username = excluded.username`,
      args: [userObj.id, userObj.username || null],
    });

    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { telegramAuth };
