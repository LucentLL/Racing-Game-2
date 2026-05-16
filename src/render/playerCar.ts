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
import type { TrafficCar } from '@/state/traffic';
import type { CatalogCar } from '@/config/cars/catalog';
import { rectCornersWS, castShadowPoly } from '@/engine/shadows';
import { drawTopCar } from './carBody';
import { getVehicleSprite, hasVehicleSprite } from '@/engine/sprites';
import { SPRITE_BUFFER } from '@/config/cars/spriteBuffer';
import { GT4_SPECS } from '@/config/cars/gt4Database';

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

/** H146: default body footprint for the V2 dispatcher's player snapshot.
 *  drawTopCar derives every per-chassis silhouette from this base size +
 *  the GT4_SPECS per-car mm dimensions. The real CAR().size port lands
 *  later — for now [22, 8] reads like a typical mid-90s coupe (e.g.
 *  RX-7 FD is 4285×1760mm; at gpmL ≈ 22/4285 the X-ray geom resolves
 *  correctly). Matches the existing CAR_LEN-tier proportion the
 *  placeholder used so swap-in is dimensionally neutral. */
const V2_PLAYER_SIZE: readonly [number, number] = [22, 8];

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
  // H95: red night ground wash. Painted BEFORE the lamp pixels so the
  // crisp red corner rects sit on top. Symmetric to H94's reverse wash
  // — same reach (8 px), same gradient shape, red instead of warm-
  // white. Only fires when actually braking (per H93's _braking gate,
  // which excludes reverse-engagement) AND night > 0.05. Color matches
  // the daytime brake-bloom rgba(255, 60, 50) so the wash reads as the
  // ground reflection of the same bulb.
  if (braking && nightIntensity > 0.05) {
    const reach = 8;
    const grad = ctx.createLinearGradient(-halfL, 0, -halfL - reach, 0);
    grad.addColorStop(0, `rgba(255, 60, 50, ${0.55 * nightIntensity})`);
    grad.addColorStop(1, 'rgba(255, 60, 50, 0)');
    ctx.fillStyle = grad;
    ctx.fillRect(-halfL - reach, -halfW + 1, reach, halfW * 2 - 2);
  }
  // H96: night-time running-light brighten. Real cars run their tail
  // lamps at higher visible intensity after dark as part of the
  // headlights-on switch position. Modular doesn't model a separate
  // running-light bulb yet, so we just lift the always-on dim red's
  // alpha from 0.85 (day) toward 1.0 (full night). Brake-bright path
  // is already at full alpha + saturated #ff3020, no extra lift needed.
  const _runningAlpha = 0.85 + 0.15 * nightIntensity;
  ctx.fillStyle = braking ? '#ff3020' : `rgba(180, 30, 25, ${_runningAlpha})`;
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

/** H145: half-extents of a traffic car for shadow casting. 8 length
 *  × 4.5 width is the visual footprint of the colored-rect / sprite
 *  fallback used by drawTraffic at the current camera zoom. The real
 *  V2 sizes (8-15 × 4-7 by car class) port later — for now a single
 *  approximation keeps the shadow geometry simple. */
const TRAFFIC_OCCLUDER_HL = 8;
const TRAFFIC_OCCLUDER_HW = 4.5;
/** H145: shadow polygon alpha. The cone fades over its length so a
 *  flat 0.55 black inside the clip darkens the cone strongly near the
 *  occluder and almost-imperceptibly at the cone's far edge (where the
 *  cone is already faint). Matches the monolith's heavy near-shadow
 *  feel without porting the distance-modulated alpha at L32567+. */
const SHADOW_ALPHA = 0.55;
/** H145: cone-range gate for occluder selection. Traffic farther than
 *  this from the headlight apex doesn't contribute a shadow. BEAM_LEN
 *  is the cone reach; 1.2× lets a car JUST past the bright tip still
 *  cast a shortened shadow back into the visible cone. */
const OCCLUDER_RANGE = BEAM_LEN * 1.2;
const OCCLUDER_RANGE2 = OCCLUDER_RANGE * OCCLUDER_RANGE;

