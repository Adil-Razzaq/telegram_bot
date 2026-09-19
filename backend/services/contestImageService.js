const { createCanvas } = require('@napi-rs/canvas');
const { getAllBotContent } = require('../utils/botContent');

// --- Contest results image ---
// Renders a shareable, portrait (1080x1580 — a common social-feed
// aspect ratio) PNG announcing a finished round's top 3, meant to be
// DMed to the winners themselves (so THEY post/share it — that's the
// actual viral loop, not the app pushing it) and kept in the admin
// panel for the admin's own public posting.
//
// Every visual element (trophy, medals, sparkles, frame, button) is
// drawn from plain canvas shapes — never emoji glyphs. Server-side
// canvas libraries only render emoji correctly if a color-emoji font
// happens to be installed on that exact machine — most production
// servers don't have one, and it silently renders as an empty box (☐)
// instead of failing loudly, which would ship broken-looking images
// with no warning. Plain shapes need zero fonts and render identically
// everywhere.

const WIDTH = 1080;
const HEIGHT = 1580;

const MEDAL_COLORS = {
  1: { light: '#fef3c7', mid: '#fbbf24', dark: '#d97706', glow: 'rgba(251, 191, 36, 0.55)', label: '1ST PLACE' },
  2: { light: '#f3f4f6', mid: '#cbd5e1', dark: '#64748b', glow: 'rgba(203, 213, 225, 0.45)', label: '2ND PLACE' },
  3: { light: '#fde3c0', mid: '#e2985e', dark: '#a5591f', glow: 'rgba(226, 152, 94, 0.45)', label: '3RD PLACE' },
};

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

