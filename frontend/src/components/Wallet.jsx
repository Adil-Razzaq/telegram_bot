import { useEffect, useState } from 'react';
import { api } from '../api';

const TON_ADDRESS_REGEX = /^((EQ|UQ|kQ|0Q)[A-Za-z0-9_-]{46}|-?[01]:[a-fA-F0-9]{64})$/;
const MIN_WITHDRAWAL_POINTS = 500;

function shortAddress(addr) {
  if (!addr) return '';
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export default function Wallet({
  telegramId,
  mainBalance,
  onBalanceChange,
  connectedWallet,
  walletConnecting,
  walletError,
  onConnectWallet,
  onDisconnectWallet,
}) {
  const [config, setConfig] = useState(null);

  const [showWithdrawForm, setShowWithdrawForm] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [soundOn, setSoundOn] = useState(() => localStorage.getItem('soundOn') !== 'false');

  const [address, setAddress] = useState(connectedWallet || '');
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

  useEffect(() => {
    api.getConfig().then(setConfig).catch(() => {});
  }, []);

  // Keep the withdrawal address field pre-filled with whatever's
  // connected — connecting/disconnecting on the Mine-tab header (shared
  // state, see App.jsx) is reflected here automatically.
  useEffect(() => {
    if (connectedWallet) setAddress(connectedWallet);
  }, [connectedWallet]);

  useEffect(() => {
    if (!historyLoaded) return;
    const hasPending = history.some((w) => w.status === 'PENDING');
    if (!hasPending) return;
    const interval = setInterval(loadHistory, 15000);
    return () => clearInterval(interval);
  }, [history, historyLoaded]);

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
  const withdrawalsDisabled = config?.withdrawals && config.withdrawals.enabled === false;
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

      {/* Real now: "verified" = has a TON wallet connected (same
          connectedWallet used for the Mine-tab header and withdrawals —
          one source of truth, see App.jsx). Tapping Verify just runs the
          same connect flow as everywhere else in the app. */}
      <div className="glass-card">
        <span
          className="glass-card-icon round"
          style={
            connectedWallet
              ? { background: 'rgba(74,222,128,0.12)', color: '#4ade80' }
              : { background: 'rgba(255,255,255,0.06)', color: 'var(--muted)' }
          }
        >
          {connectedWallet ? '✅' : '⬜'}
        </span>
        <div className="glass-card-body">
          <p className="glass-card-title">Account Verification</p>
          <p className="glass-card-subtitle">{connectedWallet ? 'Verified' : 'Unverified'}</p>
        </div>
        {!connectedWallet && (
          <button className="gold-button" onClick={onConnectWallet} disabled={walletConnecting}>
            {walletConnecting ? '…' : 'Verify'}
          </button>
        )}
      </div>

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
            <button type="button" className="ghost-pill" onClick={onDisconnectWallet}>
              Disconnect
            </button>
          </>
        ) : (
          <button type="button" className="gold-button" onClick={onConnectWallet} disabled={walletConnecting}>
            {walletConnecting ? 'Connecting…' : '🔗 Connect Tonkeeper'}
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
        <button
          className="gold-button"
          onClick={() => setShowWithdrawForm((v) => !v)}
          disabled={withdrawalsDisabled}
        >
          {withdrawalsDisabled ? (config?.withdrawals?.message || 'Unavailable') : 'Withdraw'}
        </button>
      </div>

      {showWithdrawForm && !withdrawalsDisabled && (
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
