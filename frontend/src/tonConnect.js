import { TonConnectUI } from '@tonconnect/ui';

/**
 * TON Connect (the official Telegram-endorsed wallet protocol — Tonkeeper,
 * MyTonWallet, etc. all implement it) instead of the old WalletConnect/BSC
 * flow. This is what makes "auto connect" and "login with the same
 * Tonkeeper" actually work as one mechanism:
 *
 *   - TonConnectUI persists its session in localStorage on its own and
 *     restores it automatically on page load (connectionRestored below) —
 *     that's the "auto connect" behavior: a returning user doesn't have
 *     to tap Connect again, their wallet is already known.
 *   - onStatusChange fires with the SAME address every time that same
 *     Tonkeeper reconnects — that's what "login with the same TON
 *     Keeper" means in practice: the backend's one-wallet-per-account
 *     rule (walletService.js) is what turns "same wallet reconnected"
 *     into "same account recognized", not anything TON Connect itself
 *     does — TON Connect only proves which wallet is talking to you.
 *
 * REQUIRES a tonconnect-manifest.json hosted at a public HTTPS URL (see
 * frontend/public/tonconnect-manifest.json) — this is a hard requirement
 * of the TON Connect spec, not optional. It must be reachable at
 * https://YOUR_DOMAIN/tonconnect-manifest.json in production.
 */

let tonConnectUI = null;

function getTonConnectUI() {
  if (!tonConnectUI) {
    tonConnectUI = new TonConnectUI({
      manifestUrl: `${window.location.origin}/tonconnect-manifest.json`,
    });
  }
  return tonConnectUI;
}

/**
 * Call once on app load. Resolves with the already-connected address if
 * TON Connect restored a session from a previous visit, or null if the
 * user has never connected (or explicitly disconnected) before.
 */
export function initTonConnectAutoConnect() {
  const ui = getTonConnectUI();
  return new Promise((resolve) => {
    // onStatusChange fires once immediately with the current state
    // (including the auto-restored session, if any), then again on any
    // future connect/disconnect — this single subscription covers both
    // "auto connect on load" and "user connects later in this session".
    const unsubscribe = ui.onStatusChange((wallet) => {
      resolve(wallet ? wallet.account.address : null);
    });
    // Safety timeout: if TON Connect's restore genuinely has nothing to
    // report (fresh visitor, no prior session), don't hang the caller
    // forever waiting for a status change that isn't coming.
    setTimeout(() => resolve(null), 2000);
    return unsubscribe;
  });
}

/**
 * Opens Tonkeeper's connect flow (QR on desktop, deep-link on mobile —
 * TON Connect's modal lists Tonkeeper and other TON wallets
 * automatically). Resolves with the connected address.
 */
export function connectTonWallet() {
  const ui = getTonConnectUI();
  return new Promise((resolve, reject) => {
    const unsubscribe = ui.onStatusChange((wallet) => {
      if (wallet) {
        unsubscribe();
        resolve(wallet.account.address);
      }
    });
    ui.openModal();
    // If the user closes the modal without connecting, onStatusChange
    // never fires — this timeout is what stops the caller's UI from
    // spinning forever in that case.
    setTimeout(() => {
      if (!ui.connected) {
        unsubscribe();
        reject(new Error('Connection cancelled'));
      }
    }, 60000);
  });
}

export async function disconnectTonWallet() {
  const ui = getTonConnectUI();
  if (ui.connected) await ui.disconnect();
}

export function getConnectedTonAddress() {
  const ui = getTonConnectUI();
  return ui.connected ? ui.account.address : null;
}
