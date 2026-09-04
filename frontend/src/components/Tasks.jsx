import { useEffect, useState } from 'react';
import { api } from '../api';
import { showRewardedAd, withConfirmationRetry } from '../monetag';
import { showAdsgramRewardedAd } from '../adsgram';

// Existing tasks store emoji icons (e.g. "🐦"); the new design uses
// Material Symbols ligature names (e.g. "chat_bubble"). This renders
// either correctly: a plain lowercase/underscore string is treated as a
// Material Symbol, anything else (emoji, unicode) renders as-is — so
// tasks created before this redesign keep working without a data
// migration.
function isMaterialSymbolName(icon) {
  return /^[a-z0-9_]+$/.test(icon || '');
}

function msUntilNextUtcMidnight() {
  const now = new Date();
  const nextMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return nextMidnight - now.getTime();
}

function formatCountdown(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const h = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
  const m = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
  const s = String(totalSeconds % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

export default function Tasks({ onBalanceChange }) {
  const [tasks, setTasks] = useState(null);
  const [visited, setVisited] = useState({});
  const [claimingId, setClaimingId] = useState(null);
  const [error, setError] = useState(null);

  // The two fixed daily watch-ad slots (Monetag + Adsgram) — separate
  // from the admin-created `tasks` list above, since these are
  // repeatable daily rather than one-time. Hidden entirely if
  // action_ads_enabled is off (there's no such thing as a watch-ad
  // task with no ad), and the Adsgram card specifically is hidden if
  // no adsgram_block_id has been set yet in the admin panel.
  const [config, setConfig] = useState(null);
  const [adWatchStatus, setAdWatchStatus] = useState(null);
  const [watchingNetwork, setWatchingNetwork] = useState(null);
  // Purely cosmetic — counts down to the next UTC daily reset (when
  // watch limits refill), same "18:26:37" touch as the reference
  // design. Limits themselves reset server-side by calendar day
  // regardless of whether this timer is ever looked at.
  const [resetIn, setResetIn] = useState(msUntilNextUtcMidnight());

  useEffect(() => {
    const t = setInterval(() => setResetIn(msUntilNextUtcMidnight()), 1000);
    return () => clearInterval(t);
  }, []);

  async function refreshAdWatch() {
    try {
      const [cfg, status] = await Promise.all([api.getConfig(), api.adWatchStatus()]);
      setConfig(cfg);
      setAdWatchStatus(status.status);
    } catch (e) {
      // Non-fatal — the rest of Tasks still works if this fails.
    }
  }

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
    refreshAdWatch();
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

  // watch_ad tasks: Rewarded Popup, high CPM — one click both opens the
  // advertiser's page AND is the claim action, no separate Go/Claim
  // step. showRewardedAd must be called directly inside this click
  // handler (no earlier await) since the Popup format needs a real
  // browser user-gesture to open its new tab.
  async function handleWatchAdTask(task) {
    setClaimingId(task.id);
    setError(null);
    try {
      const { nonce } = await api.prepareAdTask(task.id);
      if (nonce) await showRewardedAd(nonce);
      const result = await withConfirmationRetry(() => api.claimAdTask(task.id, nonce));
      onBalanceChange(result.main_balance);
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setClaimingId(null);
    }
  }

  // The two fixed daily slots. Same nonce -> show ad -> confirm-and-spend
  // pattern as everything else, just against the ad-watch endpoints
  // instead of a specific task row.
  async function handleWatchDailyAd(network) {
    setWatchingNetwork(network);
    setError(null);
    try {
      const { nonce } = await api.prepareAdWatch(network);
      if (nonce) {
        if (network === 'monetag') await showRewardedAd(nonce);
        else await showAdsgramRewardedAd(config.adsgram_block_id);
      }
      const result = await withConfirmationRetry(() => api.claimAdWatch(network, nonce));
      onBalanceChange(result.main_balance);
      await refreshAdWatch();
    } catch (e) {
      setError(e.message);
    } finally {
      setWatchingNetwork(null);
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

      {config?.action_ads_enabled !== false && adWatchStatus && (
        <div className="watch-earn-section">
          <div className="watch-earn-header">
            <span className="watch-earn-title">
              <span className="watch-earn-dot" /> WATCH &amp; EARN
            </span>
            <span className="watch-earn-countdown">
              <span className="material-symbols-outlined">schedule</span>
              {formatCountdown(resetIn)}
            </span>
          </div>

          <div className="tasks-list">
            {config.adsgram_block_id && (
              <div className="task-card">
                <span className="task-icon watch-earn-icon-adsgram">
                  <span className="material-symbols-outlined">smart_display</span>
                </span>
                <div className="task-info">
                  <span className="task-title">Adsgram</span>
                  <span className="task-reward">
                    {adWatchStatus.adsgram.watched_today}/{adWatchStatus.adsgram.daily_limit}
                    <span className="watch-earn-reward-pill">+{adWatchStatus.adsgram.reward_points}</span>
                  </span>
                </div>
                <button
                  className="task-button task-button-claim watch-earn-button"
                  onClick={() => handleWatchDailyAd('adsgram')}
                  disabled={watchingNetwork === 'adsgram' || !adWatchStatus.adsgram.can_watch}
                >
                  {watchingNetwork === 'adsgram' ? '…' : adWatchStatus.adsgram.can_watch ? 'WATCH' : 'DONE'}
                </button>
              </div>
            )}

            <div className="task-card">
              <span className="task-icon watch-earn-icon-monetag">
                <span className="material-symbols-outlined">smart_display</span>
              </span>
              <div className="task-info">
                <span className="task-title">Monetag</span>
                <span className="task-reward">
                  {adWatchStatus.monetag.watched_today}/{adWatchStatus.monetag.daily_limit}
                  <span className="watch-earn-reward-pill">Bonus</span>
                </span>
              </div>
              <button
                className="task-button task-button-claim watch-earn-button"
                onClick={() => handleWatchDailyAd('monetag')}
                disabled={watchingNetwork === 'monetag' || !adWatchStatus.monetag.can_watch}
              >
                {watchingNetwork === 'monetag' ? '…' : adWatchStatus.monetag.can_watch ? 'WATCH' : 'DONE'}
              </button>
            </div>
          </div>
        </div>
      )}

      {tasks.length > 0 && (
        <div className="watch-earn-header" style={{ marginBottom: 10 }}>
          <span className="watch-earn-title">
            <span className="watch-earn-dot" /> MORE WAYS TO EARN
          </span>
        </div>
      )}
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
            ) : task.task_type === 'watch_ad' ? (
              <button
                className="task-button task-button-claim"
                onClick={() => handleWatchAdTask(task)}
                disabled={claimingId === task.id}
              >
                {claimingId === task.id ? '…' : 'Watch ad'}
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
