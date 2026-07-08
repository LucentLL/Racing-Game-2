/**
 * OBB-vs-OBB player ↔ traffic collision (H732).
 *
 * Each car is an oriented bounding box sized to its visible body
 * (player from CatalogCar.size, traffic from TRAFFIC_BODY_SIZES
 * resolved via spriteFile → bodyType). Hit test = Separating Axis
 * Theorem on the 4 edge normals; broad-phase reject uses each
 * box's half-diagonal as a bounding-circle radius.
 *
 * Pre-H732 this was a circle test with CAR_RADIUS=9 (collision
 * fires at center-to-center < 18). That radius matched neither
 * length (22) nor width (8) of the actual sprite — side-by-side
 * passes triggered false hits with ~10u of visible gap, and
 * length-wise rear-ends missed real contact at ~22u. User report:
 * "yellow border collision when I'm not even making contact —
 * only actual pixels should count, not the transparent pixels."
 *
 * H824 — REAL collision response (replaces the old "bump + slow"):
 *   1. SEPARATE. obbMTV returns the minimum-translation vector
 *      (contact normal + penetration depth). The boxes are pushed
 *      apart along it, split by inverse mass — so the player can no
 *      longer drive THROUGH a car. Runs every overlapping frame, not
 *      gated behind the damage cooldown (that gate was what let the
 *      player tunnel straight through during the post-hit window).
 *   2. IMPULSE. A normal impulse with restitution exchanges momentum
 *      along the contact normal: the player rebounds, the traffic car
 *      is shoved off its lane (via the H824 knockback fields). Inverse-
 *      mass weighting means a heavy/fast body dominates a light one —
 *      a Miata bounces off a Semi; the Semi barely notices; the Semi
 *      flings the Miata aside. Player mass = CatalogCar.kg; traffic
 *      mass from TRAFFIC_BODY_MASS by bodyType.
 *   3. DAMAGE / SOUND / FLASH still fire on the FLASH_DURATION cooldown
 *      (one crash event per ~0.5s) so a grinding contact doesn't spam
 *      sparks + crash audio — but the physical separation/impulse keep
 *      running underneath so the cars never interpenetrate.
 */

import type { PlayerState } from '@/state/player';
import type { TrafficCar } from '@/state/traffic';
import type { LifeState } from '@/state/life';
import { CAR_CATALOG, type CatalogCar } from '@/config/cars/catalog';
import { BASELINE_ROADS } from '@/config/world/baselineRoads';
import { classifyHitZone, applyZoneDamage } from '@/sim/faults';
import { TRAFFIC_BODY_SIZES } from '@/render/carBody/drawTopCar';
import { spriteFileToBodyType } from '@/render/traffic';
import {
  computeFifthWheelPivot,
  trailerVsVehicle,
  TRAILER_TALL_BODY_TYPES,
} from '@/physics/trailer';

const FUEL_PENALTY_MAX = 0.03;         // max fuel cost per heavy bump
const FLASH_DURATION = 0.5;            // seconds the flash stays > 0 (doubles as damage cooldown)
const MAX_SPEED = 258;                 // mirrors arcadeUpdate's MAX_SPEED (H805 ×1.29)

/** H824 collision-response tuning. */
const RESTITUTION = 0.35;              // bounce along the contact normal (0=stick, 1=elastic)
const SEPARATION_SLOP = 0.5;           // px of overlap left unresolved — avoids per-frame jitter
const DEFAULT_PLAYER_MASS = 1400;      // kg fallback when no CatalogCar
const DEFAULT_TRAFFIC_MASS = 1400;     // kg fallback for an unknown bodyType

/** H824: per-bodyType curb mass in kg, the denominator of the impulse
 *  split. Realistic-ish so the dominance ordering matches intuition:
 *  Semi/box/tow ≫ pickup > cruiser/sedan > civic/sport > Miata/AE86 ≫
 *  bike. Only the contact-normal impulse uses these (not the spline
 *  motion), so exact values matter less than their RATIOS. Keys are
 *  the bodyType strings spriteFileToBodyType emits (see drawTopCar). */
