import { useEffect, useState } from 'react';
import Miner from './components/Miner';
import Tasks from './components/Tasks';
import SpinWheel from './components/SpinWheel';
import ReferralDashboard from './components/ReferralDashboard';
import Wallet from './components/Wallet';
import { api } from './api';
import './styles/app.css';

export default function App() {
  const [tab, setTab] = useState('miner');
  const [mainBalance, setMainBalance] = useState(0);
  const [balanceLoaded, setBalanceLoaded] = useState(false);
  const [telegramId, setTelegramId] = useState(null);
  const [displayName, setDisplayName] = useState(null);

  useEffect(() => {
    const tg = window.Telegram?.WebApp;
    tg?.ready();
    tg?.expand();
    const user = tg?.initDataUnsafe?.user;
    if (user) {
      setTelegramId(user.id);
      setDisplayName(user.username ? `@${user.username}` : user.first_name || 'Player');
    }

    api
      .getMe()
      .then((me) => setMainBalance(me.main_balance ?? 0))
      .catch(() => {})
      .finally(() => setBalanceLoaded(true));
  }, []);

  const initial = (displayName || 'P').replace('@', '')[0]?.toUpperCase() || 'P';

  return (
    <div className="app">
      <header className="app-header">
        <div className="user-chip">
          <span className="user-avatar">{initial}</span>
          <span className="user-name">{displayName || 'Player'}</span>
        </div>
        <span className="balance-pill num">{balanceLoaded ? `${mainBalance} pts` : '…'}</span>
      </header>

      <main className="app-main">
        {tab === 'miner' && (
          <Miner mainBalance={mainBalance} onBalanceChange={setMainBalance} />
        )}
        {tab === 'tasks' && <Tasks onBalanceChange={setMainBalance} />}
        {tab === 'spin' && (
          <SpinWheel mainBalance={mainBalance} onBalanceChange={setMainBalance} />
        )}
        {tab === 'referral' && (
          <ReferralDashboard telegramId={telegramId} onBalanceChange={setMainBalance} />
        )}
        {tab === 'wallet' && (
          <Wallet mainBalance={mainBalance} onBalanceChange={setMainBalance} />
        )}
      </main>

      <nav className="app-tabs">
        <button className={tab === 'miner' ? 'active' : ''} onClick={() => setTab('miner')}>
          Miner
        </button>
        <button className={tab === 'tasks' ? 'active' : ''} onClick={() => setTab('tasks')}>
          Tasks
        </button>
        <button className={tab === 'spin' ? 'active' : ''} onClick={() => setTab('spin')}>
          Spin
        </button>
        <button className={tab === 'referral' ? 'active' : ''} onClick={() => setTab('referral')}>
          Referrals
        </button>
        <button className={tab === 'wallet' ? 'active' : ''} onClick={() => setTab('wallet')}>
          Wallet
        </button>
      </nav>
    </div>
  );
}
