# Deploying this without writing code

Everything below uses free tiers that don't ask for a credit card. You'll
create four accounts (GitHub, Turso, Render, Vercel) and click through
their dashboards — no terminal required except one optional step.

## 1. Get your code onto GitHub

GitHub is where Render and Vercel will pull your code from.

1. Create a free account at github.com (email + password only).
2. Download **GitHub Desktop** (desktop.github.com) — a point-and-click
   app, no command line.
3. Unzip the project folder you downloaded from this chat somewhere on
   your computer.
4. In GitHub Desktop: **File → Add Local Repository** → pick the unzipped
   `telegram-spin-app` folder → it'll offer to initialize it as a repo →
   accept.
5. Click **Publish repository** (top bar). Untick "Keep this code
   private" only if you're fine with it being public — private is fine
   too, both are free.

You now have the code on GitHub. Any time I (or you) change a file,
GitHub Desktop will show the change — you click **Commit** then **Push**,
and Render/Vercel redeploy automatically.

## 2. Create your Telegram bot

1. Open Telegram, message **@BotFather**.
2. Send `/newbot`, give it a name and a username (must end in `bot`).
3. BotFather replies with a **token** like `123456:ABC-DEF...` — save it,
   you'll need it in step 4.
4. Send `/mybots` → pick your bot → **Bot Settings → Menu Button → Configure
   menu button**. You'll set the URL here once you have it from step 6 —
   skip for now, come back after step 6.

## 3. Create your database (Turso)

1. Go to turso.tech → sign up (no card).
2. In the dashboard, click **Create Database**. Name it anything, e.g.
   `spin-app`. Pick the region closest to your users.
3. Once created, open it and find:
   - The **Database URL** (starts with `libsql://...`)
   - Click **Create Token** → copy the token it gives you
4. Save both — you'll paste them into Render in the next step.

## 4. Deploy the backend (Render)