/** Draws warm headlight cones in front of the player. Call BEFORE the
 *  car body so the cone sits under the car visually. Skip silently when
 *  `intensity` is 0 (full day) — no allocation or path work.
 *
 *  H145: traffic cars in front of the player cast shadow polygons into
 *  the cone. Light source = headlight apex (front of player car); for
 *  each occluder a quad extends away from the apex through the rect's
 *  silhouette corners out to OCCLUDER_RANGE. The cone path is set as
 *  a clip before the shadow fill so the dark polys can't leak onto
 *  the ground outside the cone. */
export function drawHeadlights(
  ctx: CanvasRenderingContext2D,
  player: PlayerState,
  intensity: number,
  traffic?: ReadonlyArray<TrafficCar>,
): void {
  drawHeadlightsAt(ctx, player.px, player.py, player.pAngle, intensity, CAR_LEN, BEAM_LEN);
  if (!traffic || intensity <= 0.02) return;
  castPlayerHeadlightShadows(ctx, player, intensity, traffic);
}

/** H145: cast shadow polys for traffic cars sitting inside the player's
 *  headlight cone reach. Uses the same cone geometry drawHeadlightsAt
 *  builds (apex at car nose, +x local heading) so the clip path lines
 *  up exactly. Per-car cost: one rectCornersWS + one castShadowPoly.
 *  Range-gated up front to skip cars behind / out-of-cone. */
