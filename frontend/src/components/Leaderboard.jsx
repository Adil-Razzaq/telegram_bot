import { useEffect, useState } from 'react';
import { api } from '../api';
import { withConfirmationRetry } from '../monetag';
import { showStreakAd } from '../adNetwork';
import { playNotificationSound } from '../sound';

function formatCountdown(seconds) {
  if (seconds <= 0) return 'Ending soon';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  if (days > 0) return `${days}d ${hours}h left`;
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${minutes}m left`;
}

// 1st place gets a crown ("king of the round") rather than a medal,
// to stand out from 2nd/3rd — matches how this was asked for.
function contestMedal(rank) {
  if (rank === 1) return '👑';
  if (rank === 2) return '🥈';
  if (rank === 3) return '🥉';
  return null;
}

export default function Leaderboard() {
  const [config, setConfig] = useState(null);
  const [streak, setStreak] = useState(null);
  const [board, setBoard] = useState(null);
  const [contest, setContest] = useState(null);
  const [showContestTerms, setShowContestTerms] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const [error, setError] = useState(null);

  async function refresh() {
    try {
      const [cfg, s, b, c] = await Promise.all([
        api.getConfig(),
        api.streakStatus(),
        api.leaderboardTop(),
        api.leaderboardMiningContest(),
      ]);
      setConfig(cfg);
      setStreak(s);
      setBoard(b);
      setContest(c.contest);
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
        <p className="leaderboard-subtitle" style={{ color: 'var(--danger)' }}>
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

      {contest && (
        <>
          <h2 className="page-title" style={{ marginTop: 24 }}>
            Active Referral Contest
          </h2>
          <p className="leaderboard-subtitle">{contest.subtitle}</p>

          <div className="contest-card">
            <div className="contest-timer">
              <span className="material-symbols-outlined">timer</span>
              {formatCountdown(contest.seconds_remaining)}
            </div>
            <div className="contest-prizes">
              <span>👑 {contest.prizes.first} ADLX</span>
              <span>🥈 {contest.prizes.second} ADLX</span>
              <span>🥉 {contest.prizes.third} ADLX</span>
            </div>
          </div>

          <button type="button" className="contest-terms-link" onClick={() => setShowContestTerms(true)}>
            <span className="material-symbols-outlined">gavel</span>
            Contest Terms &amp; Conditions
          </button>

          {contest.you && (
            <div className="leaderboard-row leaderboard-you">
              <span className="leaderboard-rank">
                {contest.you.rank ? `#${contest.you.rank}` : <span className="leaderboard-unranked">Unranked</span>}
              </span>
              <span className="leaderboard-name">You</span>
              <span className="leaderboard-count">{contest.you.active_referrals} active</span>
            </div>
          )}

          <div className="tasks-list">
            {contest.leaderboard.length === 0 && (
              <p className="tasks-empty">Nobody has an active referral yet — invite a friend to take the top spot.</p>
            )}
            {contest.leaderboard.map((row) => {
              const medal = contestMedal(row.rank);
              return (
                <div
                  key={row.rank}
                  className={`leaderboard-row${row.rank <= 3 ? ` contest-rank-${row.rank}` : ''}`}
                >
                  <span className="leaderboard-rank">{medal || `#${row.rank}`}</span>
                  <span className="leaderboard-name">{row.display_name}</span>
                  <span className="leaderboard-count">{row.active_referrals} active</span>
                </div>
              );
            })}
          </div>

          {showContestTerms && (
            <div className="modal-overlay" onClick={() => setShowContestTerms(false)}>
              <div className="modal-box" onClick={(e) => e.stopPropagation()}>
                <div className="modal-header">
                  <h3>Contest Terms &amp; Conditions</h3>
                  <button
                    type="button"
                    className="modal-close"
                    onClick={() => setShowContestTerms(false)}
                    aria-label="Close"
                  >
                    <span className="material-symbols-outlined">close</span>
                  </button>
                </div>
                <div className="modal-body">
                  <ul className="contest-terms-list">
                    <li>Round length: <strong>{contest.duration_days} days</strong>.</li>
                    <li>
                      A referral counts as <strong>active</strong> once they've completed{' '}
                      <strong>{contest.active_referral_cycles}+ mining cycles</strong>. Only referrals joined
                      during the current round count.
                    </li>
                    <li>
                      To actually WIN a prize, the minimum active referrals for each position are:
                      <ul>
                        <li>👑 1st place: <strong>{contest.min_active_referrals.first}+</strong> active referrals</li>
                        <li>🥈 2nd place: <strong>{contest.min_active_referrals.second}+</strong> active referrals</li>
                        <li>🥉 3rd place: <strong>{contest.min_active_referrals.third}+</strong> active referrals</li>
                      </ul>
                    </li>
                    <li>
                      If the person ranked in a position hasn't reached that position's minimum, <strong>no
                      prize is paid for that position</strong> — even if they're ranked #1, #2, or #3.
                    </li>
                    <li>
                      Prizes — 👑 {contest.prizes.first} ADLX, 🥈 {contest.prizes.second} ADLX, 🥉{' '}
                      {contest.prizes.third} ADLX — are credited automatically once the round ends.
                    </li>
                  </ul>
                </div>
                <button type="button" className="modal-close-button" onClick={() => setShowContestTerms(false)}>
                  Close
                </button>
              </div>
            </div>
          )}
        </>
      )}

      <h2 className="page-title" style={{ marginTop: 24 }}>
        Leaderboard
      </h2>
      <p className="leaderboard-subtitle">{board.subtitle}</p>

      {board.you && (
        <div className="leaderboard-row leaderboard-you">
          <span className="leaderboard-rank">
            {board.you.rank ? `#${board.you.rank}` : <span className="leaderboard-unranked">Unranked</span>}
          </span>
          <span className="leaderboard-name">You</span>
          <span className="leaderboard-count">{board.you.referral_count} active</span>
        </div>
      )}

      <div className="tasks-list">
        {board.leaderboard.length === 0 && (
          <p className="tasks-empty">Nobody has an active referral yet — invite a friend to take the top spot.</p>
        )}
        {board.leaderboard.map((row) => (
          <div key={row.rank} className={`leaderboard-row${row.is_you ? ' leaderboard-you' : ''}`}>
            <span className="leaderboard-rank">#{row.rank}</span>
            <span className="leaderboard-name">{row.display_name}</span>
            <span className="leaderboard-count">{row.referral_count} active</span>
          </div>
        ))}
      </div>

      {error && <p className="miner-error">{error}</p>}
    </div>
  );
}
