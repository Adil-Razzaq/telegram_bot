# Spin Wheel + Referral + Withdrawal — Telegram Mini App

## Before you launch: the referral economics don't self-fund

The spin wheel is internally consistent — every point paid out comes from
entry fees other spins paid into `spin_pool`, and the code verifies the
pool can afford a payout before offering it, so it can't go insolvent on
its own.

The referral module is different. A referral grants 500 points
(**$0.05**) the moment a friend joins — before anything monetizable has
happened. The ad watch only unlocks moving that 500 from pending to
spendable; it doesn't fund it. Your own worst-case ad valuation is
$0.0005/ad (2.5 points), so one referral credit is worth **~200 rewarded
ads**, and at the 20-claim/day cap, one active user can pull $1.00/day in
referral payouts alone against $0.01 of the ad revenue your own model says
an ad is worth. Nothing in the spec caps how many people one user can
refer, so this is uncapped per user, funded by nothing.

That's the same shape as the ATF-style pattern you were deliberately
steering away from with the [[miner-coin-app]] and [[referral-bot]]
projects — pay recruiters from new signups rather than from revenue. It
doesn't fail on day one; it fails when withdrawal requests outpace new
signups, which is exactly the moment users are trying to cash out. Two
ways to actually fund it, if you want to keep a referral mechanic:

1. **Tie the reward to the referred user's activity**, not their signup —
   e.g. pay the referrer a small cut (in points) each time the *referred*
   user watches an ad or completes a spin, capped, so the payout is
   always downstream of real ad revenue.
2. **Shrink the flat reward to match real ad economics** — e.g. 25–50
   points per referral instead of 500, and/or require the referred user
   to be active (N spins or ad views) before the referral counts, so it's
   not free money for a raw signup.

Everything below is built to spec as given — the flat 500-point grant is
implemented in `referralService.grantReferral()` — but changing the
reward logic is a one-function edit if you want to fix this before real
money is involved.

## What's here vs. what the spec listed

The 5 endpoints in the spec are all implemented. Two more had to be added
because the spec didn't include a way to actually create the state those
endpoints operate on:
- `POST /api/referral/register` — grants the pending 500 pts to a
  referrer when a new user signs up via their link. Call this from your
  bot's `/start` handler.
- `POST /api/admin/withdrawal/reject` — without this, a withdrawal an
  admin won't approve (bad address, fraud, etc.) has no resolution and
  permanently locks the user's points. Rejecting refunds the points.

Also added: an append-only `ledger` table (every balance change, who,
why) — for a real-money system, you want to be able to reconstruct any
balance from history when a payout is disputed, not just trust the
current row.

## Setup

**Backend**
```
cd backend
cp .env.example .env   # fill in TELEGRAM_BOT_TOKEN, ADMIN_API_KEY, ADSGRAM_VERIFY_SECRET
npm install
npm start                # runs on :4000, SQLite file created at ./data/app.db
```

**Frontend**
```
cd frontend
npm install
npm run dev               # :5173, expects backend at localhost:4000/api (see VITE_API_BASE)
```

## Things confirmed to work (tested in this environment)

- All backend files pass `node --check` (syntax) and boot correctly.
- Ran 5,000 simulated spins against the real transaction logic: pool
  balance never went negative, segment 5/6 unlock thresholds engaged
  correctly, and the observed payout distribution matched the specified
  probabilities once renormalized around eligible segments.
- Telegram `initData` HMAC validation follows Telegram's documented
  algorithm exactly.

## Things you still need to confirm before going live

- **Adsgram's actual server-verification contract.** `utils/adsgram.js`
  implements a generic signed-token scheme as a placeholder — Adsgram's
  real API (webhook shape, SDK return value) wasn't something to assume
  here. Confirm it against their current publisher docs; this is the one
  piece standing between "watched an ad" and "typed a fake token."
- **Gambling / money-service regulation.** A pari-mutuel wheel that pays
  out real USDT is a real-money game of chance in most jurisdictions,
  and manual crypto payouts can trigger money-transmitter or AML
  obligations depending on where your users and you are. Worth a look
  before this handles real withdrawals, not after.
