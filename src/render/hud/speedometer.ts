/**
 * H64 — analog speedometer HUD widget.
 *
 * Bottom-right of the HUD canvas. Circular dial with tick marks every
 * 20 u/s from 0 to 200, a sweeping red-tipped needle pointing at the
 * current speed, and a digital readout below the dial. Replaces the
 * "X u/s" text the H build had been using since H6.
 *
 * Ported in simplified form from the monolith's canvas-fallback gauge
 * cluster (L29472-29940, the PC analog gauges path). The full SVG
 * speedometer (mobile path, L22907-23040) is a separate port that
 * needs DOM #speedoSvg shell elements first.
 */

const SPEED_MAX = 200;           // matches arcadeUpdate MAX_SPEED
const DIAL_OUTER = 38;
const DIAL_INNER = 30;
const NEEDLE_LEN = 32;
const TICK_MAJOR = 4;
const TICK_MINOR = 2;
/** Needle sweep: -135° at 0 to +135° at SPEED_MAX (270° total arc). */
const NEEDLE_MIN_DEG = -135;
const NEEDLE_MAX_DEG =  135;

/** Paint the speedometer at the bottom-right of the HUD canvas.
 *  Caller has applied no transform — coords are HUD-canvas-absolute. */
export function drawSpeedometer(
  ctx: CanvasRenderingContext2D,
  hudW: number,
  hudH: number,
  speed: number,
): void {
  const cx = hudW - DIAL_OUTER - 18;
  const cy = hudH - DIAL_OUTER - 28;

  // Dial background — dark inset circle.
  ctx.fillStyle = 'rgba(20, 20, 30, 0.78)';
  ctx.beginPath();
  ctx.arc(cx, cy, DIAL_OUTER, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(0, 220, 220, 0.55)';
  ctx.lineWidth = 1.2;
  ctx.stroke();

  // Tick marks. Major every 20 u/s, minor every 5.
  const minRad = (NEEDLE_MIN_DEG * Math.PI) / 180;
  const maxRad = (NEEDLE_MAX_DEG * Math.PI) / 180;
  const span = maxRad - minRad;
  ctx.strokeStyle = 'rgba(200, 220, 255, 0.85)';
  for (let v = 0; v <= SPEED_MAX; v += 5) {
    const major = v % 20 === 0;
    const t = v / SPEED_MAX;
    // Rotate -90° so 0 points "down" (south) — matches typical
    // automotive speedometer orientation (idle bottom-left, redline
    // bottom-right).
    const a = minRad + t * span + Math.PI / 2;
    const innerR = DIAL_OUTER - (major ? TICK_MAJOR + 4 : TICK_MINOR + 2);
    const outerR = DIAL_OUTER - 4;
    ctx.lineWidth = major ? 1.5 : 0.8;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * innerR, cy + Math.sin(a) * innerR);
    ctx.lineTo(cx + Math.cos(a) * outerR, cy + Math.sin(a) * outerR);
    ctx.stroke();
    // Labels every 40.
    if (v % 40 === 0) {
      ctx.fillStyle = '#cfd';
      ctx.font = 'bold 8px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const lr = innerR - 5;
      ctx.fillText(String(v), cx + Math.cos(a) * lr, cy + Math.sin(a) * lr);
    }
  }

  // Needle.
  const speedClamped = Math.max(0, Math.min(SPEED_MAX, speed));
  const t = speedClamped / SPEED_MAX;
  const nAng = minRad + t * span + Math.PI / 2;
  // Color shifts green → yellow → red across the dial.
  const needleColor = t < 0.5
    ? `rgba(${Math.round(120 + t * 270)}, 220, 100, 0.95)`
    : `rgba(255, ${Math.round(220 - (t - 0.5) * 380)}, 60, 0.95)`;
  ctx.strokeStyle = needleColor;
  ctx.lineCap = 'round';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + Math.cos(nAng) * NEEDLE_LEN, cy + Math.sin(nAng) * NEEDLE_LEN);
  ctx.stroke();
  ctx.lineCap = 'butt';
  // Center hub.
  ctx.fillStyle = '#222';
  ctx.beginPath();
  ctx.arc(cx, cy, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#0ff';
  ctx.lineWidth = 1;
  ctx.stroke();

  // Digital readout below the dial.
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 12px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText(`${Math.round(speed)}`, cx, cy + DIAL_OUTER + 4);
  ctx.fillStyle = '#888';
  ctx.font = '8px monospace';
  ctx.fillText('u/s', cx, cy + DIAL_OUTER + 18);

  // Reset for the rest of the HUD.
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  // Mark dial's screen area as used — caller can use INNER if needed.
  void DIAL_INNER;
}
