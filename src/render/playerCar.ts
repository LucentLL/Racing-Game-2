/**
 * H6 placeholder player-car render.
 *
 * Draws a rotated triangle at the player's world position. Real V2
 * car renderer (src/render/carBody/drawCarBodyV2 + drawTopCar) replaces
 * this when the carBody scaffold's TODOs port. The triangle survives
 * as long as that work is in progress; once V2 lands this file is
 * removed.
 *
 * The shape is forward-pointed (apex along +x in local space) so it
 * visually matches the pAngle convention used by arcadeUpdate
 * (pAngle=0 → heading east; +cos*speed for x, +sin*speed for y).
 */

import type { PlayerState } from '@/state/player';

/** Body dimensions (world units, ≈ canvas px). Picked to read clearly
 *  at the current camera zoom — not tied to any specific car's real
 *  proportions yet. V2 renderer ports per-car-shape later. */
const CAR_LEN = 22;
const CAR_W = 14;
const WHEEL_LEN = 5;
const WHEEL_W = 3;
const WHEEL_INSET = 3;
const WINDSHIELD_LEN = 6;
const WINDSHIELD_W = 9;

/** Default body color when no active-car color is supplied. */
const DEFAULT_BODY = '#cc0000';

/** Headlight beam length, in world units. */
const BEAM_LEN = 220;
/** Half-angle of the headlight cone, in radians. ~24°. */
const BEAM_HALF_ANGLE = 0.42;
/** Color at the apex of the cone (bright at the car, fades to 0 at
 *  the far edge via radial gradient). */
const BEAM_COLOR = '255, 240, 180';

/** H54 — paint 2 small red tail-light rects at the rear of the car.
 *  H90 — pair of warm-white reverse lights inboard of the reds when
 *  reversing, with a soft halo for distance visibility.
 *  H94 — at night, paint a broader warm-white gradient wash behind
 *  the rear bumper so the reverse lamps appear to illuminate the
 *  ground (mirrors monolith's "reverse-light halo" at L1637/L3203).
 *  Called inside the rotated/translated frame, so coords are local
 *  (rear = -halfL, sides = ±halfW). */
function paintTailLights(
  ctx: CanvasRenderingContext2D,
  halfL: number,
  halfW: number,
  braking: boolean,
  reversing: boolean,
  nightIntensity: number,
): void {
  ctx.fillStyle = braking ? '#ff3020' : 'rgba(180, 30, 25, 0.85)';
  ctx.fillRect(-halfL,      -halfW + 1, 2, 2);
  ctx.fillRect(-halfL,       halfW - 3, 2, 2);
  if (braking) {
    // Bloom — slightly larger soft red square outside the body so
    // the brake light reads from a distance.
    ctx.fillStyle = 'rgba(255, 60, 50, 0.45)';
    ctx.fillRect(-halfL - 1, -halfW    , 3, 3);
    ctx.fillRect(-halfL - 1,  halfW - 3, 3, 3);
  }
  if (reversing) {
    // H94 — night-time ground wash. Painted FIRST so the bumper +
    // lamp pixels above sit on top and read crisply. Linear gradient
    // from the bumper outward fades to zero at ~8 px behind; alpha
    // scales with night so the wash is invisible in daylight and
    // bright at midnight. Spans the rear bumper width (just inside
    // the body edges so it doesn't bleed past the tail corners).
    if (nightIntensity > 0.05) {
      const reach = 8;
      const grad = ctx.createLinearGradient(-halfL, 0, -halfL - reach, 0);
      grad.addColorStop(0, `rgba(255, 240, 200, ${0.6 * nightIntensity})`);
      grad.addColorStop(1, 'rgba(255, 240, 200, 0)');
      ctx.fillStyle = grad;
      ctx.fillRect(-halfL - reach, -halfW + 1, reach, halfW * 2 - 2);
    }
    // H90 — warm-white reverse lamps, positioned inboard of the red
    // tail lights between them at rear center. Mirrors monolith's
    // "twin warm-white" reverse-light styling described at L3203.
    ctx.fillStyle = '#ffeec0';
    ctx.fillRect(-halfL, -halfW + 4, 2, 2);
    ctx.fillRect(-halfL,  halfW - 6, 2, 2);
    // Soft halo outside the body so the lamp reads at a distance,
    // matching the brake-light bloom pattern above.
    ctx.fillStyle = 'rgba(255, 240, 200, 0.45)';
    ctx.fillRect(-halfL - 1, -halfW + 3, 3, 3);
    ctx.fillRect(-halfL - 1,  halfW - 7, 3, 3);
  }
}

