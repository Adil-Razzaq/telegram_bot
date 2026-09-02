const express = require('express');
const crypto = require('crypto');
const { client } = require('../db/db');
const { grantReferral } = require('../services/referralService');
const { confirmAdEvent } = require('../utils/monetagAds');

const router = express.Router();
const TELEGRAM_API = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;

async function sendWelcomeMessage(chatId) {
  const backendUrl = process.env.BACKEND_PUBLIC_URL;
  const caption = [
    '👋 Welcome to ADLX Miner!',
    '',
    '⛏️ Mine ADLX tokens directly to your Pool Wallet.',
    '⚡ Watch a quick ad to start or restart your mining cycle.',
    '🔗 Connect your TON wallet — right from the Mine tab.',
    '🎡 Spin the wheel, complete tasks, and invite friends for more ADLX.',
    '',
    'Tap below to start.',
  ].join('\n');

  // Row 1: opens the Mini App — same URL/behavior as before, just
  // moved into this richer message. Rows 2+: plain link buttons, each
  // only included if its URL is actually configured — a placeholder
  // link is worse than no button at all.
  const keyboard = [[{ text: '🚀 Start Mining', web_app: { url: process.env.MINI_APP_URL } }]];
  const linkRow = [];
  if (process.env.ADLX_PAY_URL) linkRow.push({ text: 'ADLX PAY', url: process.env.ADLX_PAY_URL });
  if (process.env.ADLX_OFFICIAL_URL) linkRow.push({ text: 'ADLX OFFICIAL', url: process.env.ADLX_OFFICIAL_URL });
  if (process.env.ADLX_SUPPORT_URL) linkRow.push({ text: 'ADLX SUPPORT', url: process.env.ADLX_SUPPORT_URL });
  if (linkRow.length > 0) keyboard.push(linkRow);

  const reply_markup = { inline_keyboard: keyboard };

  // Prefer sendPhoto (matches the reference design) when we have a
  // public URL for the welcome image; fall back to the old plain-text
  // message if BACKEND_PUBLIC_URL isn't set yet, rather than failing
  // silently or crashing the webhook handler.
  if (backendUrl) {
    const res = await fetch(`${TELEGRAM_API}/sendPhoto`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        photo: `${backendUrl}/assets/welcome.png`,
        caption,
        reply_markup,
      }),
    });
    if (res.ok) return;
    console.error('sendPhoto failed, falling back to sendMessage:', await res.text());
  }

  await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: caption, reply_markup }),
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
// this exact URL (with your own secret AND every macro below) as the
// Postback URL in the Monetag dashboard for BNBXpert_bot:
//
//   https://YOUR_DOMAIN/bot/monetag-postback/YOUR_SECRET
//     ?ymid={ymid}
//     &telegram_id={telegram_id}
//     &zone_id={zone_id}
//     &sub_zone_id={sub_zone_id}
//     &event_type={event_type}
//     &reward_event_type={reward_event_type}
//     &estimated_price={estimated_price}
//     &request_var={request_var}
//
// The :secret path segment is what stops someone from hitting this
// directly and faking a reward — see monetagAds.js for why that matters
// (Monetag's postback itself carries no signature).
//
// EVERY postback that lands here — matched or not, paid or not — gets
// logged as a raw row in ad_postback_log first. That's what lets you
// answer "how much did this specific click actually earn" straight from
// the database (see the SELECT example in DEPLOYMENT.md), independent
// of whether it happened to match something this app was waiting on.
router.get('/monetag-postback/:secret', async (req, res) => {
  const expected = process.env.MONETAG_POSTBACK_SECRET || '';
  const provided = req.params.secret || '';
  const same =
    Buffer.byteLength(provided) === Buffer.byteLength(expected) &&
    crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  if (!expected || !same) return res.sendStatus(404);

  const {
    ymid,
    telegram_id: telegramIdMacro,
    zone_id: zoneId,
    sub_zone_id: subZoneId,
    event_type: eventType,
    reward_event_type: rewardEventType,
    estimated_price: estimatedPrice,
    request_var: requestVar,
  } = req.query;

  console.log('Monetag postback received:', req.query);

  // Monetag's dashboard shows this macro as "yes"/"no"; their docs
  // elsewhere say "valued"/"not_valued" — accepting both rather than
  // trusting one source, since we've seen both in the wild.
  const isPaidEvent = rewardEventType === 'yes' || rewardEventType === 'valued';

  let matched = false;
  if (isPaidEvent && ymid) {
    matched = await confirmAdEvent({ nonce: ymid, estimatedPrice });
    console.log('Postback confirmAdEvent result:', matched);
  }

  // Raw audit log — always written, regardless of match/paid status.
  try {
    await client.execute({
      sql: `INSERT INTO ad_postback_log
            (ymid, telegram_id_macro, zone_id, sub_zone_id, event_type, reward_event_type, estimated_price, request_var, matched_pending_event)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        ymid || null,
        telegramIdMacro || null,
        zoneId || null,
        subZoneId || null,
        eventType || null,
        rewardEventType || null,
        Number(estimatedPrice) || 0,
        requestVar || null,
        matched ? 1 : 0,
      ],
    });
  } catch (err) {
    console.error('Failed to write ad_postback_log:', err);
  }

  // Always 200 — a non-paid event (filtered/fraud) or missing nonce isn't
  // an error, just nothing to confirm. Monetag retries on non-200.
  res.sendStatus(200);
});

module.exports = router;
