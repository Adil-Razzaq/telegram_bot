import { useEffect, useState } from 'react';
import { api } from '../api';
import { initTonConnectAutoConnect, connectTonWallet, disconnectTonWallet } from '../tonConnect';

const TON_ADDRESS_REGEX = /^((EQ|UQ|kQ|0Q)[A-Za-z0-9_-]{46}|-?[01]:[a-fA-F0-9]{64})$/;
const MIN_WITHDRAWAL_POINTS = 500;

function shortAddress(addr) {
  if (!addr) return '';
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export default function Wallet({ telegramId, mainBalance, onBalanceChange }) {
  const [connectedWallet, setConnectedWallet] = useState(null);
  const [connecting, setConnecting] = useState(false);
  const [walletError, setWalletError] = useState(null);
  const [config, setConfig] = useState(null);

  // The mockup's Withdraw/History cards are triggers, not permanently
  // visible forms — this is the real functionality from before, now
  // tucked behind the same card-tap pattern instead of always showing.
  const [showWithdrawForm, setShowWithdrawForm] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [soundOn, setSoundOn] = useState(() => localStorage.getItem('soundOn') !== 'false');

  const [address, setAddress] = useState('');
  const [points, setPoints] = useState('');
  const [history, setHistory] = useState([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [successMsg, setSuccessMsg] = useState(null);

  async function loadHistory() {
    try {
      const res = await api.withdrawalHistory();
      setHistory(res.withdrawals);
      setHistoryLoaded(true);
    } catch (e) {
      setError(e.message);
    }
  }

  async function loadWalletStatus() {
    try {
      const me = await api.getMe();
      if (me.wallet_address) {
        setConnectedWallet(me.wallet_address);
        setAddress(me.wallet_address);
      }
    } catch (e) {
      // non-fatal — the rest of the page still works without this
    }
  }

  async function tryAutoConnect() {
    try {
      const restoredAddress = await initTonConnectAutoConnect();
      if (!restoredAddress) return;
      const me = await api.getMe();
      if (!me.wallet_address) {
        const result = await api.connectWallet(restoredAddress);
        setConnectedWallet(result.wallet_address);
        setAddress(result.wallet_address);
      }
    } catch (e) {
      // silent — user can still tap Connect manually
    }
  }

  useEffect(() => {
    loadWalletStatus();
    tryAutoConnect();
    api.getConfig().then(setConfig).catch(() => {});
  }, []);

  useEffect(() => {
    if (!historyLoaded) return;
    const hasPending = history.some((w) => w.status === 'PENDING');
    if (!hasPending) return;
    const interval = setInterval(loadHistory, 15000);
    return () => clearInterval(interval);
  }, [history, historyLoaded]);

  async function handleConnect() {
    setConnecting(true);
    setWalletError(null);
    try {
      const walletAddress = await connectTonWallet();
      const result = await api.connectWallet(walletAddress);
      setConnectedWallet(result.wallet_address);
      setAddress(result.wallet_address);
    } catch (e) {
      setWalletError(e.message);
    } finally {
      setConnecting(false);
    }
  }

  async function handleDisconnect() {
    setWalletError(null);
    try {
      await api.disconnectWallet();
      await disconnectTonWallet();
      setConnectedWallet(null);
    } catch (e) {
      setWalletError(e.message);
    }
  }

  function toggleSound() {
    setSoundOn((prev) => {
      const next = !prev;
      localStorage.setItem('soundOn', String(next));
      return next;
    });
  }

  function toggleHistory() {
    setShowHistory((v) => !v);
    if (!historyLoaded) loadHistory();
  }

  const pointsPerUsd = config?.points_per_usd || 10000;
  const pointsNum = Number(points);
  const addressValid = TON_ADDRESS_REGEX.test(address);
  const amountValid =
    Number.isInteger(pointsNum) && pointsNum >= MIN_WITHDRAWAL_POINTS && pointsNum <= mainBalance;
  const canSubmit = addressValid && amountValid && !submitting;

  async function handleSubmit(e) {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    setSuccessMsg(null);
    try {
      const { withdrawal } = await api.requestWithdrawal(address, pointsNum);
      onBalanceChange(mainBalance - pointsNum);
      setSuccessMsg(`Withdrawal of $${withdrawal.amount_usd.toFixed(2)} submitted — pending review.`);
      setPoints('');
      await loadHistory();
    } catch (e) {
      setError(e.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="wallet">
      <h2 className="page-title">Profile</h2>

      {telegramId && (
        <div className="glass-card">
          <span className="glass-card-icon round">👤</span>
          <div className="glass-card-body">
            <p className="glass-card-title">User ID</p>
            <p className="glass-card-subtitle num">{telegramId}</p>
          </div>
        </div>
      )}

      {/* Inert — no verification system exists yet. Shown for the visual,
          does nothing when tapped. Ask if you want this to be real. */}
      <div className="glass-card">
        <span className="glass-card-icon round" style={{ background: 'rgba(74,222,128,0.12)', color: '#4ade80' }}>
          ✅
        </span>
        <div className="glass-card-body">
          <p className="glass-card-title">Account Verification</p>
          <p className="glass-card-subtitle">Unverified</p>
        </div>
        <button className="gold-button" disabled title="Not implemented yet">
          Verify
        </button>
      </div>

      {/* Inert visually, but the toggle itself is real (persisted to
          localStorage) — there's just no actual sound system in the app
          yet for it to control. */}
      <div className="glass-card" onClick={toggleSound} style={{ cursor: 'pointer' }}>
        <span className="glass-card-icon round">{soundOn ? '🔊' : '🔇'}</span>
        <div className="glass-card-body">
          <p className="glass-card-title">Sound effects</p>
          <p className="glass-card-subtitle">{soundOn ? 'On — tap to mute' : 'Muted — tap to unmute'}</p>
        </div>
      </div>

      <div className="glass-card">
        <span className="glass-card-icon round" style={{ background: 'rgba(250,204,21,0.12)', color: '#facc15' }}>
          💰
        </span>
        <div className="glass-card-body">
          <p className="glass-card-title">Assets</p>
          <p className="glass-card-subtitle num">{mainBalance.toLocaleString()} ADLX</p>
        </div>
        <span className="value-chip">≈ ${(mainBalance / pointsPerUsd).toFixed(2)}</span>
      </div>

      {/* This is your one real balance, shown once — see the note in
          chat about why "Holding Wallet" isn't a separate card here. */}
      <div className="glass-card">
        <span className="glass-card-icon round" style={{ background: 'rgba(147,197,253,0.12)', color: '#93c5fd' }}>
          🏦
        </span>
        <div className="glass-card-body">
          <p className="glass-card-title">Wallet</p>
          <p className="glass-card-subtitle">Withdrawable balance</p>
        </div>
        <span className="glass-card-value" style={{ color: 'var(--accent)' }}>
          {mainBalance.toLocaleString()} ADLX
        </span>
      </div>

      <h3 style={{ textAlign: 'center' }}>Controls</h3>

      <div className="wallet-connect-row">
        {connectedWallet ? (
          <>
            <span className="wallet-connected-chip">🔗 {shortAddress(connectedWallet)}</span>
            <button type="button" className="ghost-pill" onClick={handleDisconnect}>
              Disconnect
            </button>
          </>
        ) : (
          <button type="button" className="gold-button" onClick={handleConnect} disabled={connecting}>
            {connecting ? 'Connecting…' : '🔗 Connect Tonkeeper'}
          </button>
        )}
      </div>
      {walletError && <p className="wallet-error">{walletError}</p>}

      <div className="glass-card" style={{ marginTop: 12 }}>
        <span className="glass-card-icon round">📤</span>
        <div className="glass-card-body">
          <p className="glass-card-title">Withdraw</p>
          <p className="glass-card-subtitle">Transfer balance to your wallet</p>
        </div>
        <button className="gold-button" onClick={() => setShowWithdrawForm((v) => !v)}>
          Withdraw
        </button>
      </div>

      {showWithdrawForm && (
        <form onSubmit={handleSubmit} className="wallet-form">
          <label>
            TON wallet address
            <input
              value={address}
              onChange={(e) => setAddress(e.target.value.trim())}
              placeholder="EQ... or UQ..."
            />
            {address && !addressValid && <span className="field-error">Invalid TON address</span>}
          </label>

          <label>
            ADLX to withdraw (min {MIN_WITHDRAWAL_POINTS})
            <input
              type="number"
              value={points}
              onChange={(e) => setPoints(e.target.value)}
              min={MIN_WITHDRAWAL_POINTS}
              max={mainBalance}
            />
            {points && !amountValid && (
              <span className="field-error">
                Enter a whole number between {MIN_WITHDRAWAL_POINTS} and {mainBalance}
              </span>
            )}
          </label>

          <button type="submit" disabled={!canSubmit}>
            {submitting ? 'Submitting…' : 'Request withdrawal'}
          </button>
        </form>
      )}

      {successMsg && <p className="wallet-success">{successMsg}</p>}
      {error && <p className="wallet-error">{error}</p>}

      <div className="glass-card">
        <span className="glass-card-icon round">🧾</span>
        <div className="glass-card-body">
          <p className="glass-card-title">History</p>
          <p className="glass-card-subtitle">Your withdrawals</p>
        </div>
        <button className="gold-button" onClick={toggleHistory}>
          {showHistory ? 'Close' : 'Open'}
        </button>
      </div>

      {showHistory && (
        <>
          {!historyLoaded ? (
            <p className="wallet-empty">Loading…</p>
          ) : history.length === 0 ? (
            <p className="wallet-empty">No withdrawals yet.</p>
          ) : (
            <ul className="wallet-history">
              {history.map((w) => (
                <li key={w.id} className={`wallet-history-item status-${w.status.toLowerCase()}`}>
                  <div>
                    <strong>${w.amount_usd.toFixed(2)}</strong> ({w.points_deducted} ADLX)
                    <span className={`status-badge status-${w.status.toLowerCase()}`}>{w.status}</span>
                  </div>
                  <div className="wallet-history-meta">
                    {new Date(w.created_at).toLocaleString()}
                    {w.tx_hash && (
                      <a
                        href={`https://tonviewer.com/transaction/${w.tx_hash}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        View on Tonviewer
                      </a>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