1. Go to render.com → sign up with your GitHub account (no card).
2. **New → Web Service** → pick your `telegram-spin-app` repo.
3. Set:
   - **Root Directory:** `backend`
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free
4. Under **Environment Variables**, add:
   - `TELEGRAM_BOT_TOKEN` = the token from step 2
   - `ADMIN_API_KEY` = make up a long random password (this protects your
     admin endpoints — treat it like a password)
   - `TURSO_DATABASE_URL` = from step 3
   - `TURSO_AUTH_TOKEN` = from step 3
   - `ADSGRAM_VERIFY_SECRET` = leave a placeholder for now; you'll get the
     real value from Adsgram when you set up ad verification (see the
     note in `backend/utils/adsgram.js` — this is the one piece you'll
     need Adsgram's docs for)
5. Click **Create Web Service**. Render builds and deploys it — takes a
   few minutes. You'll get a URL like `https://your-app.onrender.com`.
6. Visit `https://your-app.onrender.com/health` in a browser — you should
   see `{"ok":true}`. That confirms the backend and database are both
   working.

Free-tier note: this service sleeps after 15 minutes with no traffic and
takes ~30-50 seconds to wake up on the next request. Fine for testing;
if that cold-start delay bothers real users later, that's the point to
move to Render's paid tier or another always-on host.

## 5. Deploy the frontend (Vercel)

1. Go to vercel.com → sign up with GitHub (no card).
2. **Add New → Project** → pick the same repo.
3. Set:
   - **Root Directory:** `frontend`
   - **Framework Preset:** Vite (Vercel usually detects this automatically)
4. Under **Environment Variables**, add:
   - `VITE_API_BASE` = `https://your-app.onrender.com/api` (your Render
     URL from step 4, with `/api` on the end)
   - `VITE_ADSGRAM_BLOCK_ID` = your Adsgram block ID once you have one
5. Click **Deploy**. You'll get a URL like `https://your-app.vercel.app`.

## 6. Point the bot at your frontend

Back in BotFather (step 2.4): **Configure menu button** → paste your
Vercel URL (`https://your-app.vercel.app`) → give the button a label like
"Play". Also set this same URL wherever BotFather asks for your Mini
App's URL if you set one up via `/newapp`.

## 7. Set up Monetag ads

1. Sign up at monetag.com, go to the **Telegram Mini Apps** tab, and add
   your app (they'll ask for its name and your Mini App's URL — your
   Vercel URL).
2. Create an ad zone for **Rewarded Popup** — every ad placement in this
   app (spin, referral claim, miner start, watch_ad tasks) uses this
   format, not Rewarded Interstitial, since Popup's click-through model
   commands a meaningfully higher CPM. Monetag's dashboard gives you an
   exact script tag like:
   ```html
   <script src="https://something.example/sdk.js" data-zone="123456" data-sdk="show_123456"></script>
   ```
   Copy that whole tag and paste it into `frontend/index.html`, replacing
   the placeholder tag that's there now.
3. In Vercel's environment variables, add `VITE_MONETAG_ZONE_ID` set to
   just the number from `data-zone` above (e.g. `123456`) — this is how
   `frontend/src/monetag.js` finds the right `show_...` function.
4. Still in the Monetag dashboard, find **Postback URL** for that zone
   and set it to (all on one line, with every macro — the app logs the
   full raw postback to `ad_postback_log` for real per-click revenue
   auditing, not just the ones it happens to gate a reward on):
   ```
   https://your-backend-url/bot/monetag-postback/YOUR_MONETAG_POSTBACK_SECRET?ymid={ymid}&telegram_id={telegram_id}&zone_id={zone_id}&sub_zone_id={sub_zone_id}&event_type={event_type}&reward_event_type={reward_event_type}&estimated_price={estimated_price}&request_var={request_var}
   ```
   using your actual backend URL and the `MONETAG_POSTBACK_SECRET` value
   from your `.env` (same one you invented for `BOT_WEBHOOK_SECRET` — make
   up a different random string for this one, don't reuse it).
5. Redeploy the frontend (Vercel) after adding the env var, and restart
   the backend (`pm2 restart ... --update-env` if using pm2) so it picks
   up `MONETAG_POSTBACK_SECRET`.
6. Test: tap any ad-gated button (e.g. the miner's Start button), watch
   the ad through, and the action should resolve within a few seconds —
   that delay is the app waiting for Monetag's postback to confirm the
   ad before it'll let you spend it. To check what a specific click
   actually earned, query `ad_postback_log` directly (see "Checking real
   ad earnings" below), or use the Ad Revenue panel in `/admin`.

### Checking real ad earnings per click

Every postback Monetag sends — matched to a reward or not, paid or not —
is logged raw in `ad_postback_log`. From the VM:
```
node -e "
require('dotenv').config();
const { client } = require('./db/db');
client.execute('SELECT * FROM ad_postback_log ORDER BY received_at DESC LIMIT 10')
  .then(r => console.log(JSON.stringify(r.rows, null, 2)));
"
```
Or for an average CPM across everything logged so far:
```sql
SELECT AVG(estimated_price) * 1000 AS effective_cpm FROM ad_postback_log WHERE estimated_price > 0;
```
The admin panel's **Ad Revenue** section shows this same summary without
needing to SSH in.

Monetag's docs list only three formats for Mini Apps: **Rewarded
Interstitial**, **Rewarded Popup** (what's wired up here), and **In-App
Interstitial** (a passive, non-rewarded ad that appears automatically —
no user action needed, and it isn't part of the verified-reward flow
above since Monetag doesn't send postbacks for that format). There's no
separate "native ads" format for Mini Apps in their current lineup.

## 8. Set up TON Connect (Tonkeeper wallet)

Withdrawals pay out in TON, connected via Tonkeeper (or any TON Connect
wallet) instead of a manually-typed address only:

1. `frontend/public/tonconnect-manifest.json` needs to be reachable at
   `https://your-frontend-url/tonconnect-manifest.json` in production —
   Vercel serves everything in `public/` at the root automatically, so
   this works with no extra config, but **edit the file first**: set
   `url` to your actual Vercel URL, and `iconUrl` to
   `https://your-frontend-url/coin.png` (the coin image already lives in
   `public/coin.png`).
2. That's it — no API key or account needed for TON Connect itself, it's
   an open protocol. `frontend/src/tonConnect.js` handles the rest:
   auto-reconnecting a returning user's Tonkeeper on load, and prompting
   a fresh connection otherwise.
3. One account can only ever have one TON wallet linked (enforced by a
   unique index in the database, see `walletService.js`) — this is what
   makes "the same Tonkeeper always resolves to the same account" work,
   and what stops one wallet being used to farm multiple accounts.

## 9. Test the whole thing

Open your bot in Telegram, tap the menu button. The app should load
inside Telegram, and API calls should reach your backend. Spinning,
claiming a referral, or starting the miner now genuinely requires
watching a real Monetag ad — if you skip step 7, you'll see "Monetag SDK
not loaded" instead of it working, which is expected until that's wired
up. Connect a Tonkeeper wallet from the Profile tab to test withdrawals.

## Ongoing: reviewing withdrawals

`GET https://your-backend-url/api/admin/withdrawals/pending` (with
header `x-admin-key: <your ADMIN_API_KEY>`) lists pending payouts — you
can call this from any API tool (Postman, Insomnia, or even a browser
extension like "Requestly") without writing code. Once you've sent the
USDT manually, `POST .../api/admin/withdrawal/complete` with the
withdrawal's `id` and the `tx_hash` marks it done.
