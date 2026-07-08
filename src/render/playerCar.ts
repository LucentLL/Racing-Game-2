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
import { rectCornersWS, castShadowPoly, drawSoftCone, traceSoftCone } from '@/engine/shadows';
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
// H805: ×1.394 — fallback only (active cars carry spec-derived size).
const V2_PLAYER_SIZE: readonly [number, number] = [30.7, 11.2];

/** Headlight beam length, in world units. */
const BEAM_LEN = 220;
/** Half-spread (radians) of one car-headlight cone. Matches monolith
 *  L33522 outerSpread = 0.36 for non-bike vehicles. */
const BEAM_HALF_SPREAD_CAR = 0.36;
/** Wider half-spread for single-headlamp bikes. Monolith L33522 uses
 *  0.40 to compensate for the missing second cone. */
const BEAM_HALF_SPREAD_BIKE = 0.40;
/** H1077: drawSoftCone bulges its edges out to halfSpread × 1.5 (the
 *  quadratic control points) — the widest angle any lit ground reaches.
 *  The occluder pre-gate uses this so a car is only skipped when NO
 *  part of it can touch lit ground; the actual paint is clipped to the
 *  REAL lamp-cone union, so a generous gate can't leak light. */
const SHADOW_GATE_BULGE = 1.5;
const SHADOW_GATE_MARGIN = 0.10;
/** Color stops for the warm amber halogen cone. Matches monolith
 *  drawHeadlightConesPassA at L32386–32389 (#fc7 = rgb(255,204,119),
 *  amber halogen replacing the cool '#ffa' from v8.99.123.94). */
const BEAM_COLOR = '255, 204, 119';

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
  // resolution. H725: imageSmoothing OFF so the sprite stays
  // crisp nearest-neighbor through the canvas — H723's
  // image-rendering:pixelated upscale at the CSS layer then
  // preserves that crispness all the way to the viewport. The
  // old `imageSmoothing = true` ran bilinear blur INSIDE the
  // canvas, which H723 couldn't undo (CSS only controls the
  // canvas→screen step, not the sprite→canvas step).
  if (sprite && sprite.complete && sprite.naturalWidth > 0) {
    const smPrev = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(sprite, -halfL, -halfW, CAR_LEN, CAR_W);
    ctx.imageSmoothingEnabled = smPrev;

    // H54: tail lights — 2 red rects at the rear corners, brighter
    // when braking. Paint on top of the sprite so they read.
    paintTailLights(ctx, halfL, halfW, braking, reversing, nightIntensity);

    // H823: amber collision-flash border removed (user dislike). The
    // collisionFlash STATE stays — it doubles as the re-hit cooldown
    // in trafficCollision.ts — but no longer paints a yellow outline.
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

  // Outline — dark border for contrast against light-colored bodies.
  // H823: amber collision-flash branch removed (user dislike); the
  // collisionFlash state remains as the re-hit cooldown only.
  ctx.strokeStyle = 'rgba(0,0,0,0.65)';
  ctx.lineWidth = 1.2;
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
// H805: ×1.394 with the road-true car scale (cars draw ~40% bigger).
const TRAFFIC_OCCLUDER_HL = 11.2;
const TRAFFIC_OCCLUDER_HW = 6.3;
/** H145: base shadow polygon alpha at the apex. H1077: now scaled per
 *  occluder by beamFalloffAt(dist) — the monolith's distance-modulated
 *  alpha (L32567+) this port originally skipped. A car right in front
 *  gets the full 0.55 cut; one near the beam tip barely dents the
 *  already-faint cone, and the shadow GROWS in as you approach instead
 *  of popping at a fixed radius (user report). */
const SHADOW_ALPHA = 0.55;
/** H1077: circumradius of the occluder rect — its angular half-width
 *  seen from the apex is asin(R / dist), used by the soft pre-gate. */
const OCCLUDER_RADIUS = Math.hypot(TRAFFIC_OCCLUDER_HL, TRAFFIC_OCCLUDER_HW);
/** H1077: relative beam strength at u = dist / BEAM_LEN — the cone
 *  gradient's alpha stops (0.50 / 0.30 / 0.10 / 0 at u 0 / 0.2 / 0.5 /
 *  1) normalized to 1 at the apex. Shadow contrast tracks the light
 *  actually hitting the occluder. */
function beamFalloffAt(u: number): number {
  if (u <= 0) return 1;
  if (u <= 0.2) return 1 - (u / 0.2) * 0.4;
  if (u <= 0.5) return 0.6 - ((u - 0.2) / 0.3) * 0.4;
  if (u >= 1) return 0;
  return 0.2 * (1 - (u - 0.5) / 0.5);
}
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
  traffic?: ReadonlyArray<HeadlightOccluderPose>,
  carHalfLen: number = CAR_LEN / 2,
  carHalfWidth: number = CAR_W / 2,
  isBike: boolean = false,
): void {
  // H258: carHalfLen is the apex offset along +x in car-local space — half
  // the body length, i.e., the front bumper. 1:1 with monolith L32294
  // `carHL = CAR().size[0]/2`. Defaults to the H6 placeholder CAR_LEN/2
  // when no per-car size is resolved (pre-life start-flow). Without this
  // plumb the cone apex landed at +CAR_LEN = +22 from the player center
  // — past the actual nose of any real car (NSX nose is at +9.9) — which
  // matched the legacy 22-unit placeholder body but is wrong for every
  // GT4-derived chassis.
  // H260: carHalfWidth + isBike thread the per-chassis dual-lamp offset
  // through. Bikes emit a single center cone; cars emit one cone per
  // headlamp at ±(halfW - 1) perpendicular to heading.
  drawHeadlightsAt(
    ctx, player.px, player.py, player.pAngle,
    intensity, carHalfLen, BEAM_LEN, carHalfWidth, isBike,
  );
  if (!traffic || intensity <= 0.02) return;
  castPlayerHeadlightShadows(ctx, player, intensity, traffic, carHalfLen, carHalfWidth, isBike);
}

