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
  playSpin: (adToken) => apiCall('/spin/play', { method: 'POST', body: { adToken } }),
  referralStatus: () => apiCall('/referral/status'),
  claimReferral: (adToken) => apiCall('/referral/claim', { method: 'POST', body: { adToken } }),
  registerReferral: (referrerId) =>
    apiCall('/referral/register', { method: 'POST', body: { referrerId } }),
  requestWithdrawal: (address, points) =>
    apiCall('/withdrawal/request', { method: 'POST', body: { address, points } }),
  withdrawalHistory: () => apiCall('/withdrawal/history'),
};