const TRAFFIC_BODY_MASS: Readonly<Record<string, number>> = {
  semi:     8000,
  boxtruck: 4500,
  towtruck: 5500,
  bike:      200,
  civic99:  1100,
  accord99: 1450,
  sedan:    1500,
  hatch:    1700,
  suv:      1700,
  pickup:   2100,
  cruiser:  1800,
  viper:    1550, nsx: 1370, rx7: 1310, gtr: 1560, camaro: 1500,
  dodge_viper: 1550, nsx_na: 1370, rx7_fc: 1260, rx7_fd: 1310,
  gtr_r34: 1560, gtr_r34_vspec: 1560,
  dodge_charger: 1700, dodge_super_bee: 1700, plymouth_cuda: 1650,
  miata_na: 980, silvia: 1200, silvia_180sx: 1200, ae86: 950,
  audi_quattro: 1290, ruf_btr: 1210, ruf_ctr_yb: 1210, ruf_ctr2: 1350,
};

/** Fallback body size when no CatalogCar / bodyType lookup resolves —
 *  matches V2_PLAYER_SIZE in render/playerCar.ts. H805: ×1.394 with
 *  the road-true car scale (fallbacks only — live sizes come from
 *  CatalogCar.size / TRAFFIC_BODY_SIZES, both rescaled at source). */
const DEFAULT_PLAYER_SIZE: readonly [number, number] = [30.7, 11.2];
const DEFAULT_TRAFFIC_SIZE: readonly [number, number] = [27.9, 11.2];

/** Returned on the frame a collision resolves. Caller uses
 *  `impact` to drive the crash-sound volume. */
export interface CollisionEvent {
  /** Impact factor 0..1 = pre-collision pSpeed / MAX_SPEED. */
  impact: number;
}

/** Project an OBB's 4 corners onto a unit axis and return [min, max]. */
function projectOBB(
  cx: number, cy: number,
  hl: number, hw: number,
  ca: number, sa: number,
  axX: number, axY: number,
): [number, number] {
  // Corner offsets (local): (±hl, ±hw). World-space dots collapse to:
  //   center·axis  ±  hl·|(ca,sa)·axis|  ±  hw·|(-sa,ca)·axis|
  const cDot = cx * axX + cy * axY;
  const lDot = Math.abs((ca * axX + sa * axY) * hl);
  const wDot = Math.abs((-sa * axX + ca * axY) * hw);
  const r = lDot + wDot;
  return [cDot - r, cDot + r];
}

/** SAT with minimum-translation-vector. Tests the 4 edge normals
 *  (2 per box) — necessary and sufficient for two rotated 2D rects.
 *  Returns null if a separating axis exists (no overlap); otherwise
 *  the axis of LEAST overlap as a unit normal + penetration depth.
 *  The normal is oriented to point from B toward A, i.e. the direction
 *  A must move to separate from B. All 4 axes are unit vectors
 *  (cos/sin pairs), so the overlap is already in world units. */
function obbMTV(
  ax: number, ay: number, aAng: number, aHl: number, aHw: number,
  bx: number, by: number, bAng: number, bHl: number, bHw: number,
): { nx: number; ny: number; depth: number } | null {
  const aCa = Math.cos(aAng), aSa = Math.sin(aAng);
  const bCa = Math.cos(bAng), bSa = Math.sin(bAng);
  const axes: ReadonlyArray<readonly [number, number]> = [
    [aCa,  aSa],   // A's length axis
    [-aSa, aCa],   // A's width axis
    [bCa,  bSa],   // B's length axis
    [-bSa, bCa],   // B's width axis
  ];
  let minOverlap = Infinity;
  let mnx = 0, mny = 0;
  for (const [axX, axY] of axes) {
    const [aMin, aMax] = projectOBB(ax, ay, aHl, aHw, aCa, aSa, axX, axY);
    const [bMin, bMax] = projectOBB(bx, by, bHl, bHw, bCa, bSa, axX, axY);
    const overlap = Math.min(aMax, bMax) - Math.max(aMin, bMin);
    if (overlap <= 0) return null;                  // separating axis found
    if (overlap < minOverlap) { minOverlap = overlap; mnx = axX; mny = axY; }
  }
  // Orient the normal from B toward A (the way A separates).
  if ((ax - bx) * mnx + (ay - by) * mny < 0) { mnx = -mnx; mny = -mny; }
  return { nx: mnx, ny: mny, depth: minOverlap };
}