/** H1070: minimal pose an occluder needs — traffic cars satisfy this
 *  structurally, and parked cars adapt {x,y,angle} → this shape at
 *  the gameLoop call site. castPlayerHeadlightShadows only ever read
 *  px/py/pAngle (occluder extents are the fixed TRAFFIC_OCCLUDER_*
 *  constants), so widening the type costs nothing. */
export interface HeadlightOccluderPose {
  px: number;
  py: number;
  pAngle: number;
}

/** H145: cast shadow polys for traffic cars sitting inside the player's
 *  headlight cone reach. Per-car cost: one rectCornersWS + one
 *  castShadowPoly. Range-gated up front to skip cars behind the apex.
 *
 *  H1077 (user report: shadows popped on/off as the beam swept across
 *  parked cars, and never faded with distance):
 *    1. The clip is the UNION of the two REAL lamp cones (the exact
 *       shapes drawHeadlightsAt fills) instead of one straight-edged
 *       0.42 rad approximation. A shadow can never paint outside lit
 *       ground, and as the beam edge sweeps off a car the visible
 *       shadow geometrically shrinks to a sliver before vanishing.
 *    2. The angular gate only skips a car when NO part of it (center
 *       angle minus its own angular half-width) can reach the bulged
 *       cone edge — the old test dropped the whole shadow the instant
 *       the CENTER left the clip cone.
 *    3. Shadow alpha is distance-modulated by the beam's own falloff,
 *       sampled at the car's near face. */
function castPlayerHeadlightShadows(
  ctx: CanvasRenderingContext2D,
  player: PlayerState,
  intensity: number,
  traffic: ReadonlyArray<HeadlightOccluderPose>,
  carHalfLen: number,
  carHalfWidth: number,
  isBike: boolean,
): void {
  const cosA = Math.cos(player.pAngle);
  const sinA = Math.sin(player.pAngle);
  // Headlight apex in world coords. H258: was CAR_LEN (full body length
  // placeholder), now the actual half-length so apex lands at the car
  // nose. Mirrors monolith L32294.
  const apexX = player.px + cosA * carHalfLen;
  const apexY = player.py + sinA * carHalfLen;
  const halfSpread = isBike ? BEAM_HALF_SPREAD_BIKE : BEAM_HALF_SPREAD_CAR;
  const lampOff = isBike ? 0 : Math.max(0, carHalfWidth - 1);
  const sides = isBike ? [0] : [-1, 1];

  ctx.save();
  // Build the lamp-cone union clip in car-local space (same coords
  // drawHeadlightsAt paints in), then undo the transform WITHOUT a
  // restore — the clip survives, and the shadow polys below stay in
  // plain world coords.
  ctx.translate(player.px, player.py);
  ctx.rotate(player.pAngle);
  ctx.beginPath();
  for (const s of sides) {
    traceSoftCone(ctx, carHalfLen, s * lampOff, 0, halfSpread, BEAM_LEN);
  }
  ctx.clip();
  ctx.rotate(-player.pAngle);
  ctx.translate(-player.px, -player.py);

  const gateAng = halfSpread * SHADOW_GATE_BULGE + SHADOW_GATE_MARGIN;
  for (const car of traffic) {
    const dx = car.px - apexX;
    const dy = car.py - apexY;
    const d2 = dx * dx + dy * dy;
    if (d2 > OCCLUDER_RANGE2) continue;
    // Behind-the-apex cull — cheap, and a car fully behind the nose
    // can't intersect the forward cones.
    const dot = dx * cosA + dy * sinA;
    if (dot <= 0) continue;
    const dist = Math.sqrt(d2);
    const angOff = Math.acos(Math.min(1, dot / dist));
    const angHW = Math.asin(Math.min(1, OCCLUDER_RADIUS / dist));
    if (angOff - angHW > gateAng) continue;
    const fall = beamFalloffAt(Math.max(0, dist - TRAFFIC_OCCLUDER_HL) / BEAM_LEN);
    const a = SHADOW_ALPHA * intensity * fall;
    if (a < 0.01) continue;
    ctx.fillStyle = `rgba(0,0,0,${a})`;
    const corners = rectCornersWS(car.px, car.py, car.pAngle, TRAFFIC_OCCLUDER_HL, TRAFFIC_OCCLUDER_HW);
    castShadowPoly(ctx, apexX, apexY, corners, OCCLUDER_RANGE);
  }
  ctx.restore();
}

