import { useMemo, useState } from 'react';
import { api } from '../api';

// Order/colors must match backend SEGMENTS in services/spinService.js
const SEGMENTS = [
  { index: 1, label: '0', color: '#2b2f3a' },
  { index: 2, label: '25', color: '#3a6df0' },
  { index: 3, label: '50', color: '#22a26b' },
  { index: 4, label: '100', color: '#e0a72e' },
  { index: 5, label: '200', color: '#c8542f' },
  { index: 6, label: '1000', color: '#b03bd6' },
];
const SEGMENT_ANGLE = 360 / SEGMENTS.length;

/**
 * NOTE on adToken: this assumes your Adsgram integration returns something
 * the backend can verify (see backend/utils/adsgram.js — confirm the exact
 * shape against Adsgram's current publisher docs before shipping; this
 * component treats it as an opaque string so swapping strategies later
 * only touches showRewardedAd()).
 */
async function showRewardedAd() {
  if (!window.Adsgram) {
    throw new Error('Adsgram SDK not loaded');
  }
  const AdController = window.Adsgram.init({ blockId: import.meta.env?.VITE_ADSGRAM_BLOCK_ID });
  const result = await AdController.show(); // resolves on completed view, rejects on skip/error
  return result?.token || result?.rewardToken || null;
}

export default function SpinWheel({ mainBalance, onBalanceChange }) {
  const [spinning, setSpinning] = useState(false);
  const [rotation, setRotation] = useState(0);
  const [lastResult, setLastResult] = useState(null);
  const [error, setError] = useState(null);

  const canAfford = mainBalance >= 100;

  const wedgeStyle = useMemo(() => {
    const gradientStops = SEGMENTS.map((seg, i) => {
      const start = i * SEGMENT_ANGLE;
      const end = start + SEGMENT_ANGLE;
      return `${seg.color} ${start}deg ${end}deg`;
    }).join(', ');
    return { background: `conic-gradient(${gradientStops})` };
  }, []);

  async function handleSpin() {
    if (spinning || !canAfford) return;
    setError(null);
    setSpinning(true);
    try {
      const adToken = await showRewardedAd();
      const result = await api.playSpin(adToken);

      // Visual spin: land the pointer on the winning segment, with extra
      // full rotations for effect.
      const targetSegment = SEGMENTS.find((s) => s.index === result.segment_index);
      const targetIndex = SEGMENTS.indexOf(targetSegment);
      const segmentCenter = targetIndex * SEGMENT_ANGLE + SEGMENT_ANGLE / 2;
      const fullSpins = 5 * 360;
      const nextRotation = rotation + fullSpins + (360 - segmentCenter);
      setRotation(nextRotation);

      setTimeout(() => {
        setLastResult(result);
        onBalanceChange(result.main_balance);
        setSpinning(false);
      }, 4000);
    } catch (e) {
      setError(e.message);
      setSpinning(false);
    }
  }

  return (
    <div className="spin-wheel-container">
      <div className="spin-wheel-wrap">
        <div className="spin-wheel-pointer" />
        <div
          className="spin-wheel"
          style={{
            ...wedgeStyle,
            transform: `rotate(${rotation}deg)`,
            transition: spinning ? 'transform 4s cubic-bezier(0.17, 0.67, 0.3, 1)' : 'none',
          }}
        >
          {SEGMENTS.map((seg, i) => (
            <span
              key={seg.index}
              className="spin-wheel-label"
              style={{ transform: `rotate(${i * SEGMENT_ANGLE + SEGMENT_ANGLE / 2}deg)` }}
            >
              {seg.label}
            </span>
          ))}
        </div>
      </div>

      <button className="spin-button" onClick={handleSpin} disabled={spinning || !canAfford}>
        {spinning ? 'Spinning…' : canAfford ? 'Watch ad & Spin (100 pts)' : 'Not enough points'}
      </button>

      {lastResult && !spinning && (
        <p className="spin-result">
          {lastResult.points_won > 0
            ? `You won ${lastResult.points_won} points!`
            : 'No win this time — try again.'}
        </p>
      )}
      {error && <p className="spin-error">{error}</p>}
    </div>
  );
}
