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

// Trust Azure internal proxy load balancers cleanly
app.set('trust proxy', true);

// Configure Helmet to allow cross-origin resource sharing for Telegram Mini Apps
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
    crossOriginOpenerPolicy: { policy: "unsafe-none" }
  })
);

// Allow Vercel and Telegram web apps to talk to your Azure API seamlessly
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

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

// Central error handler
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