/** H53 generic cone paint — used by the player and the traffic
 *  headlight pass. `apexOffset` is the local +x coordinate where the
 *  cone apex sits — typically the vehicle's HALF length so the apex
 *  lands exactly at the front bumper. beamLen is the cone's reach.
 *
 *  H260: emits TWO cones (left + right lamp) for cars, single
 *  centered cone for bikes — mirrors monolith L33519-L33534
 *  drawTrafficHeadlightCones. Uses drawSoftCone (engine/shadows.ts)
 *  with amber halogen color rgb(255,204,119) and per-class half-
 *  spread, replacing the single-cone quadratic shape this function
 *  emitted from H53-H259.
 *
 *  H258: `apexOffset` renamed from `carLen` (which was being passed
 *  full lengths, putting the apex past the nose); semantic is now
 *  unambiguous.
 *
 *  `halfWidth` is the vehicle's half-width — used to position the
 *  two lamp cones at ±(halfWidth - 1) perpendicular to heading. */
export function drawHeadlightsAt(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  angle: number,
  intensity: number,
  apexOffset: number = CAR_LEN / 2,
  beamLen: number = BEAM_LEN,
  halfWidth: number = CAR_W / 2,
  isBike: boolean = false,
): void {
  if (intensity <= 0.02) return;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);

  const sides = isBike ? [0] : [-1, 1];
  const lampOff = isBike ? 0 : Math.max(0, halfWidth - 1);
  const halfSpread = isBike ? BEAM_HALF_SPREAD_BIKE : BEAM_HALF_SPREAD_CAR;

  for (const s of sides) {
    const ox = apexOffset;
    const oy = s * lampOff;
    const grad = ctx.createRadialGradient(ox, oy, 0, ox, oy, beamLen);
    grad.addColorStop(0,   `rgba(${BEAM_COLOR}, ${0.50 * intensity})`);
    grad.addColorStop(0.2, `rgba(${BEAM_COLOR}, ${0.30 * intensity})`);
    grad.addColorStop(0.5, `rgba(${BEAM_COLOR}, ${0.10 * intensity})`);
    grad.addColorStop(1,   `rgba(${BEAM_COLOR}, 0)`);
    ctx.fillStyle = grad;
    drawSoftCone(ctx, ox, oy, 0, halfSpread, beamLen);
  }

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
  nightIntensity: number = 0,
  xrayBody: boolean = false,
  /** H511: true when the player is on an active PARAMEDIC shift —
   *  flips the ambulance lightbar (when the player's car IS the
   *  ambulance) from its off-shift palette to the blink animation.
   *  No effect when the player isn't driving the Ambulance chassis. */
  paramedicLightsActive: boolean = false,
  /** H604: per-zone body damage map (life.bodyDamage). Threaded
   *  through to drawTopCar's X-Ray branch so the damage overlay
   *  reads cosmetic / functional / structural per-zone color
   *  intensities. Without this the X-Ray panel always shows a
   *  pristine chassis even after H597 accrued real damage. */
  bodyDamage?: import('./carBody/damage').BodyDamage,
  /** H675: signed steering axis (-1..1) from the live input. The X-Ray
   *  front-tire renderer rotates each front wheel by `steerAxis ×
   *  MAX_WHEEL_TURN_RAD` so the player can SEE the wheels turn. Prior
   *  to H675 this was hardcoded to 0 — the X-Ray tires never moved
   *  even at full lock. */
  steerAxis: number = 0,
): void {
  const name = car?.name ?? '';
  const color = car?.color ?? DEFAULT_BODY;
  const isBike = car?.isBike ?? false;
  // H675: real front wheel turns ~30° at full lock; map -1..1 →
  // ±0.52 rad. Bikes lean instead of turning their wheel, but the
  // X-Ray bike geometry shares the same rotate API and a small
  // angle reads correctly as a lean here.
  const MAX_WHEEL_TURN_RAD = 0.52;
  const _wheelAngle = Math.max(-1, Math.min(1, steerAxis)) * MAX_WHEEL_TURN_RAD;
  // H150: per-car footprint from CatalogCar.size (GT4_SPECS-derived).
  // Falls back to V2_PLAYER_SIZE only when there's no active CAR()
  // (pre-life start-flow path), so the player snapshot tracks the
  // real chassis dimensions for sprites + V2 vector + X-Ray geom.
  const size = car?.size ?? V2_PLAYER_SIZE;

  drawTopCar(
    ctx,
    {
      cx: player.px,
      cy: player.py,
      angle: player.pAngle,
      color,
      isPlayer: true,
      steerAngle: _wheelAngle,
      isBraking: braking,
    },
    {
      player: {
        name,
        color,
        size,
        isBike,
        isReverse: reversing,
        steerAngle: _wheelAngle,
        leftHeadlightOut: false,
        rightHeadlightOut: false,
        leftTaillightOut: false,
        rightTaillightOut: false,
        // H148/H154: defaults to auto-fallback X-Ray (sprite if
        // loaded, V2 vector if not, X-Ray as last resort). H154
        // lets LIFE.gameplaySettings.xrayBody force the X-Ray
        // branch regardless via the drawPlayerCarV2 xrayBody param.
        xrayBody,
        // H604: thread bodyDamage through so drawXrayDamageOverlay
        // (called from drawTopCar's X-Ray branch) renders the live
        // per-zone color heatmap instead of a clean chassis.
        bodyDamage,
      },
      hour: 12,
      getVehicleSprite,
      hasVehicleSprite,
      spriteBuffer: SPRITE_BUFFER,
      gt4Lookup: (n) => GT4_SPECS[n],
      paramedicLightsActive,
    },
  );

  // H149: paint the H94/H95/H96 tail-light bloom + reverse halo on
  // top of the V2 body. drawTopCar's per-gen renderers paint their
  // own corner pixels via v2TaillightGlow but skip the night halo /
  // brake bloom / reverse warm-white that paintTailLights renders —
  // those effects ported in H94/H95/H96 are part of our build's
  // night-driving feel. Drawn in the player's rotated frame so
  // local coords match the body offsets; tail lamps sit at
  // (-halfL, ±yOff) past the rear bumper.
  ctx.save();
  ctx.translate(player.px, player.py);
  ctx.rotate(player.pAngle);
  // H150: tail-light + collision flash offsets follow the actual
  // CAR().size now so the rear bumper lamps land at the body tip,
  // not at the old uniform 22×8 V2_PLAYER_SIZE corners.
  const halfL = size[0] / 2;
  const halfW = size[1] / 2;
  // H675: paintTailLights was drawing identical 2×2 red corner
  // squares on EVERY car regardless of geometry — visible as
  // duplicate overlay squares on top of sprite-mapped cars (whose
  // sprites already bake in per-car lamp shapes) AND on top of
  // V2-vector cars (whose genData renderers paint their own
  // v2TaillightGlow per-chassis). Gate to X-Ray-only: the X-Ray
  // body is a dashed cyan outline with no built-in lamps, so the
  // generic overlay still serves its purpose there. The H94/H95/H96
  // bloom + ground wash effects ride along with the same gate;
  // re-adding them to the sprite / V2 paths is a future hop that
  // needs per-car lamp coordinates anyway.
  if (xrayBody) {
    paintTailLights(ctx, halfL, halfW, braking, reversing, nightIntensity);
  }

  // H823: amber collision-flash border removed (user dislike). The
  // collisionFlash state persists purely as the re-hit cooldown.
  ctx.restore();
}
