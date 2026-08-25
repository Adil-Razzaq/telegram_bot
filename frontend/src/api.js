const API_BASE = import.meta.env?.VITE_API_BASE || 'http://localhost:4000/api';

function getInitData() {
  return window.Telegram?.WebApp?.initData || '';
}

async function apiCall(path, { method = 'GET', body } = {}) {
  // 1. Cache-busting: Append timestamp to GET requests so Telegram doesn't cache them
  let targetUrl = `${API_BASE}${path}`;
  if (method === 'GET') {
    const separator = targetUrl.includes('?') ? '&' : '?';
    targetUrl = `${targetUrl}${separator}_t=${Date.now()}`;
  }

  const res = await fetch(targetUrl, {
    method,
    cache: 'no-store', // 2. Forces browser/Vercel to ignore local cache and pull live data
    headers: {
      'Content-Type': 'application/json',
      'X-Telegram-Init-Data': getInitData(),
      'Cache-Control': 'no-cache', // 3. Explictly tells proxies/servers not to cache
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