/** H1007: NPC-vs-NPC separation. Until now the ONLY OBB overlap resolver
 *  (tickTrafficCollisions) tested player↔traffic only, so two NPCs — most
 *  visibly a pursuing cop (which disables its braking, traffic.ts) and the
 *  civilian in its lane — freely drove THROUGH each other. This runs a
 *  pairwise same-z separation over the (small, ~20-car) pool each frame,
 *  reusing the SAT MTV + the H824 knockback channel (kx/ky), so shoved
 *  cars spring back to their lane after. Cross-z pairs (highway over street)
 *  intentionally pass through — gated on equal roadZ, mirroring the
 *  player collision's z-gate.
 *
 *  Also caps same-lane creep: when two cars overlap and one is AHEAD of the
 *  other along its travel direction, the rear car's speed is clamped to the
 *  front car's so a fast car (or brake-disabled cop) can't keep burrowing
 *  in. Perf: O(n²) over ≤20 cars (≤190 pairs) with a bounding-circle
 *  broad-phase — trivial, no spatial index needed. */
export function tickTrafficSeparation(traffic: TrafficCar[]): void {
  const n = traffic.length;
  if (n < 2) return;
  // Cache per-car half-extents + mass once.
  const hl: number[] = new Array(n);
  const hw: number[] = new Array(n);
  const invM: number[] = new Array(n);
  const diag: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const bt = spriteFileToBodyType(traffic[i].spriteFile);
    const size = TRAFFIC_BODY_SIZES[bt] ?? DEFAULT_TRAFFIC_SIZE;
    hl[i] = size[0] / 2;
    hw[i] = size[1] / 2;
    invM[i] = 1 / (TRAFFIC_BODY_MASS[bt] ?? DEFAULT_TRAFFIC_MASS);
    diag[i] = Math.sqrt(hl[i] * hl[i] + hw[i] * hw[i]);
  }
  for (let i = 0; i < n; i++) {
    const a = traffic[i];
    for (let j = i + 1; j < n; j++) {
      const b = traffic[j];
      if (a.roadZ !== b.roadZ) continue; // cross-z pass-through (bridges)
      const dx = b.px - a.px;
      const dy = b.py - a.py;
      const sum = diag[i] + diag[j];
      if (dx * dx + dy * dy > sum * sum) continue; // broad-phase
      const mtv = obbMTV(
        a.px, a.py, a.pAngle, hl[i], hw[i],
        b.px, b.py, b.pAngle, hl[j], hw[j],
      );
      if (!mtv) continue;
      const { nx, ny, depth } = mtv; // n points b → a
      const corr = Math.max(0, depth - SEPARATION_SLOP);
      if (corr <= 0) continue;
      const invSum = invM[i] + invM[j];
      const aPush = corr * (invM[i] / invSum);
      const bPush = corr * (invM[j] / invSum);
      // A moves +n, B moves −n. Write both the render pose (px/py) and the
      // knockback offset (kx/ky) so tickTraffic's decay springs them back.
      a.px += nx * aPush; a.py += ny * aPush;
      a.kx += nx * aPush; a.ky += ny * aPush;
      b.px -= nx * bPush; b.py -= ny * bPush;
      b.kx -= nx * bPush; b.ky -= ny * bPush;
      // Same-lane creep clamp: the car BEHIND (in its own heading) slows to
      // the one ahead so a brake-disabled cop can't keep tunneling in.
      const along = dx * Math.cos(a.pAngle) + dy * Math.sin(a.pAngle);
      if (along > 0) {
        // b is ahead of a → a is the rear car.
        if (a.speed > b.speed) a.speed = b.speed;
      } else {
        // a is ahead of b → b is the rear car.
        if (b.speed > a.speed) b.speed = a.speed;
      }
    }
  }
}

