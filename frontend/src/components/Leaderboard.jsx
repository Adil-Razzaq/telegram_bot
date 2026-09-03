import { useEffect, useState } from 'react';
import { api } from '../api';

function medalFor(rank) {
  if (rank === 1) return '🥇';
  if (rank === 2) return '🥈';
  if (rank === 3) return '🥉';
  return null;
}

export default function Leaderboard() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api
      .leaderboard()
      .then(setData)
      .catch((e) => setError(e.message));
  }, []);

  if (error) {
    return (
      <div className="leaderboard-page">
        <h2 className="page-title">Leaderboard</h2>
        <p className="friends-error">{error}</p>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="leaderboard-page">
        <p className="tasks-empty">Loading leaderboard…</p>
      </div>
    );
  }

  return (
    <div className="leaderboard-page">
      <h2 className="page-title">Leaderboard</h2>
      <p className="page-subtitle">Ranked by total referrals — biggest inviters on top</p>

      <div className="glass-card leaderboard-me-card">
        <span className="glass-card-icon round">🏅</span>
        <div className="glass-card-body">
          <p className="glass-card-title">Your rank</p>
          <p className="glass-card-subtitle">
            {data.my_rank ? `#${data.my_rank}` : 'Unranked'} · {data.my_referral_count} referral
            {data.my_referral_count === 1 ? '' : 's'}
          </p>
        </div>
      </div>

      {data.leaderboard.length === 0 ? (
        <p className="page-subtitle" style={{ marginTop: 20 }}>
          No referrals yet — be the first to invite a friend!
        </p>
      ) : (
        <ul className="leaderboard-list">
          {data.leaderboard.map((row) => (
            <li key={row.telegram_id} className={`leaderboard-row${row.is_me ? ' me' : ''}`}>
              <span className="leaderboard-rank">{medalFor(row.rank) || `#${row.rank}`}</span>
              <span className="leaderboard-avatar">
                {(row.username || String(row.telegram_id))[0].toUpperCase()}
              </span>
              <span className="leaderboard-name">
                {row.username ? `@${row.username}` : `User ${row.telegram_id}`}
                {row.is_me && <span className="leaderboard-you-badge">You</span>}
              </span>
              <span className="leaderboard-count">{row.referral_count}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
