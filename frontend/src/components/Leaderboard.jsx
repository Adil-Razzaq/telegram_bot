import { useEffect, useState } from 'react';
import { api } from '../api';
import { withConfirmationRetry } from '../monetag';
import { showStreakAd } from '../adNetwork';
import { playNotificationSound } from '../sound';

export default function Leaderboard() {
  const [config, setConfig] = useState(null);
  const [streak, setStreak] = useState(null);
  const [board, setBoard] = useState(null);
  const [claiming, setClaiming] = useState(false);
  const [error, setError] = useState(null);

  async function refresh() {
    try {
      const [cfg, s, b] = await Promise.all([api.getConfig(), api.streakStatus(), api.leaderboardTop()]);
      setConfig(cfg);
      setStreak(s);
      setBoard(b);
    } catch (e) {
      setError(e.message);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function handleClaimStreak() {
    if (claiming) return;
    setClaiming(true);
    setError(null);
    try {
      const { nonce } = await api.prepareStreakClaim();
      await showStreakAd(nonce, config);
      await withConfirmationRetry(() => api.claimStreak(nonce));
      playNotificationSound();
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setClaiming(false);
    }
  }

  if (!streak || !board) {
    return <div className="tasks-page">Loading…</div>;
  }

  return (
    <div className="tasks-page leaderboard-page">
      <h2 className="page-title">Streak</h2>
      {streak.broke_streak && (
        <p className="task-reward" style={{ color: 'var(--danger)', textAlign: 'center', marginBottom: 8 }}>
          You missed a day — streak reset to Day 1.
        </p>
      )}

      <div className="streak-days">
        {streak.rewards.map((r) => {
          const completed = r.day <= streak.current_day && !(streak.broke_streak && r.day > 1);
          const isNext = r.day === streak.next_day;
          return (
            <div
              key={r.day}
              className={`streak-day${completed ? ' completed' : ''}${isNext ? ' next' : ''}`}
            >
              <span className="streak-day-num">Day {r.day}</span>
              <span className="streak-day-points">+{r.points}</span>
              {completed && <span className="material-symbols-outlined streak-day-check">check_circle</span>}
            </div>
          );
        })}
      </div>

      <div className="task-card">
        <span className="task-icon">
          <span className="material-symbols-outlined">local_fire_department</span>
        </span>
        <div className="task-info">
          <span className="task-title">
            {streak.can_claim ? `Claim Day ${streak.next_day}` : "Today's streak claimed"}
          </span>
          <span className="task-reward">
            {streak.can_claim ? `+${streak.next_reward} ADLX` : 'Come back tomorrow'}
          </span>
        </div>
        <button
          className="task-button task-button-claim"
          onClick={handleClaimStreak}
          disabled={claiming || !streak.can_claim}
        >
          {claiming ? '…' : streak.can_claim ? 'Watch ad' : 'Done'}
        </button>
      </div>

      <h2 className="page-title" style={{ marginTop: 24 }}>
        Leaderboard
      </h2>
      <p className="task-reward" style={{ textAlign: 'center', marginBottom: 8 }}>
        Ranked by total referrals — most referrals at the top.
      </p>

      {board.you && (
        <div className="leaderboard-row leaderboard-you">
          <span className="leaderboard-rank">{board.you.rank ? `#${board.you.rank}` : '—'}</span>
          <span className="leaderboard-name">You</span>
          <span className="leaderboard-count">{board.you.referral_count} referrals</span>
        </div>
      )}

      <div className="tasks-list">
        {board.leaderboard.length === 0 && (
          <p className="tasks-empty">No referrals yet — be the first on the board.</p>
        )}
        {board.leaderboard.map((row) => (
          <div key={row.rank} className={`leaderboard-row${row.is_you ? ' leaderboard-you' : ''}`}>
            <span className="leaderboard-rank">#{row.rank}</span>
            <span className="leaderboard-name">{row.display_name}</span>
            <span className="leaderboard-count">{row.referral_count} referrals</span>
          </div>
        ))}
      </div>

      {error && <p className="miner-error">{error}</p>}
    </div>
  );
}