/** Darken a #RRGGBB hex string by a percent (0..1). Cheap inline lerp
 *  toward black so wheels / shadow read against the body color. */
function darken(hex: string, amount: number): string {
  if (!hex.startsWith('#') || hex.length !== 7) return hex;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const f = 1 - amount;
  const to2 = (n: number): string => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return '#' + to2(r * f) + to2(g * f) + to2(b * f);
}

/** Draws the player car in WORLD space — caller has already applied
 *  the camera transform via translate(). Renders the supplied PNG
 *  sprite when one is available + loaded; otherwise falls back to the
 *  H26 silhouette (body rectangle + wheels + windshield + headlights
 *  + heading dot) coloured by bodyColor.
 *
 *  Border flashes amber while collisionFlash > 0 (H18 visual feedback)
 *  regardless of which path renders.
 *
 *  H54: tail lights paint at rear; brighten when braking.
 *
 *  Sprite orientation convention (matches monolith L41190):
 *    "pre-oriented to front=+X" → ctx.rotate(player.pAngle) is enough,
 *    no extra offset. */
export function drawPlayerCar(
  ctx: CanvasRenderingContext2D,
  player: PlayerState,
  bodyColor: string = DEFAULT_BODY,
  sprite: HTMLImageElement | null = null,
  braking: boolean = false,
  reversing: boolean = false,
  nightIntensity: number = 0,
): void {
  ctx.save();
  ctx.translate(player.px, player.py);
  ctx.rotate(player.pAngle);

  const halfL = CAR_LEN / 2;
  const halfW = CAR_W / 2;
  const wheelColor = '#111';

  // Sprite path: drawn at the H26 silhouette's nominal size so it
  // takes the same world footprint regardless of source PNG
  // resolution. Bilinear smoothing on so the small PNGs don't read
  // as pixel-art when scaled up (real GBC pixel filter ports later).
  if (sprite && sprite.complete && sprite.naturalWidth > 0) {
    const smPrev = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(sprite, -halfL, -halfW, CAR_LEN, CAR_W);
    ctx.imageSmoothingEnabled = smPrev;

    // H54: tail lights — 2 red rects at the rear corners, brighter
    // when braking. Paint on top of the sprite so they read.
    paintTailLights(ctx, halfL, halfW, braking, reversing, nightIntensity);

    // Collision flash + heading dot still render on top so the
    // feedback reads above the sprite.
    if (player.collisionFlash > 0) {
      ctx.strokeStyle = `rgba(255, 200, 60, ${0.55 + 0.45 * player.collisionFlash})`;
      ctx.lineWidth = 2.5;
      ctx.strokeRect(-halfL, -halfW, CAR_LEN, CAR_W);
    }
    ctx.beginPath();
    ctx.arc(halfL + 1, 0, 1.4, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.restore();
    return;
  }


  // Wheels — drawn first so the body covers their inner edge.
  for (const [wx, wy] of [
    [ halfL - WHEEL_INSET,  halfW],   // front-right
    [ halfL - WHEEL_INSET, -halfW],   // front-left
    [-halfL + WHEEL_INSET,  halfW],   // rear-right
    [-halfL + WHEEL_INSET, -halfW],   // rear-left
  ] as const) {
    ctx.fillStyle = wheelColor;
    ctx.fillRect(wx - WHEEL_LEN / 2, wy - WHEEL_W / 2, WHEEL_LEN, WHEEL_W);
  }

  // Body.
  ctx.fillStyle = bodyColor;
  ctx.fillRect(-halfL, -halfW, CAR_LEN, CAR_W);

  // Subtle darker stripe down the centerline — reads as the roof seam
  // / hood line at this scale.
  ctx.fillStyle = darken(bodyColor, 0.3);
  ctx.fillRect(-halfL, -0.5, CAR_LEN, 1);

  // Windshield — light-blue strip on the front half of the cabin.
  ctx.fillStyle = 'rgba(170, 220, 255, 0.6)';
  ctx.fillRect(halfL - WINDSHIELD_LEN - 3, -WINDSHIELD_W / 2, WINDSHIELD_LEN, WINDSHIELD_W);

  // Headlight studs — tiny bright rects at the front corners.
  ctx.fillStyle = '#ffe98a';
  ctx.fillRect(halfL - 2, -halfW + 1, 2, 2);
  ctx.fillRect(halfL - 2, halfW - 3, 2, 2);

  // H54: tail lights at the rear corners. Brighten on brake.
  // H90: warm-white reverse lamps when pSpeed<-0.5.
  paintTailLights(ctx, halfL, halfW, braking, reversing, nightIntensity);

  // Outline — flashes amber on collision; otherwise a dark border for
  // contrast against light-colored bodies.
  if (player.collisionFlash > 0) {
    ctx.strokeStyle = `rgba(255, 200, 60, ${0.55 + 0.45 * player.collisionFlash})`;
    ctx.lineWidth = 2.5;
  } else {
    ctx.strokeStyle = 'rgba(0,0,0,0.65)';
    ctx.lineWidth = 1.2;
  }
  ctx.strokeRect(-halfL, -halfW, CAR_LEN, CAR_W);

  // Heading indicator — tiny white dot at the very front. Belt-and-
  // suspenders next to the headlight studs; reads at any zoom.
  ctx.beginPath();
  ctx.arc(halfL + 1, 0, 1.4, 0, Math.PI * 2);
  ctx.fillStyle = '#fff';
  ctx.fill();

  ctx.restore();
}

/** Draws warm headlight cones in front of the player. Call BEFORE the
 *  car body so the cone sits under the car visually. Skip silently when
 *  `intensity` is 0 (full day) — no allocation or path work. */
export function drawHeadlights(
  ctx: CanvasRenderingContext2D,
  player: PlayerState,
  intensity: number,
): void {
  drawHeadlightsAt(ctx, player.px, player.py, player.pAngle, intensity, CAR_LEN, BEAM_LEN);
}

/** H53 generic cone paint — used by the player and the traffic
 *  headlight pass. carLen is where the apex starts (front of the
 *  vehicle in local +x); beamLen is the cone's reach. */
export function drawHeadlightsAt(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  angle: number,
  intensity: number,
  carLen: number = CAR_LEN,
  beamLen: number = BEAM_LEN,
): void {
  if (intensity <= 0.02) return;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);

  // Cone apex at car nose, fanning out along +x.
  const x0 = carLen;
  const xFar = x0 + beamLen;
  const cosA = Math.cos(BEAM_HALF_ANGLE);
  const sinA = Math.sin(BEAM_HALF_ANGLE);
  const leftX = x0 + beamLen * cosA;
  const leftY = -beamLen * sinA;
  const rightX = leftX;
  const rightY = -leftY;

  const grad = ctx.createRadialGradient(x0, 0, 0, x0, 0, beamLen);
  grad.addColorStop(0, `rgba(${BEAM_COLOR}, ${0.42 * intensity})`);
  grad.addColorStop(0.55, `rgba(${BEAM_COLOR}, ${0.18 * intensity})`);
  grad.addColorStop(1, `rgba(${BEAM_COLOR}, 0)`);

  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(x0, 0);
  ctx.lineTo(leftX, leftY);
  ctx.quadraticCurveTo(xFar, 0, rightX, rightY);
  ctx.closePath();
  ctx.fill();

  ctx.restore();
}
