import { useEffect, useState } from 'react';
import { api } from '../api';

function timeAgo(iso) {
  const seconds = Math.floor((Date.now() - new Date(iso + 'Z').getTime()) / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export default function Stream() {
  const [activity, setActivity] = useState(null);
  const [error, setError] = useState(null);

  async function refresh() {
    try {
      const res = await api.streamRecent();
      setActivity(res.activity);
    } catch (e) {
      setError(e.message);
    }
  }

  useEffect(() => {
    refresh();
    // Polled, not a real push feed — simple and reliable, and 8s feels
    // "live" without hammering the server.
    const interval = setInterval(refresh, 8000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="tasks-page">
      <h2 className="page-title">Live Activity</h2>
      <p className="task-reward" style={{ textAlign: 'center', marginBottom: 12 }}>
        What everyone's earning, right now.
      </p>

      {error && <p className="miner-error">{error}</p>}

      {activity === null ? (
        <p className="tasks-empty">Loading…</p>
      ) : activity.length === 0 ? (
        <p className="tasks-empty">No activity yet — be the first!</p>
      ) : (
        <div className="stream-list">
          {activity.map((item, i) => (
            <div key={i} className="stream-row">
              <span className="material-symbols-outlined stream-row-icon">bolt</span>
              <div className="stream-row-body">
                <span className="stream-row-text">
                  <strong>{item.display_name}</strong> {item.action}
                </span>
                <span className="stream-row-time">{timeAgo(item.created_at)}</span>
              </div>
              <span className="stream-row-points">+{item.points}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