function drawSparkle(ctx, x, y, size, color, rotation = 0) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rotation);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(0, -size);
  ctx.quadraticCurveTo(size * 0.15, -size * 0.15, size, 0);
  ctx.quadraticCurveTo(size * 0.15, size * 0.15, 0, size);
  ctx.quadraticCurveTo(-size * 0.15, size * 0.15, -size, 0);
  ctx.quadraticCurveTo(-size * 0.15, -size * 0.15, 0, -size);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawBackground(ctx) {
  const bgGrad = ctx.createLinearGradient(0, 0, 0, HEIGHT);
  bgGrad.addColorStop(0, '#0d2d4a');
  bgGrad.addColorStop(0.45, '#082038');
  bgGrad.addColorStop(1, '#040f1c');
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  // Diagonal light rays behind the trophy — a cheap way to get a
  // "celebratory spotlight" feel with zero image assets.
  ctx.save();
  ctx.globalAlpha = 0.08;
  ctx.translate(WIDTH / 2, 260);
  for (let i = 0; i < 10; i++) {
    ctx.rotate((Math.PI * 2) / 10);
    ctx.fillStyle = '#facc15';
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, 700, -0.04, 0.04);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();

  // Faint dot-grid texture so large flat areas don't look empty.
  ctx.fillStyle = 'rgba(255,255,255,0.035)';
  for (let gy = 40; gy < HEIGHT; gy += 44) {
    for (let gx = 40; gx < WIDTH; gx += 44) {
      ctx.beginPath();
      ctx.arc(gx, gy, 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  const glow = ctx.createRadialGradient(WIDTH / 2, 250, 20, WIDTH / 2, 250, 520);
  glow.addColorStop(0, 'rgba(250, 204, 21, 0.22)');
  glow.addColorStop(1, 'rgba(250, 204, 21, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, WIDTH, 760);

  const vig = ctx.createRadialGradient(WIDTH / 2, HEIGHT / 2, HEIGHT * 0.35, WIDTH / 2, HEIGHT / 2, HEIGHT * 0.75);
  vig.addColorStop(0, 'rgba(0,0,0,0)');
  vig.addColorStop(1, 'rgba(0,0,0,0.35)');
  ctx.fillStyle = vig;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
}

// Decorative double-line border — gives the whole graphic an
// "award/certificate" feel instead of looking like a plain screenshot.
function drawFrame(ctx) {
  ctx.strokeStyle = 'rgba(250, 204, 21, 0.5)';
  ctx.lineWidth = 3;
  roundRect(ctx, 24, 24, WIDTH - 48, HEIGHT - 48, 28);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(250, 204, 21, 0.18)';
  ctx.lineWidth = 1;
  roundRect(ctx, 34, 34, WIDTH - 68, HEIGHT - 68, 22);
  ctx.stroke();
}

// A hand-drawn trophy silhouette (cup + handles + stem + base), all
// path shapes filled with a gold gradient plus a soft glow — this is
// the image's main focal illustration, doing the job a photo or emoji
// normally would.
function drawTrophy(ctx, cx, cy, scale) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(scale, scale);
  ctx.shadowColor = 'rgba(250, 204, 21, 0.65)';
  ctx.shadowBlur = 45;

  const cupGrad = ctx.createLinearGradient(-70, -90, 70, 20);
  cupGrad.addColorStop(0, '#fff4c2');
  cupGrad.addColorStop(0.5, '#fbbf24');
  cupGrad.addColorStop(1, '#b45309');

  ctx.beginPath();
  ctx.moveTo(-62, -90);
  ctx.lineTo(62, -90);
  ctx.quadraticCurveTo(62, -10, 0, 10);
  ctx.quadraticCurveTo(-62, -10, -62, -90);
  ctx.closePath();
  ctx.fillStyle = cupGrad;
  ctx.fill();

  ctx.lineWidth = 14;
  ctx.strokeStyle = cupGrad;
  ctx.shadowBlur = 20;
  ctx.beginPath();
  ctx.arc(-80, -60, 26, -1.9, 1.3);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(80, -60, 26, Math.PI - 1.3, Math.PI + 1.9);
  ctx.stroke();

  ctx.shadowBlur = 0;
  ctx.fillStyle = cupGrad;
  ctx.fillRect(-10, 10, 20, 34);
  roundRect(ctx, -48, 44, 96, 16, 6);
  ctx.fill();
  roundRect(ctx, -62, 60, 124, 16, 6);
  ctx.fill();
  ctx.restore();

  drawSparkle(ctx, cx - 150, cy - 100, 16, '#facc15', 0.3);
  drawSparkle(ctx, cx + 165, cy - 60, 12, '#fde68a', -0.4);
  drawSparkle(ctx, cx + 120, cy + 110, 10, '#facc15', 0.6);
  drawSparkle(ctx, cx - 130, cy + 90, 13, '#fde68a', -0.2);
}

// Shrinks the font until the text fits maxWidth, so an unusually long
// username never overflows its card. Never goes below 24px — at that
// point it truncates with an ellipsis instead of shrinking further.
function fitText(ctx, text, maxWidth, startSize, fontWeight = '700') {
  let size = startSize;
  while (size > 24) {
    ctx.font = `${fontWeight} ${size}px sans-serif`;
    if (ctx.measureText(text).width <= maxWidth) return text;
    size -= 2;
  }
  ctx.font = `${fontWeight} 24px sans-serif`;
  let truncated = text;
  while (truncated.length > 1 && ctx.measureText(truncated + '…').width > maxWidth) {
    truncated = truncated.slice(0, -1);
  }
  return truncated.length < text.length ? truncated + '…' : truncated;
}

// A glowing gradient circle with the rank number, plus two small
// ribbon tails beneath it — reads as an actual award medal rather
// than a plain numbered badge.
function drawMedalBadge(ctx, cx, cy, radius, rank) {
  const c = MEDAL_COLORS[rank];
  ctx.save();
  ctx.shadowColor = c.glow;
  ctx.shadowBlur = 28;
  const grad = ctx.createLinearGradient(cx - radius, cy - radius, cx + radius, cy + radius);
  grad.addColorStop(0, c.light);
  grad.addColorStop(0.55, c.mid);
  grad.addColorStop(1, c.dark);
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.restore();

  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(255,255,255,0.5)';
  ctx.beginPath();
  ctx.arc(cx, cy, radius - 2, 0, Math.PI * 2);
  ctx.stroke();

  ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
  ctx.font = `800 ${Math.round(radius * 0.72)}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(rank), cx, cy + radius * 0.06);

  ctx.fillStyle = c.dark;
  ctx.beginPath();
  ctx.moveTo(cx - 26, cy + radius - 6);
  ctx.lineTo(cx - 8, cy + radius - 6);
  ctx.lineTo(cx - 16, cy + radius + 34);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(cx + 26, cy + radius - 6);
  ctx.lineTo(cx + 8, cy + radius - 6);
  ctx.lineTo(cx + 16, cy + radius + 34);
  ctx.closePath();
  ctx.fill();
}

async function generateResultsImage(contest) {
  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext('2d');

  drawBackground(ctx);
  drawFrame(ctx);
  drawTrophy(ctx, WIDTH / 2, 230, 1.15);

  ctx.textAlign = 'center';
  ctx.fillStyle = '#facc15';
  ctx.font = '700 30px sans-serif';
  ctx.fillText('A D L X', WIDTH / 2, 400);

  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.6)';
  ctx.shadowBlur = 12;
  ctx.fillStyle = '#ffffff';
  ctx.font = '800 60px sans-serif';
  ctx.fillText('ACTIVE REFERRAL CONTEST', WIDTH / 2, 460);
  ctx.restore();

  ctx.fillStyle = '#facc15';
  ctx.font = '600 34px sans-serif';
  ctx.fillText('ROUND RESULTS', WIDTH / 2, 505);

  const dateFmt = (d) => new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  ctx.fillStyle = '#8a9bb0';
  ctx.font = '400 26px sans-serif';
  ctx.fillText(`${dateFmt(contest.starts_at)} — ${dateFmt(contest.ends_at)}`, WIDTH / 2, 545);

  const results = contest.results || [];
  const cardX = 70;
  const cardW = WIDTH - 140;
  const cardH = 220;
  const cardGap = 30;
  let y = 590;

  for (const rank of [1, 2, 3]) {
    const row = results.find((r) => r.rank === rank);
    const c = MEDAL_COLORS[rank];
    const qualifies = row && row.prize_awarded > 0;

    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.35)';
    ctx.shadowBlur = 20;
    ctx.shadowOffsetY = 8;
    roundRect(ctx, cardX, y, cardW, cardH, 22);
    const cardGrad = ctx.createLinearGradient(cardX, y, cardX + cardW, y + cardH);
    if (qualifies) {
      cardGrad.addColorStop(0, 'rgba(255,255,255,0.09)');
      cardGrad.addColorStop(1, 'rgba(255,255,255,0.03)');
    } else {
      cardGrad.addColorStop(0, 'rgba(255,255,255,0.03)');
      cardGrad.addColorStop(1, 'rgba(255,255,255,0.01)');
    }
    ctx.fillStyle = cardGrad;
    ctx.fill();
    ctx.restore();

    ctx.lineWidth = 2;
    ctx.strokeStyle = qualifies ? c.glow : 'rgba(255, 255, 255, 0.08)';
    roundRect(ctx, cardX, y, cardW, cardH, 22);
    ctx.stroke();

    const medalCx = cardX + 130;
    const medalCy = y + cardH / 2 - 10;
    drawMedalBadge(ctx, medalCx, medalCy, 66, rank);

    const textX = cardX + 250;
    const maxNameWidth = cardW - 250 - 40;

    ctx.textAlign = 'left';
    ctx.fillStyle = c.mid;
    ctx.font = '700 22px sans-serif';
    ctx.fillText(c.label, textX, y + 55);

    if (qualifies) {
      ctx.fillStyle = '#ffffff';
      const name = fitText(ctx, row.display_name, maxNameWidth, 42, '700');
      ctx.fillText(name, textX, y + 100);

      ctx.fillStyle = '#8a9bb0';
      ctx.font = '400 26px sans-serif';
      ctx.fillText(`${row.active_referrals} active referrals`, textX, y + 140);

      ctx.fillStyle = c.mid;
      ctx.font = '800 50px sans-serif';
      ctx.fillText(`+${row.prize_awarded} ADLX`, textX, y + 195);
    } else {
      ctx.fillStyle = '#8a9bb0';
      ctx.font = '500 28px sans-serif';
      ctx.fillText('No qualifying winner this round', textX, y + 110);
    }

    y += cardH + cardGap;
  }

  // --- Footer CTA button ---
  const btnW = 480;
  const btnH = 84;
  const btnX = (WIDTH - btnW) / 2;
  const btnY = y + 20;
  ctx.save();
  ctx.shadowColor = 'rgba(250, 204, 21, 0.5)';
  ctx.shadowBlur = 30;
  const btnGrad = ctx.createLinearGradient(btnX, btnY, btnX, btnY + btnH);
  btnGrad.addColorStop(0, '#fde68a');
  btnGrad.addColorStop(1, '#f59e0b');
  roundRect(ctx, btnX, btnY, btnW, btnH, btnH / 2);
  ctx.fillStyle = btnGrad;
  ctx.fill();
  ctx.restore();

  ctx.fillStyle = '#1a1200';
  ctx.font = '800 32px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('JOIN THE NEXT ROUND', WIDTH / 2, btnY + btnH / 2 + 11);

  let cta = '';
  try {
    const content = await getAllBotContent();
    cta = (content.official_button_url || '').replace(/^https?:\/\//, '');
  } catch {
    // Falls through to just leaving the CTA line off — the rest of
    // the image is still valid and shareable without it.
  }
  if (cta) {
    ctx.fillStyle = '#8a9bb0';
    ctx.font = '500 26px sans-serif';
    ctx.fillText(cta, WIDTH / 2, btnY + btnH + 46);
  }

  return canvas.toBuffer('image/png');
}

module.exports = { generateResultsImage };
