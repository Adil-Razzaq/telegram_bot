const express = require('express');
const crypto = require('crypto');
const { client } = require('../db/db');
const { grantReferral } = require('../services/referralService');
const { confirmAdEvent } = require('../utils/monetagAds');

const router = express.Router();
const TELEGRAM_API = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;

async function sendWelcomeMessage(chatId) {
  await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: 'Welcome! Tap below to open the app.',
      reply_markup: {
        inline_keyboard: [[{ text: 'Play', web_app: { url: process.env.MINI_APP_URL } }]],
      },
    }),
  });
}

// Telegram calls this. The :secret segment stops randos from POSTing fake
// updates — set BOT_WEBHOOK_SECRET and register the webhook with that
// exact URL (see DEPLOYMENT.md).
router.post('/webhook/:secret', async (req, res) => {
  const expected = process.env.BOT_WEBHOOK_SECRET || '';
  const provided = req.params.secret || '';
  const same =
    Buffer.byteLength(provided) === Buffer.byteLength(expected) &&
    crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  if (!expected || !same) return res.sendStatus(404);

  res.sendStatus(200); // ack immediately, Telegram doesn't wait for the rest

  try {
    const msg = req.body?.message;
    if (!msg?.text?.startsWith('/start')) return;

    const from = msg.from;
    await client.execute({
      sql: 'INSERT INTO users (telegram_id, username) VALUES (?, ?) ON CONFLICT(telegram_id) DO UPDATE SET username = excluded.username',
      args: [from.id, from.username || null],
    });

    const payload = msg.text.split(' ')[1]; // "/start ref_123456"
    const match = payload && payload.match(/^ref_(\d+)$/);
    if (match) {
      const referrerId = Number(match[1]);
      try {
        await grantReferral({ referrerId, referredTelegramId: from.id });
      } catch (e) {
        console.log('Referral not credited:', e.message);
      }
    }

    await sendWelcomeMessage(msg.chat.id);
  } catch (err) {
    console.error('Webhook handling error:', err);
  }
});

// Monetag calls this after independently confirming an ad event — set
// this exact URL (with your own secret) as the Postback URL for each ad
// zone in the Monetag dashboard: one URL per format is fine, they all
// hit the same handler. The :secret segment is what stops someone from
// hitting this endpoint directly and faking a reward — see monetagAds.js
// for why that matters (Monetag's postback itself carries no signature).
router.get('/monetag-postback/:secret', async (req, res) => {
  const expected = process.env.MONETAG_POSTBACK_SECRET || '';
  const provided = req.params.secret || '';
  const same =
    Buffer.byteLength(provided) === Buffer.byteLength(expected) &&
    crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  if (!expected || !same) return res.sendStatus(404);

  const { ymid, reward_event_type } = req.query;
  console.log('Monetag postback received:', { ymid, reward_event_type, fullQuery: req.query });
  if (reward_event_type === 'valued' && ymid) {
    const confirmed = await confirmAdEvent({ nonce: ymid });
    console.log('Postback confirmAdEvent result:', confirmed);
  }
  // Always 200 — a non-paid event (filtered/fraud) or missing nonce isn't
  // an error, just nothing to confirm. Monetag retries on non-200.
  res.sendStatus(200);
});

module.exports = router;
