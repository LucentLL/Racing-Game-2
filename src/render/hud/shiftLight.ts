/**
 * H68 — progressive shift light row above the tachometer.
 *
 * Five LEDs centered above the H66 tach dial. Lights up sequentially as
 * RPM climbs through the powerband (green → yellow → red), then the
 * redline LED flashes at ~4 Hz once RPM crosses the limit. Mirrors the
 * shift-light bars common to sport-car instrument clusters (Civic Type
 * R, RX-7 FD, Supra A80 redline lamp).
 *
 * Uses the same RPM-from-speed proxy as drawTachometer — when the real
 * gearAndRpm.ts model gets wired, both modules should switch to reading
 * player.pRpm directly. Stateless flash via Date.now() so no per-player
 * field needed.
 */

const SPEED_MAX = 200;
const RPM_IDLE = 800;
const RPM_MAX = 8000;

const LED_COUNT = 5;
const LED_RADIUS = 3.8;
const LED_GAP = 5;
const FLASH_PERIOD_MS = 250;     // 4 Hz redline flash

/** RPM thresholds (fraction of RPM_MAX) at which each LED turns on. */
const THRESHOLDS = [0.50, 0.62, 0.74, 0.85, 0.95];
/** Per-LED colors when lit. */
const LIT_COLORS  = ['#3fcf6a', '#3fcf6a', '#e6c52f', '#ff7e2a', '#ff3030'];
/** Off color — same dark inset look as the dial backgrounds. */
const OFF_COLOR = 'rgba(40, 40, 50, 0.65)';

/** Paint the shift-light row above the tachometer dial. */
export function drawShiftLight(
  ctx: CanvasRenderingContext2D,
  hudW: number,
  hudH: number,
  speed: number,
): void {
  // Tach center, same math as tachometer.ts + gearIndicator.ts.
  const TACH_OUTER = 32;
  const cx = hudW - 56 - 90 - 84;
  const cy = hudH - TACH_OUTER - 28;

  // Row sits 6 px above the dial's top edge.
  const rowY = cy - TACH_OUTER - 6;
  const rowSpan = LED_COUNT * (LED_RADIUS * 2) + (LED_COUNT - 1) * LED_GAP;
  const startX = cx - rowSpan / 2 + LED_RADIUS;

  // Proxy RPM, same formula as drawTachometer.
  const speedClamped = Math.max(0, Math.min(SPEED_MAX, speed));
  const rpm = RPM_IDLE + (RPM_MAX - RPM_IDLE) * (speedClamped / SPEED_MAX);
  const rpmFrac = rpm / RPM_MAX;

  // Redline = top LED's threshold. Flash the top LED once past it.
  const overRedline = rpmFrac >= THRESHOLDS[LED_COUNT - 1];
  const flashOn = (Date.now() % FLASH_PERIOD_MS) < FLASH_PERIOD_MS / 2;

  for (let i = 0; i < LED_COUNT; i++) {
    const lit = rpmFrac >= THRESHOLDS[i];
    // Top LED flashes when past redline (the warning state).
    const isFlashingTop = i === LED_COUNT - 1 && overRedline;
    const showLit = lit && (!isFlashingTop || flashOn);

    const x = startX + i * (LED_RADIUS * 2 + LED_GAP);

    // Glow halo when lit — tiny radial gradient. The halo reads as
    // brightness rather than just a colored circle.
    if (showLit) {
      const grad = ctx.createRadialGradient(x, rowY, 0, x, rowY, LED_RADIUS * 2.4);
      grad.addColorStop(0, LIT_COLORS[i]);
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(x, rowY, LED_RADIUS * 2.4, 0, Math.PI * 2);
      ctx.fill();
    }

    // LED body.
    ctx.fillStyle = showLit ? LIT_COLORS[i] : OFF_COLOR;
    ctx.beginPath();
    ctx.arc(x, rowY, LED_RADIUS, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0, 220, 220, 0.4)';
    ctx.lineWidth = 0.7;
    ctx.stroke();
  }
}
