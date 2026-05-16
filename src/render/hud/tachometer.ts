/**
 * H66 — analog tachometer (RPM gauge).
 *
 * Sits to the left of the H65 fuel gauge, completing the dashboard
 * cluster (tach | fuel | speedo) along the bottom-right of the HUD.
 * Full circular dial with tick marks every 500 RPM, labels every 2000,
 * a redline arc past 6500, and a needle that turns red past redline.
 *
 * RPM is derived from speed as a simple linear proxy (idle 800 at
 * speed=0 → max 8000 at speed=SPEED_MAX). The monolith models real
 * gear-shift transitions with RPM drops at shift points (gearAndRpm.ts
 * exists as a scaffold but isn't wired into arcadeUpdate yet); when
 * that lands, drawTachometer should switch to reading player.pRpm
 * directly instead of computing from speed.
 *
 * Ported in simplified form from the monolith's canvas gauge cluster
 * (L29472-29940, the PC analog gauges path). The full per-car RPM
 * preset (idle / redline per CAR_CATALOG entry) is a follow-up.
 */

const SPEED_MAX = 200;          // matches arcadeUpdate MAX_SPEED + H64
const RPM_IDLE = 800;
const RPM_MAX = 8000;
const RPM_REDLINE = 6500;

const DIAL_OUTER = 32;
const NEEDLE_LEN = 26;
const TICK_MAJOR = 4;
const TICK_MINOR = 2;
/** 270° sweep matching the H64 speedometer. */
const NEEDLE_MIN_DEG = -135;
const NEEDLE_MAX_DEG =  135;

/** Paint the tachometer to the left of the fuel gauge. */
export function drawTachometer(
  ctx: CanvasRenderingContext2D,
  hudW: number,
  hudH: number,
  speed: number,
): void {
  // Speedo center = (hudW - 56, hudH - 66). Fuel center = speedo - 90.
  // Tach sits another 84 px left of fuel so the three dials read as a
  // single instrument cluster (tach is slightly smaller than speedo,
  // so 84 keeps the gap visually balanced).
  const cx = hudW - 56 - 90 - 84;
  const cy = hudH - DIAL_OUTER - 28;

  // Dial background — same dark inset look as the speedometer.
  ctx.fillStyle = 'rgba(20, 20, 30, 0.78)';
  ctx.beginPath();
  ctx.arc(cx, cy, DIAL_OUTER, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(0, 220, 220, 0.55)';
  ctx.lineWidth = 1.2;
  ctx.stroke();

  const minRad = (NEEDLE_MIN_DEG * Math.PI) / 180;
  const maxRad = (NEEDLE_MAX_DEG * Math.PI) / 180;
  const span = maxRad - minRad;

  // Redline arc — paints first so ticks + needle sit on top of it.
  // Sweeps from RPM_REDLINE to RPM_MAX along the outer edge.
  const redStart = minRad + (RPM_REDLINE / RPM_MAX) * span + Math.PI / 2;
  const redEnd   = minRad + 1 * span + Math.PI / 2;
  ctx.strokeStyle = 'rgba(255, 60, 60, 0.7)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(cx, cy, DIAL_OUTER - 3, redStart, redEnd);
  ctx.stroke();

  // Tick marks. Major every 1000, minor every 500. Labels every 2000.
  ctx.strokeStyle = 'rgba(200, 220, 255, 0.85)';
  for (let rpm = 0; rpm <= RPM_MAX; rpm += 500) {
    const major = rpm % 1000 === 0;
    const t = rpm / RPM_MAX;
    // -90° rotate so 0 RPM points down-left (matches speedo orientation).
    const a = minRad + t * span + Math.PI / 2;
    const innerR = DIAL_OUTER - (major ? TICK_MAJOR + 3 : TICK_MINOR + 2);
    const outerR = DIAL_OUTER - 4;
    ctx.lineWidth = major ? 1.5 : 0.8;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * innerR, cy + Math.sin(a) * innerR);
    ctx.lineTo(cx + Math.cos(a) * outerR, cy + Math.sin(a) * outerR);
    ctx.stroke();
    // Labels every 2000 — show in thousands (0, 2, 4, 6, 8).
    if (rpm % 2000 === 0) {
      ctx.fillStyle = rpm >= RPM_REDLINE ? '#f88' : '#cfd';
      ctx.font = 'bold 8px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const lr = innerR - 5;
      ctx.fillText(String(rpm / 1000), cx + Math.cos(a) * lr, cy + Math.sin(a) * lr);
    }
  }

  // Compute proxy RPM from speed. Linear from idle to max — no gear-
  // shift sawtooth (deferred until real RPM model is wired).
  const speedClamped = Math.max(0, Math.min(SPEED_MAX, speed));
  const rpm = RPM_IDLE + (RPM_MAX - RPM_IDLE) * (speedClamped / SPEED_MAX);

  // Needle.
  const t = rpm / RPM_MAX;
  const nAng = minRad + t * span + Math.PI / 2;
  const overRedline = rpm >= RPM_REDLINE;
  // Cool-blue below redline, hot-red above. Subtle gradient inside the
  // cool zone (cyan-tinted at idle, white at mid).
  const needleColor = overRedline
    ? 'rgba(255, 80, 60, 0.95)'
    : t < 0.5
      ? `rgba(${Math.round(160 + t * 190)}, 240, 255, 0.95)`
      : `rgba(255, ${Math.round(240 - (t - 0.5) * 280)}, 200, 0.95)`;
  ctx.strokeStyle = needleColor;
  ctx.lineCap = 'round';
  ctx.lineWidth = 2.2;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + Math.cos(nAng) * NEEDLE_LEN, cy + Math.sin(nAng) * NEEDLE_LEN);
  ctx.stroke();
  ctx.lineCap = 'butt';
  // Center hub.
  ctx.fillStyle = '#222';
  ctx.beginPath();
  ctx.arc(cx, cy, 3.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#0ff';
  ctx.lineWidth = 1;
  ctx.stroke();

  // "RPM ×1000" label below the dial.
  ctx.fillStyle = '#888';
  ctx.font = '8px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText('RPM x1000', cx, cy + DIAL_OUTER + 4);

  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}
