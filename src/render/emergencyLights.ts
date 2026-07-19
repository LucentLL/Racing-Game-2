/**
 * H1190/H1191 — shared emergency-vehicle lighting.
 *
 * `drawEmergencyBar` replaces the old flat blue/white rectangle lightbar
 * (render/trafficCop.ts) with a proper State-Trooper-style bar: a dark
 * housing across the roof holding a row of red/blue bulbs that wig-wag
 * (driver half red, passenger half blue, alternating) as ADDITIVE glows
 * so they read as lit lamps with soft bloom, not stickered-on squares.
 *
 * `emergencyWash` tints a nearby car BODY with the pulsing emergency
 * color (the light reflecting on other cars, per the user's ask). Cop =
 * red/blue alternation; ambulance = red. Works day and night — emergency
 * strobes are visible in daylight — with a directional gradient brighter
 * on the flank facing the emergency vehicle.
 */

/** RGB triples for the two emergency colors. */
const RED: readonly [number, number, number] = [255, 45, 45];
const BLUE: readonly [number, number, number] = [55, 110, 255];

export type EmergencyMode = 'copRB' | 'red';

export interface EmergencyBarOpts {
  /** 'copRB' = red/blue trooper wig-wag; 'red' = all-red (fire/ambulance). */
  mode: EmergencyMode;
  /** Half-length across the car (local Y). Default 4.2 (fits an ~8-wide body). */
  halfLen?: number;
  /** Housing depth along the car (local X). Default 2.4. */
  depth?: number;
  /** Roof position along the car (local X); +forward. Default 0. */
  forward?: number;
  /** Bulb count. Default 6. */
  nCells?: number;
}

/** Draw the roof lightbar in the car's LOCAL frame. Caller supplies the
 *  car's world pose; this handles the translate/rotate. */
export function drawEmergencyBar(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  angle: number,
  opts: EmergencyBarOpts,
): void {
  const now = Date.now();
  const phase = Math.floor(now / 110) & 1;      // ~4.5 Hz wig-wag toggle
  const halfLen = opts.halfLen ?? 4.2;
  const depth = opts.depth ?? 2.4;
  const fwd = opts.forward ?? 0;
  const n = opts.nCells ?? 6;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  // Housing — a thin dark bar across the roof so the lit cells sit in a
  // believable fixture rather than floating.
  ctx.fillStyle = 'rgba(12,13,18,0.85)';
  ctx.fillRect(fwd - depth / 2, -halfLen, depth, halfLen * 2);
  // Bulbs — additive so the glow brightens rather than paints flat boxes.
  const prevOp = ctx.globalCompositeOperation;
  ctx.globalCompositeOperation = 'lighter';
  const glowR = depth * 0.95;
  for (let i = 0; i < n; i++) {
    const cy = -halfLen + ((i + 0.5) / n) * halfLen * 2;
    // Cop: driver half red, passenger half blue. Ambulance: all red.
    const redSide = opts.mode === 'red' ? true : i < n / 2;
    const col = redSide ? RED : BLUE;
    // Wig-wag: the red half is bright on phase 0, blue half on phase 1
    // (ambulance's two halves alternate on opposite phases too).
    const bright = (opts.mode === 'red' ? (i % 2 === 0) : redSide)
      ? phase === 0 : phase === 1;
    const a = bright ? 0.92 : 0.12;
    const g = ctx.createRadialGradient(fwd, cy, 0, fwd, cy, glowR);
    g.addColorStop(0, `rgba(${col[0]},${col[1]},${col[2]},${a})`);
    g.addColorStop(0.5, `rgba(${col[0]},${col[1]},${col[2]},${(a * 0.5).toFixed(3)})`);
    g.addColorStop(1, `rgba(${col[0]},${col[1]},${col[2]},0)`);
    ctx.fillStyle = g;
    ctx.fillRect(fwd - glowR, cy - glowR, glowR * 2, glowR * 2);
  }
  ctx.globalCompositeOperation = prevOp;
  ctx.restore();
}

/** H1191: an emergency light SOURCE — a vehicle whose strobes wash onto
 *  nearby car bodies. */
export interface EmergencySource {
  x: number;
  y: number;
  /** 'copRB' pulses red↔blue; 'red' pulses red only. */
  mode: EmergencyMode;
  /** Reach in world px. */
  reach: number;
}

/** The current pulsing wash color for an emergency source (RGB + 0..1
 *  intensity envelope), from wall-clock time so the wash syncs with the
 *  bar's wig-wag. */
function washColor(mode: EmergencyMode, now: number): { rgb: readonly [number, number, number]; env: number } {
  if (mode === 'red') {
    // Ambulance: a single red strobe, hard on/off.
    const env = Math.floor(now / 130) % 2 === 0 ? 1 : 0.25;
    return { rgb: RED, env };
  }
  // Cop: alternate red / blue, each dominant for its half of the cycle.
  const half = Math.floor(now / 130) % 2 === 0;
  return { rgb: half ? RED : BLUE, env: 1 };
}

/** H1191: wash one car body with any nearby emergency source's pulsing
 *  color. `ctx` carries the world transform; (x,y,angle) + len/wid are
 *  the body. Call AFTER the body sprite, alongside drawCarLighting. */
export function emergencyWash(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  angle: number,
  len: number,
  wid: number,
  now: number,
  sources: readonly EmergencySource[] | null,
): void {
  if (!sources || sources.length === 0) return;
  const hl = len / 2, hw = wid / 2;
  const cosA = Math.cos(angle), sinA = Math.sin(angle);
  // Strongest source hitting this car.
  let best = 0;
  let bestMode: EmergencyMode = 'copRB';
  let bdx = 0, bdy = 0;
  for (const s of sources) {
    const dx = x - s.x, dy = y - s.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < 4 || d2 > s.reach * s.reach) continue; // self / out of reach
    const d = Math.sqrt(d2);
    const f = 1 - d / s.reach;
    if (f > best) { best = f; bestMode = s.mode; bdx = dx / d; bdy = dy / d; }
  }
  if (best <= 0.02) return;
  const { rgb, env } = washColor(bestMode, now);
  const a0 = Math.min(0.5, 0.5 * best * env);
  if (a0 < 0.02) return;
  // Incoming light direction in the car's local frame → gradient bright
  // on the flank facing the source, fading across the body.
  const lx = bdx * cosA + bdy * sinA;
  const ly = -bdx * sinA + bdy * cosA;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  const g = ctx.createLinearGradient(-lx * hl, -ly * hw, lx * hl, ly * hw);
  g.addColorStop(0, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a0.toFixed(3)})`);
  g.addColorStop(1, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${(a0 * 0.2).toFixed(3)})`);
  ctx.fillStyle = g;
  ctx.fillRect(-hl + 0.5, -hw + 0.5, len - 1, wid - 1);
  ctx.restore();
}
