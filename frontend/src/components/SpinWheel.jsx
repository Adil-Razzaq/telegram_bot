import { useMemo, useState } from 'react';
import { api } from '../api';
import { showRewardedAd, withConfirmationRetry } from '../monetag';

// Order/colors must match backend SEGMENTS in services/spinService.js —
// palette shifted to the app's gold/emerald theme (was blue/gold).
const SEGMENTS = [
  { index: 1, label: '10', color: '#0d2a20' },
  { index: 2, label: '20', color: '#0f3b2c' },
  { index: 3, label: '50', color: '#124d38' },
  { index: 4, label: '100', color: '#8a6a2a' },
  { index: 5, label: '200', color: '#b5822e' },
  { index: 6, label: '500', color: '#d69e2e' },
];
const SEGMENT_ANGLE = 360 / SEGMENTS.length;
const SIZE = 300;
const CENTER = SIZE / 2;
const RADIUS = CENTER - 6;
const LABEL_RADIUS = RADIUS * 0.62;

function polarPoint(angleDeg, radius) {
  const rad = ((angleDeg - 90) * Math.PI) / 180; // -90 so 0deg points to 12 o'clock
  return { x: CENTER + radius * Math.cos(rad), y: CENTER + radius * Math.sin(rad) };
}

function wedgePath(startAngle, endAngle) {
  const start = polarPoint(startAngle, RADIUS);
  const end = polarPoint(endAngle, RADIUS);
  return `M ${CENTER},${CENTER} L ${start.x},${start.y} A ${RADIUS},${RADIUS} 0 0,1 ${end.x},${end.y} Z`;
}

/**
 * Gates the spin on: getting a nonce from the backend, showing the
 * Monetag ad with that nonce as ymid, then spending the nonce — which
 * only succeeds once Monetag's postback has confirmed it server-side
 * (see backend/utils/monetagAds.js).
 */

export default function SpinWheel({ mainBalance, onBalanceChange }) {
  const [spinning, setSpinning] = useState(false);
  const [rotation, setRotation] = useState(0);
  const [lastResult, setLastResult] = useState(null);
  const [error, setError] = useState(null);

  const canAfford = mainBalance >= 100;

  const wedges = useMemo(
    () =>
      SEGMENTS.map((seg, i) => {
        const start = i * SEGMENT_ANGLE;
        const end = start + SEGMENT_ANGLE;
        const mid = start + SEGMENT_ANGLE / 2;
        const labelPos = polarPoint(mid, LABEL_RADIUS);
        return { ...seg, path: wedgePath(start, end), labelPos, mid };
      }),
    []
  );

  async function handleSpin() {
    if (spinning || !canAfford) return;
    setError(null);
    setSpinning(true);
    try {
      const { nonce } = await api.prepareSpin();
      await showRewardedAd(nonce);
      const result = await withConfirmationRetry(() => api.playSpin(nonce));

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
      <h2 className="page-title">Spin</h2>
      <p className="page-subtitle">Watch a short ad, spin the wheel, win ADLX</p>

      <div className="spin-wheel-frame">
        <div className="spin-wheel-wrap">
          <div className="spin-wheel-pointer" />
          <svg
            className="spin-wheel-svg"
            viewBox={`0 0 ${SIZE} ${SIZE}`}
            style={{
              transform: `rotate(${rotation}deg)`,
              transition: spinning ? 'transform 4s cubic-bezier(0.17, 0.67, 0.3, 1)' : 'none',
            }}
          >
            {wedges.map((w) => (
              <g key={w.index}>
                <path d={w.path} fill={w.color} stroke="#051424" strokeWidth="2" />
                <text
                  x={w.labelPos.x}
                  y={w.labelPos.y}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  transform={`rotate(${w.mid}, ${w.labelPos.x}, ${w.labelPos.y})`}
                  fontFamily="'JetBrains Mono', monospace"
                  fontWeight="600"
                  fontSize={w.label.length > 2 ? 22 : 26}
                  fill={w.index >= 4 ? '#1a1300' : '#d4e4fa'}
                >
                  {w.label}
                </text>
              </g>
            ))}
            <circle cx={CENTER} cy={CENTER} r={22} className="spin-wheel-hub" />
          </svg>
        </div>
      </div>

      <button className="gold-button spin-button" onClick={handleSpin} disabled={spinning || !canAfford}>
        {spinning ? 'Spinning…' : canAfford ? 'Watch ad & Spin (100 ADLX)' : 'Not enough ADLX'}
      </button>

      {lastResult && !spinning && (
        <p className="spin-result">
          {lastResult.points_won > 0
            ? `You won ${lastResult.points_won} ADLX!`
            : 'No win this time — try again.'}
        </p>
      )}
      {error && <p className="spin-error">{error}</p>}
    </div>
  );
}
