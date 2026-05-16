/**
 * H65 — analog fuel gauge.
 *
 * Sits to the left of the H64 speedometer. Half-circle dial with
 * E (empty, red) and F (full, green) labels, needle pointing at the
 * current fuel level. Companion to the speedometer so the bottom-
 * right of the HUD reads as a real instrument cluster.
 *
 * Keeps the H13 horizontal bar at the top-left untouched — that one
 * surfaces status text ("OUT OF FUEL", "REFUELING — Mobil"), which
 * the analog dial doesn't have room for.
 */

const DIAL_R = 28;
/** Half-circle sweep from -180° (left = empty) to 0° (right = full). */
const NEEDLE_MIN_DEG = -180;
const NEEDLE_MAX_DEG = 0;

/** Paint a small analog fuel gauge. fuel is 0..1. */
export function drawFuelGauge(
  ctx: CanvasRenderingContext2D,
  hudW: number,
  hudH: number,
  fuel: number,
): void {
  // Position: to the left of the speedometer dial. Speedo center is
  // (hudW - 38 - 18, hudH - 38 - 28). Fuel sits 90 px to the left.
  const cx = hudW - 38 - 18 - 90;
  const cy = hudH - DIAL_R - 28;

  // Dial background — same dark inset look as the speedometer.
  ctx.fillStyle = 'rgba(20, 20, 30, 0.78)';
  ctx.beginPath();
  ctx.arc(cx, cy, DIAL_R, Math.PI, Math.PI * 2);
  ctx.lineTo(cx - DIAL_R, cy);
  ctx.fill();
  ctx.strokeStyle = 'rgba(0, 220, 220, 0.55)';
  ctx.lineWidth = 1.0;
  ctx.beginPath();
  ctx.arc(cx, cy, DIAL_R, Math.PI, Math.PI * 2);
  ctx.stroke();

  // Tick marks at E (0%), 1/4, 1/2, 3/4, F (100%).
  const minRad = (NEEDLE_MIN_DEG * Math.PI) / 180;
  const maxRad = (NEEDLE_MAX_DEG * Math.PI) / 180;
  const span = maxRad - minRad;
  ctx.strokeStyle = 'rgba(200, 220, 255, 0.85)';
  for (let i = 0; i <= 4; i++) {
    const t = i / 4;
    const a = minRad + t * span;
    const innerR = DIAL_R - 6;
    const outerR = DIAL_R - 2;
    ctx.lineWidth = i === 0 || i === 4 ? 1.5 : 0.8;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * innerR, cy + Math.sin(a) * innerR);
    ctx.lineTo(cx + Math.cos(a) * outerR, cy + Math.sin(a) * outerR);
    ctx.stroke();
  }

  // E + F labels.
  ctx.font = 'bold 9px monospace';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#f88';
  ctx.textAlign = 'left';
  ctx.fillText('E', cx - DIAL_R + 3, cy - 6);
  ctx.fillStyle = '#8f8';
  ctx.textAlign = 'right';
  ctx.fillText('F', cx + DIAL_R - 3, cy - 6);

  // Needle.
  const fClamped = Math.max(0, Math.min(1, fuel));
  const nAng = minRad + fClamped * span;
  // Color goes red → orange → green as fuel rises.
  const needleColor = fClamped < 0.15
    ? '#f44'
    : fClamped < 0.35
    ? '#fa0'
    : '#0f8';
  ctx.strokeStyle = needleColor;
  ctx.lineWidth = 2.2;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + Math.cos(nAng) * (DIAL_R - 4), cy + Math.sin(nAng) * (DIAL_R - 4));
  ctx.stroke();
  ctx.lineCap = 'butt';
  // Center hub.
  ctx.fillStyle = '#222';
  ctx.beginPath();
  ctx.arc(cx, cy, 3, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#0ff';
  ctx.lineWidth = 1;
  ctx.stroke();

  // "FUEL" label below the dial.
  ctx.fillStyle = '#888';
  ctx.font = '8px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText('FUEL', cx, cy + 6);

  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}
