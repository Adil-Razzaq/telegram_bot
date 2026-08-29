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
  minerStatus: () => apiCall('/miner/status'),
  minerClaim: () => apiCall('/miner/claim', { method: 'POST' }),
  playSpin: () => apiCall('/spin/play', { method: 'POST' }), // no ad required
  referralStatus: () => apiCall('/referral/status'),
  prepareClaim: () => apiCall('/referral/prepare-claim', { method: 'POST' }),
  claimReferral: (nonce) => apiCall('/referral/claim', { method: 'POST', body: { nonce } }),
  prepareBonusAd: () => apiCall('/bonus-ad/prepare', { method: 'POST' }),
  claimBonusAd: (nonce) => apiCall('/bonus-ad/claim', { method: 'POST', body: { nonce } }),
  requestWithdrawal: (address, points) =>
    apiCall('/withdrawal/request', { method: 'POST', body: { address, points } }),
  withdrawalHistory: () => apiCall('/withdrawal/history'),
};
