/**
 * Lightweight notification sound for reward/claim moments (miner claim,
 * streak claim, referral claim, task claim, spin win, daily watch-ad
 * claim). Synthesized with the Web Audio API instead of shipping an
 * mp3 — no extra asset to host, no load-before-play race, and it's
 * always ready by the time a claim resolves.
 *
 * A single shared AudioContext is created lazily on first use (created
 * during a click-driven async flow, which satisfies every browser's
 * autoplay/gesture requirement in practice for Telegram's in-app
 * WebView and normal mobile browsers).
 */

let ctx = null;

function getContext() {
  if (typeof window === 'undefined') return null;
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) return null;
  if (!ctx) ctx = new Ctor();
  return ctx;
}

// A short two-note "ding-dong" style chime — pleasant, quick (~350ms),
// distinct from a plain beep. Used for every successful reward claim.
export function playNotificationSound() {
  try {
    const audioCtx = getContext();
    if (!audioCtx) return;
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});

    const now = audioCtx.currentTime;
    const notes = [
      { freq: 880, start: 0, dur: 0.14 }, // A5
      { freq: 1318.5, start: 0.11, dur: 0.22 }, // E6
    ];

    notes.forEach(({ freq, start, dur }) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;

      const t0 = now + start;
      gain.gain.setValueAtTime(0, t0);
      gain.gain.linearRampToValueAtTime(0.18, t0 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start(t0);
      osc.stop(t0 + dur + 0.02);
    });
  } catch (e) {
    // Never let a sound failure break a reward flow.
  }
}
