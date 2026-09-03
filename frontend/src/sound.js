/**
 * A short, synthesized two-tone "ding" for success notifications (claim
 * toasts, streak progress, etc.) — generated via the Web Audio API
 * rather than an external audio file, so there's nothing to host, no
 * load-time delay, and no broken-link risk if a CDN/asset path changes.
 *
 * Call it from the SAME click-triggered async flow that shows a
 * success toast (see Miner.jsx's showToast, Streak.jsx's claim
 * handler) — browsers require a user gesture to have started the audio
 * flow, and resume() below covers the common case where that gesture's
 * context has technically ended by the time an awaited API call
 * resolves.
 */

let audioCtx = null;

function getContext() {
  if (typeof window === 'undefined') return null;
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return null;
  if (!audioCtx) audioCtx = new AudioContextClass();
  return audioCtx;
}

export function playNotificationSound() {
  // Respects the mute toggle on the Profile tab (Wallet.jsx) — same
  // localStorage key that toggle already reads/writes, so muting there
  // silences every call site of this function with no extra wiring.
  if (typeof localStorage !== 'undefined' && localStorage.getItem('soundOn') === 'false') return;

  const ctx = getContext();
  if (!ctx) return;
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});

  const now = ctx.currentTime;
  [660, 880].forEach((freq, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    const startAt = now + i * 0.09;
    gain.gain.setValueAtTime(0, startAt);
    gain.gain.linearRampToValueAtTime(0.2, startAt + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.001, startAt + 0.25);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(startAt);
    osc.stop(startAt + 0.3);
  });
}
