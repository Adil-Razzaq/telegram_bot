import { EthereumProvider } from '@walletconnect/ethereum-provider';

const PROJECT_ID = import.meta.env?.VITE_WALLETCONNECT_PROJECT_ID;
const BSC_CHAIN_ID = 56; // BNB Smart Chain mainnet — matches the BEP-20/USDT flow the rest of this app uses

let providerPromise = null;

function getProvider() {
  if (!PROJECT_ID) {
    return Promise.reject(
      new Error('VITE_WALLETCONNECT_PROJECT_ID is not set — add it in your frontend env vars')
    );
  }
  if (!providerPromise) {
    providerPromise = EthereumProvider.init({
      projectId: PROJECT_ID,
      chains: [BSC_CHAIN_ID],
      optionalChains: [BSC_CHAIN_ID],
      showQrModal: true,
      metadata: {
        // TODO: update name/description/url to match your actual app —
        // this is what shows in the user's wallet app when they approve
        // the connection.
        name: 'Spin & Earn',
        description: 'Telegram Mini App',
        url: window.location.origin,
        icons: [],
      },
    });
  }
  return providerPromise;
}

/**
 * Opens WalletConnect's connect flow (QR code on desktop, deep-link
 * chooser on mobile — should offer Binance Wallet, Trust Wallet,
 * MetaMask, etc., automatically based on what's installed). Resolves
 * with the connected address once the user approves in their wallet app.
 *
 * NOTE: this runs inside Telegram's in-app browser, which is a less
 * common environment for WalletConnect than a normal mobile browser —
 * the deep-link handoff to another app may behave differently here.
 * This needs a real test on an actual phone with a real wallet app
 * before trusting it in production; I can't verify that from here.
 */
export async function connectWalletConnect() {
  const provider = await getProvider();
  await provider.connect();
  const accounts = provider.accounts;
  if (!accounts || accounts.length === 0) {
    throw new Error('No account returned — connection may have been cancelled');
  }
  return accounts[0];
}

export async function disconnectWalletConnectSession() {
  try {
    const provider = await getProvider();
    await provider.disconnect();
  } catch (e) {
    // Already disconnected or never connected this session — fine to ignore.
  }
}