/** Returns a CollisionEvent if a hit fired this frame, null otherwise. */
export function tickTrafficCollisions(
  player: PlayerState,
  traffic: TrafficCar[],
  life?: LifeState,
  /** H732: player's CatalogCar for body size. Falls back to
   *  DEFAULT_PLAYER_SIZE when undefined (pre-life start-flow). */
  playerCar?: CatalogCar | null,
): CollisionEvent | null {
  // Fade the flash regardless of whether we collide this frame.
  if (player.collisionFlash > 0) {
    player.collisionFlash = Math.max(0, player.collisionFlash - 1 / 60);
  }

  const pSize = playerCar?.size ?? DEFAULT_PLAYER_SIZE;
  const pHl = pSize[0] / 2;
  const pHw = pSize[1] / 2;
  const pDiag2 = pHl * pHl + pHw * pHw;
  const pCos = Math.cos(player.pAngle);
  const pSin = Math.sin(player.pAngle);
  const mp = playerCar?.kg ?? DEFAULT_PLAYER_MASS;
  const invMp = 1 / mp;
  // Player velocity vector (wpx/s) along heading. Lateral slip is
  // ignored for the impulse — the MTV separation covers sideways shove.
  const pvx = player.pSpeed * pCos;
  const pvy = player.pSpeed * pSin;

  // Damage/sound fire at most once per cooldown window; physical
  // separation + impulse run on EVERY overlapping car every frame.
  const damageAllowed = player.collisionFlash <= FLASH_DURATION * 0.5;
  let bestImpact = -1;            // strongest closing speed among this frame's hits
  let bestDx = 0, bestDy = 0;     // its contact vector, for hit-zone classification

  for (const car of traffic) {
    // H142: per-z layer filter unchanged.
    if (car.roadZ !== player.layerZ) continue;

    const bodyType = spriteFileToBodyType(car.spriteFile);
    const tSize = TRAFFIC_BODY_SIZES[bodyType] ?? DEFAULT_TRAFFIC_SIZE;
    const tHl = tSize[0] / 2;
    const tHw = tSize[1] / 2;
    const tDiag2 = tHl * tHl + tHw * tHw;

    const dx = car.px - player.px;
    const dy = car.py - player.py;
    const d2 = dx * dx + dy * dy;
    // Broad-phase: centers farther than (halfDiag_p + halfDiag_t) can't
    // intersect.
    const sumDiag = Math.sqrt(pDiag2) + Math.sqrt(tDiag2);
    if (d2 > sumDiag * sumDiag) continue;

    const mtv = obbMTV(
      player.px, player.py, player.pAngle, pHl, pHw,
      car.px,    car.py,    car.pAngle,    tHl, tHw,
    );
    if (!mtv) continue;
    const { nx, ny, depth } = mtv;   // n points from traffic → player

    const mt = TRAFFIC_BODY_MASS[bodyType] ?? DEFAULT_TRAFFIC_MASS;
    const invMt = 1 / mt;
    const invSum = invMp + invMt;

    // (1) SEPARATE — push the boxes apart along the MTV, split by
    //     inverse mass so the heavier body barely moves. The player
    //     owns px/py directly; the traffic car is spline-bound, so its
    //     share goes into the H824 knockback offset (kx/ky). Also nudge
    //     car.px/py this frame so the render shows the gap immediately.
    const corr = Math.max(0, depth - SEPARATION_SLOP);
    if (corr > 0) {
      const pPush = corr * (invMp / invSum);
      const tPush = corr * (invMt / invSum);
      player.px += nx * pPush;
      player.py += ny * pPush;
      car.kx -= nx * tPush;
      car.ky -= ny * tPush;
      car.px -= nx * tPush;
      car.py -= ny * tPush;
    }

    // (2) IMPULSE — momentum exchange along the contact normal.
    //     Traffic velocity = spline motion (speed along its heading)
    //     plus any current knockback velocity.
    const tvx = car.speed * Math.cos(car.pAngle) + car.kvx;
    const tvy = car.speed * Math.sin(car.pAngle) + car.kvy;
    const rvx = pvx - tvx;
    const rvy = pvy - tvy;
    const velN = rvx * nx + rvy * ny;   // <0 ⇒ closing along the normal
    if (velN < 0) {
      const j = -(1 + RESTITUTION) * velN / invSum;
      // Player: re-derive scalar pSpeed from the post-impulse velocity
      // projected onto heading (lateral component was handled by MTV).
      const npvx = pvx + j * invMp * nx;
      const npvy = pvy + j * invMp * ny;
      player.pSpeed = npvx * pCos + npvy * pSin;
      // Traffic: the shove lands in the decaying knockback velocity.
      car.kvx -= j * invMt * nx;
      car.kvy -= j * invMt * ny;

      // Closing speed drives crash severity (more honest than raw
      // pSpeed — a glancing pass barely registers).
      const impact = Math.min(1, -velN / MAX_SPEED);
      if (impact > bestImpact) { bestImpact = impact; bestDx = dx; bestDy = dy; }
    }
  }

  // (3) DAMAGE / SOUND / FLASH — once per cooldown, on the worst hit.
  if (bestImpact >= 0 && damageAllowed) {
    player.fuel = Math.max(0, player.fuel - FUEL_PENALTY_MAX * bestImpact);
    player.collisionFlash = FLASH_DURATION;
    if (life) {
      const impactDmg = bestImpact * 30;
      const scrapeDmg = bestImpact * 4;
      const zone = classifyHitZone(bestDx, bestDy, pCos, pSin, pHl, pHw);
      applyZoneDamage(life, zone, impactDmg, scrapeDmg);
    }
    void BASELINE_ROADS;
    return { impact: bestImpact };
  }
  void BASELINE_ROADS;
  return null;
}

