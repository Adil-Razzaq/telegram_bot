import { useEffect, useState } from 'react';
import Miner from './components/Miner';
import Tasks from './components/Tasks';
import SpinWheel from './components/SpinWheel';
import Friends from './components/Friends';
import Wallet from './components/Wallet';
import AutoAds from './components/AutoAds';
import Streak from './components/Streak';
import Leaderboard from './components/Leaderboard';
import { api } from './api';
import { initMonetag } from './monetag';
import { initTonConnectAutoConnect, connectTonWallet, disconnectTonWallet } from './tonConnect';
import './styles/app.css';

export default function App() {
  const [tab, setTab] = useState('miner');
  const [mainBalance, setMainBalance] = useState(0);
  const [balanceLoaded, setBalanceLoaded] = useState(false);
  const [telegramId, setTelegramId] = useState(null);
  const [displayName, setDisplayName] = useState(null);
  // Full /user/config payload — settings (ad zones/timing/limits) plus
  // the withdrawals and spin_enabled feature flags. AutoAds and the
  // Spin nav tab both read straight off this rather than duplicating
  // their own fetches.
  const [config, setConfig] = useState(null);

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

    // Second, independent path for crediting referrals — doesn't depend
    // on the bot's webhook at all (see routes/bot.js for the other
    // path). Telegram hands us this directly when the app is opened via
    // a `?startapp=ref_123` link (see Friends.jsx), even if the user
    // never triggers an actual /start message in the bot chat. Safe to
    // call unconditionally on every load — the backend treats "already
    // referred" as a harmless no-op, not an error.
    const startParam = tg?.initDataUnsafe?.start_param;
    const refMatch = startParam && startParam.match(/^ref_(\d+)$/);
    if (refMatch) {
      api.registerReferral(Number(refMatch[1])).catch(() => {});
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

    api
      .getConfig()
      .then((cfg) => {
        setConfig(cfg);
        // Rewarded ads (spin/miner/referral/tasks + the Monetag daily
        // watch-ad slot) always need Monetag loaded, regardless of which
        // network the passive auto-ad is set to — so this always runs,
        // not just when auto_ad_network === 'monetag'.
        initMonetag(cfg.monetag_zone_id).catch((e) => console.error(e.message));
        // If the admin turned Spin off while a user already had that
        // tab open, don't strand them on a tab that's about to vanish.
        if (!cfg.spin_enabled) setTab((t) => (t === 'spin' ? 'miner' : t));
      })
      .catch(() => {});
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
      <AutoAds config={config} />
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
        {tab === 'streak' && <Streak onBalanceChange={setMainBalance} />}
        {tab === 'leaderboard' && <Leaderboard />}
        {tab === 'spin' && config?.spin_enabled !== false && (
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
          <span className="material-symbols-outlined">bolt</span>
          Mine
        </button>
        <button className={tab === 'tasks' ? 'active' : ''} onClick={() => setTab('tasks')}>
          <span className="material-symbols-outlined">assignment</span>
          Tasks
        </button>
        <button className={tab === 'streak' ? 'active' : ''} onClick={() => setTab('streak')}>
          <span className="material-symbols-outlined">local_fire_department</span>
          Streak
        </button>
        <button className={tab === 'leaderboard' ? 'active' : ''} onClick={() => setTab('leaderboard')}>
          <span className="material-symbols-outlined">leaderboard</span>
          Ranks
        </button>
        {config?.spin_enabled !== false && (
          <button className={tab === 'spin' ? 'active' : ''} onClick={() => setTab('spin')}>
            <span className="material-symbols-outlined">casino</span>
            Spin
          </button>
        )}
        <button className={tab === 'friends' ? 'active' : ''} onClick={() => setTab('friends')}>
          <span className="material-symbols-outlined">group</span>
          Friends
        </button>
        <button className={tab === 'profile' ? 'active' : ''} onClick={() => setTab('profile')}>
          <span className="material-symbols-outlined">person</span>
          Profile
        </button>
      </nav>
    </div>
  );
}
