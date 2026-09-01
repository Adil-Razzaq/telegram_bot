import { useEffect, useState } from 'react';
import Miner from './components/Miner';
import Tasks from './components/Tasks';
import SpinWheel from './components/SpinWheel';
import Friends from './components/Friends';
import Wallet from './components/Wallet';
import { api } from './api';
import { enableInAppInterstitial } from './monetag';
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
      // Full name as set on their actual Telegram account (first + last),
      // not the @username — someone can go by a totally different
      // username than their real display name, and this is meant to show
      // the name they'd recognize themselves by, same as Telegram's own
      // UI shows throughout the app.
      const fullName = [user.first_name, user.last_name].filter(Boolean).join(' ');
      setDisplayName(fullName || user.username || 'Player');
    }

    api
      .getMe()
      .then((me) => setMainBalance(me.main_balance ?? 0))
      .catch(() => {})
      .finally(() => setBalanceLoaded(true));

    // Passive In-App Interstitial ads: first one 7s after open, then
    // auto-repeats (including across tab switches within the app) per
    // its own settings. Called once here, not per-tab/component.
    enableInAppInterstitial();
  }, []);

  return (
    <div className="app">
      <main className="app-main">
        {tab === 'miner' && (
          <Miner mainBalance={mainBalance} onBalanceChange={setMainBalance} />
        )}
        {tab === 'tasks' && <Tasks onBalanceChange={setMainBalance} />}
        {tab === 'spin' && (
          <SpinWheel mainBalance={mainBalance} onBalanceChange={setMainBalance} />
        )}
        {tab === 'friends' && (
          <Friends telegramId={telegramId} onBalanceChange={setMainBalance} />
        )}
        {tab === 'profile' && (
          <Wallet
            telegramId={telegramId}
            displayName={displayName}
            mainBalance={mainBalance}
            balanceLoaded={balanceLoaded}
            onBalanceChange={setMainBalance}
          />
        )}
      </main>

      <nav className="app-tabs">
        <button className={tab === 'miner' ? 'active' : ''} onClick={() => setTab('miner')}>
          Mine
        </button>
        <button className={tab === 'tasks' ? 'active' : ''} onClick={() => setTab('tasks')}>
          Tasks
        </button>
        <button className={tab === 'spin' ? 'active' : ''} onClick={() => setTab('spin')}>
          Spin
        </button>
        <button className={tab === 'friends' ? 'active' : ''} onClick={() => setTab('friends')}>
          Friends
        </button>
        <button className={tab === 'profile' ? 'active' : ''} onClick={() => setTab('profile')}>
          Profile
        </button>
      </nav>
    </div>
  );
}