/** H1070: collide the player against PARKED cars (car meets, lots).
 *  User report: "the player can drive over the NPC cars like they're
 *  in the ground" — parked cars were render-only props with no OBB.
 *
 *  Mirrors [[tickTrafficCollisions]]'s separate/impulse/damage flow
 *  but STATIC: a parked car has infinite effective mass, so the
 *  player takes 100% of the separation and the full restitution
 *  bounce (a parked car doesn't get shoved — no knockback fields
 *  exist on ParkedCar anyway). Body size comes from the catalog row
 *  (parked cars ARE catalog cars).
 *
 *  Does NOT touch player.collisionFlash's decay — the traffic tick
 *  runs first every frame and already fades it; this function only
 *  SETS the flash on a fresh hit, sharing the same cooldown so a
 *  meet fender-tap can't double-bill damage with a traffic hit.
 *
 *  Caller passes getParkedCars() LIVE each frame — the meet
 *  challenge splices the rival out of the array when the race
 *  starts, and that car must stop colliding immediately. */
export function tickParkedCarCollisions(
  player: PlayerState,
  parked: ReadonlyArray<{ id: string; x: number; y: number; angle: number }>,
  life?: LifeState,
  playerCar?: CatalogCar | null,
): CollisionEvent | null {
  if (parked.length === 0) return null;

  const pSize = playerCar?.size ?? DEFAULT_PLAYER_SIZE;
  const pHl = pSize[0] / 2;
  const pHw = pSize[1] / 2;
  const pDiag = Math.sqrt(pHl * pHl + pHw * pHw);
  const pCos = Math.cos(player.pAngle);
  const pSin = Math.sin(player.pAngle);
  const pvx = player.pSpeed * pCos;
  const pvy = player.pSpeed * pSin;

  const damageAllowed = player.collisionFlash <= FLASH_DURATION * 0.5;
  let bestImpact = -1;
  let bestDx = 0, bestDy = 0;

  for (const c of parked) {
    const size = CAR_CATALOG[c.id]?.size ?? DEFAULT_TRAFFIC_SIZE;
    const hl = size[0] / 2;
    const hw = size[1] / 2;

    const dx = c.x - player.px;
    const dy = c.y - player.py;
    const sumDiag = pDiag + Math.sqrt(hl * hl + hw * hw);
    if (dx * dx + dy * dy > sumDiag * sumDiag) continue;

    const mtv = obbMTV(
      player.px, player.py, player.pAngle, pHl, pHw,
      c.x, c.y, c.angle, hl, hw,
    );
    if (!mtv) continue;
    const { nx, ny, depth } = mtv; // n points parked → player

    // (1) SEPARATE — player takes the whole correction (static body).
    const corr = Math.max(0, depth - SEPARATION_SLOP);
    if (corr > 0) {
      player.px += nx * corr;
      player.py += ny * corr;
    }

    // (2) IMPULSE — reflect the closing component off the static box.
    const velN = pvx * nx + pvy * ny;
    if (velN < 0) {
      const npvx = pvx - (1 + RESTITUTION) * velN * nx;
      const npvy = pvy - (1 + RESTITUTION) * velN * ny;
      player.pSpeed = npvx * pCos + npvy * pSin;
      const impact = Math.min(1, -velN / MAX_SPEED);
      if (impact > bestImpact) { bestImpact = impact; bestDx = dx; bestDy = dy; }
    }
  }

  // (3) DAMAGE / SOUND / FLASH — same cooldown discipline as traffic.
  if (bestImpact >= 0 && damageAllowed) {
    player.fuel = Math.max(0, player.fuel - FUEL_PENALTY_MAX * bestImpact);
    player.collisionFlash = FLASH_DURATION;
    if (life) {
      const zone = classifyHitZone(bestDx, bestDy, pCos, pSin, pHl, pHw);
      applyZoneDamage(life, zone, bestImpact * 30, bestImpact * 4);
    }
    return { impact: bestImpact };
  }
  return null;
}

