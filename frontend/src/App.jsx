import { useEffect, useState } from 'react';
import Miner from './components/Miner';
import Tasks from './components/Tasks';
import SpinWheel from './components/SpinWheel';
import Friends from './components/Friends';
import Wallet from './components/Wallet';
import { api } from './api';
import { enableInAppInterstitial } from './monetag';
import { initTonConnectAutoConnect, connectTonWallet, disconnectTonWallet } from './tonConnect';
import './styles/app.css';

export default function App() {
  const [tab, setTab] = useState('miner');
  const [mainBalance, setMainBalance] = useState(0);
  const [balanceLoaded, setBalanceLoaded] = useState(false);
  const [telegramId, setTelegramId] = useState(null);
  const [displayName, setDisplayName] = useState(null);

  // Lifted here (rather than duplicated in Miner + Wallet separately) so
  // both the Mine-tab header and the Profile page always agree on
  // connection state — one TON Connect subscription, one source of
  // truth. "Verified" on Profile and the wallet chip on Mine both read
  // off this same connectedWallet value.
  const [connectedWallet, setConnectedWallet] = useState(null);
  const [walletConnecting, setWalletConnecting] = useState(false);
  const [walletError, setWalletError] = useState(null);

  useEffect(() => {
    const tg = window.Telegram?.WebApp;
    tg?.ready();
    tg?.expand();
    const user = tg?.initDataUnsafe?.user;
    if (user) {
      setTelegramId(user.id);
      const fullName = [user.first_name, user.last_name].filter(Boolean).join(' ');
      setDisplayName(fullName || user.username || 'Player');
    }

    api
      .getMe()
      .then((me) => {
        setMainBalance(me.main_balance ?? 0);
        if (me.wallet_address) setConnectedWallet(me.wallet_address);
      })
      .catch(() => {})
      .finally(() => setBalanceLoaded(true));

    // "Login with the same Tonkeeper": TON Connect restores a prior
    // session automatically. If it restores an address and this account
    // has none linked yet, link it here — this is what makes a
    // returning user's Tonkeeper resolve straight back to their account.
    initTonConnectAutoConnect()
      .then(async (restoredAddress) => {
        if (!restoredAddress) return;
        const me = await api.getMe();
        if (!me.wallet_address) {
          const result = await api.connectWallet(restoredAddress);
          setConnectedWallet(result.wallet_address);
        }
      })
      .catch(() => {});

    enableInAppInterstitial();
  }, []);

  async function handleConnectWallet() {
    setWalletConnecting(true);
    setWalletError(null);
    try {
      const walletAddress = await connectTonWallet();
      const result = await api.connectWallet(walletAddress);
      setConnectedWallet(result.wallet_address);
    } catch (e) {
      setWalletError(e.message);
    } finally {
      setWalletConnecting(false);
    }
  }

  async function handleDisconnectWallet() {
    setWalletError(null);
    try {
      await api.disconnectWallet();
      await disconnectTonWallet();
      setConnectedWallet(null);
    } catch (e) {
      setWalletError(e.message);
    }
  }

  const walletProps = {
    connectedWallet,
    walletConnecting,
    walletError,
    onConnectWallet: handleConnectWallet,
    onDisconnectWallet: handleDisconnectWallet,
  };

  return (
    <div className="app">
      <main className="app-main">
        {tab === 'miner' && (
          <Miner
            displayName={displayName}
            mainBalance={mainBalance}
            onBalanceChange={setMainBalance}
            {...walletProps}
          />
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
            {...walletProps}
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