function castPlayerHeadlightShadows(
  ctx: CanvasRenderingContext2D,
  player: PlayerState,
  intensity: number,
  traffic: ReadonlyArray<TrafficCar>,
): void {
  const cosA = Math.cos(player.pAngle);
  const sinA = Math.sin(player.pAngle);
  // Headlight apex in world coords. Mirrors the local x0=CAR_LEN
  // origin used by drawHeadlightsAt — multiplied out by the player's
  // rotation matrix.
  const apexX = player.px + cosA * CAR_LEN;
  const apexY = player.py + sinA * CAR_LEN;
  // Forward-vector dot test: drop any car whose vector from the apex
  // points backward. Saves the more expensive per-car shadow build.
  const cosHalf = Math.cos(BEAM_HALF_ANGLE);

  ctx.save();
  // Re-trace the cone path identical to drawHeadlightsAt for clipping.
  // x0/xFar/leftX/leftY/rightY mirror that function's local coords,
  // then mapped through the player's rotation + translation. Building
  // the quadraticCurveTo in world coords lets ctx.clip work without
  // mutating the camera transform.
  const xFar = CAR_LEN + BEAM_LEN;
  const leftLocalX = CAR_LEN + BEAM_LEN * cosHalf;
  const leftLocalY = -BEAM_LEN * Math.sin(BEAM_HALF_ANGLE);
  const r = (lx: number, ly: number): [number, number] => [
    player.px + cosA * lx - sinA * ly,
    player.py + sinA * lx + cosA * ly,
  ];
  const [ax, ay] = r(CAR_LEN, 0);
  const [lx, ly] = r(leftLocalX, leftLocalY);
  const [fx, fy] = r(xFar, 0);
  const [rx, ry] = r(leftLocalX, -leftLocalY);
  ctx.beginPath();
  ctx.moveTo(ax, ay);
  ctx.lineTo(lx, ly);
  ctx.quadraticCurveTo(fx, fy, rx, ry);
  ctx.closePath();
  ctx.clip();

  ctx.fillStyle = `rgba(0,0,0,${SHADOW_ALPHA * intensity})`;
  for (const car of traffic) {
    const dx = car.px - apexX;
    const dy = car.py - apexY;
    const d2 = dx * dx + dy * dy;
    if (d2 > OCCLUDER_RANGE2) continue;
    // Forward gate. dot(headingUnit, toCarUnit) > cos(halfAngle)
    // means the car sits inside the cone's angular span. Skip the
    // sqrt — multiply through by len(toCar) on both sides.
    const dot = dx * cosA + dy * sinA;
    if (dot <= 0) continue;
    // dot/|toCar| > cos(halfAngle) ↔ dot² > cos²(halfAngle) * d²
    if (dot * dot < cosHalf * cosHalf * d2) continue;
    const corners = rectCornersWS(car.px, car.py, car.pAngle, TRAFFIC_OCCLUDER_HL, TRAFFIC_OCCLUDER_HW);
    castShadowPoly(ctx, apexX, apexY, corners, OCCLUDER_RANGE);
  }
  ctx.restore();
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

/** H146: V2-aware player car render. Threads PlayerCarSnapshot +
 *  DrawTopCarDeps into the carBody dispatcher so the player gets:
 *    1. Per-chassis V2 vector silhouette for known generations
 *       (RX-7 FD, GTR R34, Civic EK, Supra A80, etc.) when no sprite
 *       loaded.
 *    2. X-Ray fallback (dashed cyan body + yellow GT4-geometry tires)
 *       for chassis without a V2 renderer.
 *
 *  xrayBody: true is forced here per the user's request — sprites
 *  aren't loading reliably, so the X-Ray look is the visible default.
 *  Per-genData renderers honor isXray and switch their internal stack
 *  to the wireframe variant.
 *
 *  Collision flash overlay paints AFTER drawTopCar in a rotated frame
 *  matching the player pose; the V2 dispatcher restores its own ctx
 *  state on return so we re-enter at the camera-world transform.
 *
 *  drawHeadlights from H145 still runs separately before this from
 *  gameLoop — the player headlight cone is independent of the body
 *  silhouette + tire pass. */
export function drawPlayerCarV2(
  ctx: CanvasRenderingContext2D,
  player: PlayerState,
  car: CatalogCar | null,
  braking: boolean,
  reversing: boolean,
): void {
  const name = car?.name ?? '';
  const color = car?.color ?? DEFAULT_BODY;
  const isBike = car?.isBike ?? false;

  drawTopCar(
    ctx,
    {
      cx: player.px,
      cy: player.py,
      angle: player.pAngle,
      color,
      isPlayer: true,
      steerAngle: 0,
      isBraking: braking,
    },
    {
      player: {
        name,
        color,
        size: V2_PLAYER_SIZE,
        isBike,
        isReverse: reversing,
        steerAngle: 0,
        leftHeadlightOut: false,
        rightHeadlightOut: false,
        leftTaillightOut: false,
        rightTaillightOut: false,
        // H148: auto-fallback X-Ray. drawTopCar's gate at L401 +
        // L414 picks the V2 sprite when hasVehicleSprite(genId) is
        // true, the V2 vector renderer when the genId has GEN_DATA
        // but no PNG, and X-Ray (dashed cyan + yellow tires) when
        // neither. The forced `true` from H146 was a stop-gap while
        // loadVehicleSprites() wasn't being called at boot; now that
        // main.ts kicks it, players see their PNG art if loaded and
        // X-Ray only as a fallback.
        xrayBody: false,
      },
      hour: 12,
      getVehicleSprite,
      hasVehicleSprite,
      spriteBuffer: SPRITE_BUFFER,
      gt4Lookup: (n) => GT4_SPECS[n],
    },
  );

  // Collision flash — paint in the player's rotated frame on top of
  // the X-Ray body so it reads as a hit indicator. Skipped at rest.
  if (player.collisionFlash > 0) {
    ctx.save();
    ctx.translate(player.px, player.py);
    ctx.rotate(player.pAngle);
    const halfL = V2_PLAYER_SIZE[0] / 2;
    const halfW = V2_PLAYER_SIZE[1] / 2;
    ctx.strokeStyle = `rgba(255, 200, 60, ${0.55 + 0.45 * player.collisionFlash})`;
    ctx.lineWidth = 2.5;
    ctx.strokeRect(-halfL, -halfW, V2_PLAYER_SIZE[0], V2_PLAYER_SIZE[1]);
    ctx.restore();
  }
}
