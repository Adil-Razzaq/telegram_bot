const API_BASE = import.meta.env?.VITE_API_BASE || 'http://localhost:4000/api';

function getInitData() {
  return window.Telegram?.WebApp?.initData || '';
}

async function apiCall(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Telegram-Init-Data': getInitData(),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  let data;
  try {
    data = await res.json();
  } catch (e) {
    throw new Error('Server returned an unreadable response');
  }
  if (!res.ok || data.ok === false) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

export const api = {
  getMe: () => apiCall('/user/me'),
  getConfig: () => apiCall('/user/config'),
  minerStatus: () => apiCall('/miner/status'),
  prepareMinerStart: () => apiCall('/miner/prepare-start', { method: 'POST' }),
  startMiner: (nonce) => apiCall('/miner/start', { method: 'POST', body: { nonce } }),
  prepareMinerClaim: () => apiCall('/miner/prepare-claim', { method: 'POST' }),
  minerClaim: (nonce) => apiCall('/miner/claim', { method: 'POST', body: { nonce } }),
  taskList: () => apiCall('/tasks/list'),
  claimTask: (taskId) => apiCall('/tasks/claim', { method: 'POST', body: { task_id: taskId } }),
  prepareAdTask: (taskId) => apiCall('/tasks/prepare-ad', { method: 'POST', body: { task_id: taskId } }),
  claimAdTask: (taskId, nonce) => apiCall('/tasks/claim-ad', { method: 'POST', body: { task_id: taskId, nonce } }),
  connectWallet: (address) => apiCall('/wallet/connect', { method: 'POST', body: { address } }),
  disconnectWallet: () => apiCall('/wallet/disconnect', { method: 'POST' }),
  spinConfig: () => apiCall('/spin/config'),
  prepareSpin: () => apiCall('/spin/prepare', { method: 'POST' }),
  playSpin: (nonce) => apiCall('/spin/play', { method: 'POST', body: { nonce } }),
  referralStatus: () => apiCall('/referral/status'),
  referralInvited: () => apiCall('/referral/invited'),
  registerReferral: (referrerId) =>
    apiCall('/referral/register', { method: 'POST', body: { referrer_id: referrerId } }),
  prepareClaim: () => apiCall('/referral/prepare-claim', { method: 'POST' }),
  claimReferral: (nonce) => apiCall('/referral/claim', { method: 'POST', body: { nonce } }),
  requestWithdrawal: (address, points) =>
    apiCall('/withdrawal/request', { method: 'POST', body: { address, points } }),
  withdrawalHistory: () => apiCall('/withdrawal/history'),
  adWatchStatus: () => apiCall('/tasks/ad-watch/status'),
  prepareAdWatch: (network) => apiCall('/tasks/ad-watch/prepare', { method: 'POST', body: { network } }),
  claimAdWatch: (network, nonce) => apiCall('/tasks/ad-watch/claim', { method: 'POST', body: { network, nonce } }),
};
