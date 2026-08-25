require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const { migrate } = require('./db/db');
const spinRoutes = require('./routes/spin');
const referralRoutes = require('./routes/referral');
const withdrawalRoutes = require('./routes/withdrawal');
const adminRoutes = require('./routes/admin');

const app = express();
app.use(cors());
app.use(express.json());

// Global rate limit as a baseline defense; per-route limits (e.g. the 60s
// referral cooldown) are enforced in the service layer regardless.
app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

app.get('/health', (req, res) => res.json({ ok: true }));

app.use('/api/spin', spinRoutes);
app.use('/api/referral', referralRoutes);
app.use('/api/withdrawal', withdrawalRoutes);
app.use('/api/admin', adminRoutes);

// Central error handler as a safety net for anything a route forgot to catch
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.statusCode || 500).json({ ok: false, error: err.message || 'Internal error' });
});

const PORT = process.env.PORT || 4000;

// Create tables on Turso if they don't exist yet, then start accepting traffic.
migrate()
  .then(() => {
    app.listen(PORT, () => console.log(`Spin/referral/withdrawal API listening on :${PORT}`));
  })
  .catch((err) => {
    console.error('Failed to run database migration on startup:', err);
    process.exit(1);
  });
