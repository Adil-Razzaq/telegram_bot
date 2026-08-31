require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const { migrate } = require('./db/db');
const spinRoutes = require('./routes/spin');
const referralRoutes = require('./routes/referral');
const withdrawalRoutes = require('./routes/withdrawal');
const adminRoutes = require('./routes/admin');
const botRoutes = require('./routes/bot');
const userRoutes = require('./routes/user');
const minerRoutes = require('./routes/miner');
const taskRoutes = require('./routes/tasks');
const walletRoutes = require('./routes/wallet');

const app = express();

// You're behind nginx on the VM, which sets X-Forwarded-For. Without this,
// express-rate-limit can't safely tell one visitor's IP from another's
// (everyone would appear to share nginx's IP), and throws the
// ERR_ERL_UNEXPECTED_X_FORWARDED_FOR warning seen in your logs. `1` means
// trust exactly one hop of proxy (nginx) — correct for this setup.
app.set('trust proxy', true);

app.use(helmet());

// Only your actual frontend can call this API — set FRONTEND_URL in
// Render's env vars to your Vercel URL. Falls back to allow-all if unset
// (fine for local dev, not for production).
const allowedOrigin = process.env.FRONTEND_URL;
app.use(cors(allowedOrigin ? { origin: allowedOrigin } : {}));

app.use(express.json());

app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    validate: { trustProxy: false },
  })
);

app.get('/health', (req, res) => res.json({ ok: true }));
app.get('/admin', (req, res) => {
  // helmet's default CSP (applied globally above) blocks inline
  // <script>/<style> tags, which is exactly what this simple
  // single-file admin page uses. Overriding it just for this one
  // response rather than weakening CSP everywhere else. The actual
  // protection here is still adminAuth on every API call the page
  // makes — this page itself contains no secrets or sensitive data.
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'"
  );
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.use('/api/spin', spinRoutes);
app.use('/api/referral', referralRoutes);
app.use('/api/withdrawal', withdrawalRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/user', userRoutes);
app.use('/api/miner', minerRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/bot', botRoutes);

// Central error handler. In production, unexpected (non-statusCode) errors
// return a generic message instead of the raw error text, so internal
// details never leak to a client.
app.use((err, req, res, next) => {
  console.error(err);
  const isProd = process.env.NODE_ENV === 'production';
  res.status(err.statusCode || 500).json({
    ok: false,
    error: isProd && !err.statusCode ? 'Internal error' : err.message || 'Internal error',
  });
});

const PORT = process.env.PORT || 4000;

// Create tables on Turso if they don't exist yet, then start accepting traffic.
migrate()
  .then(() => {
    app.listen(PORT, () => console.log(`API listening on :${PORT}`));
  })
  .catch((err) => {
    console.error('Failed to run database migration on startup:', err);
    process.exit(1);
  });
