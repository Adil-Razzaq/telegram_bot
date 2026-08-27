import { useEffect, useState } from 'react';
import { api } from '../api';

const BEP20_ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/;
const POINTS_PER_USD = 10000;
const MIN_WITHDRAWAL_POINTS = 500;

export default function Wallet({ mainBalance, onBalanceChange }) {
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

  useEffect(() => {
    loadHistory();
  }, []);

  const pointsNum = Number(points);
  const addressValid = BEP20_ADDRESS_REGEX.test(address);
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
      <h2>Wallet</h2>
      <p className="wallet-balance">
        Balance: <strong>{mainBalance}</strong> pts (${(mainBalance / POINTS_PER_USD).toFixed(2)})
      </p>

      <form onSubmit={handleSubmit} className="wallet-form">
        <label>
          BEP-20 (BSC) USDT address
          <input
            value={address}
            onChange={(e) => setAddress(e.target.value.trim())}
            placeholder="0x..."
          />
          {address && !addressValid && <span className="field-error">Invalid BEP-20 address</span>}
        </label>

        <label>
          Points to withdraw (min {MIN_WITHDRAWAL_POINTS})
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
                <strong>${w.amount_usd.toFixed(2)}</strong> ({w.points_deducted} pts)
                <span className={`status-badge status-${w.status.toLowerCase()}`}>{w.status}</span>
              </div>
              <div className="wallet-history-meta">
                {new Date(w.created_at).toLocaleString()}
                {w.tx_hash && (
                  <a
                    href={`https://bscscan.com/tx/${w.tx_hash}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    View on BscScan
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
