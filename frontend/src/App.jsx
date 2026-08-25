import { useEffect, useState } from 'react';
import SpinWheel from './components/SpinWheel';
import ReferralDashboard from './components/ReferralDashboard';
import Wallet from './components/Wallet';
import './styles/app.css';

export default function App() {
  const [tab, setTab] = useState('spin');
  const [mainBalance, setMainBalance] = useState(0);
  const [telegramId, setTelegramId] = useState(null);

  useEffect(() => {
    const tg = window.Telegram?.WebApp;
    tg?.ready();
    tg?.expand();
    const user = tg?.initDataUnsafe?.user;
    if (user) setTelegramId(user.id);
  }, []);

  return (
    <div className="app">
      <header className="app-header">
        <span className="balance-pill">{mainBalance} pts</span>
      </header>

      <main className="app-main">
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
