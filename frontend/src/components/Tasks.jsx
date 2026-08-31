import { useEffect, useState } from 'react';
import { api } from '../api';

// Existing tasks store emoji icons (e.g. "🐦"); the new design uses
// Material Symbols ligature names (e.g. "chat_bubble"). This renders
// either correctly: a plain lowercase/underscore string is treated as a
// Material Symbol, anything else (emoji, unicode) renders as-is — so
// tasks created before this redesign keep working without a data
// migration.
function isMaterialSymbolName(icon) {
  return /^[a-z0-9_]+$/.test(icon || '');
}

export default function Tasks({ onBalanceChange }) {
  const [tasks, setTasks] = useState(null);
  const [visited, setVisited] = useState({});
  const [claimingId, setClaimingId] = useState(null);
  const [error, setError] = useState(null);

  async function refresh() {
    try {
      const res = await api.taskList();
      setTasks(res.tasks);
    } catch (e) {
      setError(e.message);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  function handleGo(task) {
    window.Telegram?.WebApp?.openLink
      ? window.Telegram.WebApp.openLink(task.link_url)
      : window.open(task.link_url, '_blank');
    setVisited((v) => ({ ...v, [task.id]: true }));
  }

  async function handleClaim(task) {
    setClaimingId(task.id);
    setError(null);
    try {
      const result = await api.claimTask(task.id);
      onBalanceChange(result.main_balance);
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setClaimingId(null);
    }
  }

  if (!tasks) {
    return (
      <div className="tasks-page">
        <p className="tasks-empty">Loading tasks…</p>
      </div>
    );
  }

  return (
    <div className="tasks-page">
      <div className="tasks-header">
        <h2>Earn Rewards</h2>
        <p className="tasks-subtitle">Rewards go directly to your balance</p>
      </div>

      {tasks.length === 0 && <p className="tasks-empty">No tasks available right now.</p>}

      <div className="tasks-list">
        {tasks.map((task) => (
          <div key={task.id} className="task-card">
            <span className="task-icon">
              {isMaterialSymbolName(task.icon) ? (
                <span className="material-symbols-outlined">{task.icon}</span>
              ) : (
                task.icon
              )}
            </span>
            <div className="task-info">
              <span className="task-title">{task.title}</span>
              <span className="task-reward">+{task.reward_points} ADLX</span>
            </div>
            {task.completed ? (
              <button className="task-button task-button-done" disabled>
                Done
              </button>
            ) : visited[task.id] ? (
              <button
                className="task-button task-button-claim"
                onClick={() => handleClaim(task)}
                disabled={claimingId === task.id}
              >
                {claimingId === task.id ? '…' : 'Claim'}
              </button>
            ) : (
              <button className="task-button" onClick={() => handleGo(task)}>
                Go
              </button>
            )}
          </div>
        ))}
      </div>

      {error && <p className="tasks-error">{error}</p>}
    </div>
  );
}
