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

## 7. Test it

Open your bot in Telegram, tap the menu button. The app should load
inside Telegram, and API calls should reach your Render backend. If a
spin or claim fails with an ad-verification error, that's expected until
you've wired up real Adsgram credentials (step 4's `ADSGRAM_VERIFY_SECRET`
and step 5's `VITE_ADSGRAM_BLOCK_ID`) — everything else (balances,
withdrawals, admin endpoints) works without Adsgram.

## Ongoing: reviewing withdrawals

`GET https://your-app.onrender.com/api/admin/withdrawals/pending` (with
header `x-admin-key: <your ADMIN_API_KEY>`) lists pending payouts — you
can call this from any API tool (Postman, Insomnia, or even a browser
extension like "Requestly") without writing code. Once you've sent the
USDT manually, `POST .../api/admin/withdrawal/complete` with the
withdrawal's `id` and the `tx_hash` marks it done.
