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

  const [address, setAddress] = useState('');
  const [points, setPoints] = useState('');
  const [history, setHistory] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [successMsg, setSuccessMsg] = useState(null);

  async function loadHistory() {
    try {
      const res = await api.withdrawalHistory();
      setHistory(res.withdrawals);
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
      // non-fatal — the rest of the wallet page still works without this
    }
  }

  // "Login with the same Tonkeeper" in practice: TON Connect restores a
  // previous session automatically on load. If it restores an address,
  // AND this account has no wallet linked yet, we link it here — this is
  // what makes a returning user with the same Tonkeeper resolve straight
  // back to this account, no manual re-connect needed. If a DIFFERENT
  // wallet auto-restores than what's linked, we deliberately don't
  // silently switch anything — connectWallet's own conflict handling
  // covers that safely (see walletService.js).
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
      // Auto-connect failing silently is correct here — the user can
      // still tap Connect manually, this just skips the convenience path.
    }
  }

  useEffect(() => {
    loadHistory();
    loadWalletStatus();
    tryAutoConnect();
    api.getConfig().then(setConfig).catch(() => {});
  }, []);

  useEffect(() => {
    const hasPending = history.some((w) => w.status === 'PENDING');
    if (!hasPending) return;
    const interval = setInterval(loadHistory, 15000);
    return () => clearInterval(interval);
  }, [history]);

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
      <h2>Profile</h2>
      {telegramId && (
        <div className="friends-card">
          <span className="friends-card-icon">👤</span>
          <div className="friends-card-info">
            <span className="friends-card-label">User ID</span>
            <span className="friends-card-value profile-user-id">{telegramId}</span>
          </div>
        </div>
      )}
      <p className="wallet-balance">
        Balance: <strong>{mainBalance}</strong> ADLX (${(mainBalance / pointsPerUsd).toFixed(2)})
      </p>

      <div className="wallet-connect-row">
        {connectedWallet ? (
          <>
            <span className="wallet-connected-chip">🔗 {shortAddress(connectedWallet)}</span>
            <button type="button" className="wallet-disconnect-button" onClick={handleDisconnect}>
              Disconnect
            </button>
          </>
        ) : (
          <button
            type="button"
            className="wallet-connect-button"
            onClick={handleConnect}
            disabled={connecting}
          >
            {connecting ? 'Connecting…' : '🔗 Connect Tonkeeper'}
          </button>
        )}
      </div>
      {walletError && <p className="wallet-error">{walletError}</p>}

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

      {successMsg && <p className="wallet-success">{successMsg}</p>}
      {error && <p className="wallet-error">{error}</p>}

      <h3>History</h3>
      {history.length === 0 ? (
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
    </div>
  );
}
