import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { withConfirmationRetry } from '../monetag';
import { showActionAd } from '../adNetwork';
import { playNotificationSound } from '../sound';

// Colors/positions stay client-side (purely visual) — alternating
// teal/gold so the wheel reads as one cohesive design instead of a
// half-and-half split. The actual payout NUMBERS come from the backend
// (see api.spinConfig()) so an admin editing them in the settings panel
// is reflected here without a frontend redeploy.
const SEGMENT_COLORS = ['#0f3b2c', '#b5822e', '#146b4a', '#d69e2e', '#1a8f63', '#f0b955'];
const SEGMENT_ANGLE = 360 / SEGMENT_COLORS.length;
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

export default function SpinWheel({ mainBalance, onBalanceChange }) {
  const [config, setConfig] = useState(null);
  // Separate from `config` above (that's spin-specific: payouts, entry
  // fee, free spins) — this is the global /user/config, used only for
  // action_ads_network / adsgram_block_id here.
  const [adConfig, setAdConfig] = useState(null);
  const [spinning, setSpinning] = useState(false);
  const [rotation, setRotation] = useState(0);
  const [lastResult, setLastResult] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api
      .spinConfig()
      .then(setConfig)
      .catch((e) => setError(e.message));
    api.getConfig().then(setAdConfig).catch(() => {});
  }, []);

  const segments = useMemo(() => {
    if (!config) return [];
    return config.payouts.map((p, i) => ({
      index: p.index,
      label: String(p.payout),
      color: SEGMENT_COLORS[i],
    }));
  }, [config]);

  const wedges = useMemo(() => {
    if (segments.length === 0) return [];
    return segments.map((seg, i) => {
      const start = i * SEGMENT_ANGLE;
      const end = start + SEGMENT_ANGLE;
      const mid = start + SEGMENT_ANGLE / 2;
      const labelPos = polarPoint(mid, LABEL_RADIUS);
      return { ...seg, path: wedgePath(start, end), labelPos, mid };
    });
  }, [segments]);

  const isFreeSpin = (config?.free_spins_remaining ?? 0) > 0;
  const entryFee = config?.entry_fee ?? 100;
  const canAfford = isFreeSpin || mainBalance >= entryFee;

  async function handleSpin() {
    if (spinning || !canAfford || !config) return;
    setError(null);
    setSpinning(true);
    try {
      const { nonce } = await api.prepareSpin();
      await showActionAd(nonce, adConfig);
      const result = await withConfirmationRetry(() => api.playSpin(nonce));

      const targetIndex = segments.findIndex((s) => s.index === result.segment_index);
      const segmentCenter = targetIndex * SEGMENT_ANGLE + SEGMENT_ANGLE / 2;
      const fullSpins = 5 * 360;
      const nextRotation = rotation + fullSpins + (360 - segmentCenter);
      setRotation(nextRotation);

      setTimeout(() => {
        setLastResult(result);
        onBalanceChange(result.main_balance);
        if (result.points_won > 0) playNotificationSound();
        setConfig((prev) => (prev ? { ...prev, free_spins_remaining: result.free_spins_remaining } : prev));
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
      <p className="page-subtitle">Spin the wheel and win ADLX — or watch a short ad for a free spin</p>

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
            {wedges.map((w, i) => (
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
                  fill={i % 2 === 1 ? '#1a1300' : '#d4e4fa'}
                >
                  {w.label}
                </text>
              </g>
            ))}
            <circle cx={CENTER} cy={CENTER} r={22} className="spin-wheel-hub" />
          </svg>
        </div>
      </div>

      {isFreeSpin && <p className="spin-free-badge">🎁 Free spin — {config.free_spins_remaining} left</p>}

      <button className="gold-button spin-button" onClick={handleSpin} disabled={spinning || !canAfford || !config}>
        {spinning
          ? 'Spinning…'
          : !config
          ? 'Loading…'
          : isFreeSpin
          ? 'Watch ad & Spin (Free)'
          : canAfford
          ? `Spin (${entryFee} ADLX)`
          : 'Not enough ADLX'}
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