/** Collide the PLAYER's hitched trailer against the traffic pool — the
 *  monolith's "TRAILER COLLISION ZONES" block (L27946-L28007). The cab's
 *  own OBB is already handled by [[tickTrafficCollisions]]; this adds the
 *  trailer body the cab is towing.
 *
 *  DRIVE-UNDER RULE: low "racer" traffic (anything not in
 *  [[TRAILER_TALL_BODY_TYPES]]) passes UNDER the trailer deck and only
 *  collides with the rear-tandem axle + front-kingpin zones; tall traffic
 *  (suv / pickup / truck) hits the full body too. See
 *  [[trailerVsVehicle]].
 *
 *  Traffic cars are spline-bound, so the escape push lands in the H824
 *  knockback offset (kx/ky) — same mechanism [[tickTrafficCollisions]]
 *  uses — plus an immediate px/py nudge so the gap renders this frame,
 *  and the car's forward motion is zeroed (it can't roll through the
 *  tires/kingpin). Mirrors the monolith's `t.x/t.y` push + `t.speed=0`
 *  stop at L27991-L28002.
 *
 *  No-op when the player has no trailer hooked. Call AFTER tickTraffic
 *  (so traffic poses are current for this frame). */
export function tickPlayerTrailerTrafficCollision(
  player: PlayerState,
  traffic: TrafficCar[],
  life?: LifeState | null,
): void {
  const tr = life?.trailer;
  if (!tr) return;
  const { fwX, fwY } = computeFifthWheelPivot(player.px, player.py, player.pAngle);
  for (const car of traffic) {
    // Per-z filter — a trailer on a different deck level can't hit a car
    // below/above it (mirrors tickTrafficCollisions' roadZ gate).
    if (car.roadZ !== player.layerZ) continue;
    const bodyType = spriteFileToBodyType(car.spriteFile);
    const tSize = TRAFFIC_BODY_SIZES[bodyType] ?? DEFAULT_TRAFFIC_SIZE;
    const isRacer = !TRAILER_TALL_BODY_TYPES.has(bodyType);
    const push = trailerVsVehicle(
      fwX, fwY, tr.angle, tr.length, tr.width,
      car.px, car.py, tSize[0] / 2, tSize[1] / 2, isRacer,
    );
    if (!push) continue;
    car.kx += push.pushX;
    car.ky += push.pushY;
    car.px += push.pushX;
    car.py += push.pushY;
    car.kvx = 0;
    car.kvy = 0;
    car.speed = 0;
    // 2s brake hold (decremented in tickTraffic) — clean stop instead of a
    // per-frame re-zero shudder. Monolith t.stopTimer=2.0 at L28001.
    car._trailerStopTimer = 2.0;
  }
}
