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
 * On hit (same effects as before):
 *   - player.pSpeed *= COLLISION_SLOW
 *   - player.fuel -= FUEL_PENALTY * impact
 *   - traffic car's `t` jumps forward FLEE_T_BUMP
 *   - player.collisionFlash = FLASH_DURATION (doubles as cooldown)
 *   - life.bodyDamage accrues on the impact zone (H597)
 */

import type { PlayerState } from '@/state/player';
import type { TrafficCar } from '@/state/traffic';
import type { LifeState } from '@/state/life';
import type { CatalogCar } from '@/config/cars/catalog';
import { BASELINE_ROADS } from '@/config/world/baselineRoads';
import { classifyHitZone, applyZoneDamage } from '@/sim/faults';
import { TRAFFIC_BODY_SIZES } from '@/render/carBody/drawTopCar';
import { spriteFileToBodyType } from '@/render/traffic';

const COLLISION_SLOW = 0.4;            // pSpeed *= COLLISION_SLOW
const FUEL_PENALTY_MAX = 0.03;         // max fuel cost per heavy bump
const FLEE_T_BUMP = 0.04;              // shove the traffic car forward along its road
const FLASH_DURATION = 0.5;            // seconds the flash stays > 0
const MAX_SPEED = 200;                 // mirrors arcadeUpdate's MAX_SPEED

/** Fallback body size when no CatalogCar / bodyType lookup resolves —
 *  matches V2_PLAYER_SIZE in render/playerCar.ts. */
const DEFAULT_PLAYER_SIZE: readonly [number, number] = [22, 8];
const DEFAULT_TRAFFIC_SIZE: readonly [number, number] = [20, 8];

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

/** SAT: do two oriented boxes overlap? Tests the 4 edge normals
 *  (2 per box). For axis-aligned-ish or arbitrarily rotated 2D
 *  rectangles, those 4 axes are necessary and sufficient. */
function obbIntersects(
  ax: number, ay: number, aAng: number, aHl: number, aHw: number,
  bx: number, by: number, bAng: number, bHl: number, bHw: number,
): boolean {
  const aCa = Math.cos(aAng), aSa = Math.sin(aAng);
  const bCa = Math.cos(bAng), bSa = Math.sin(bAng);
  const axes: ReadonlyArray<readonly [number, number]> = [
    [aCa,  aSa],   // A's length axis
    [-aSa, aCa],   // A's width axis
    [bCa,  bSa],   // B's length axis
    [-bSa, bCa],   // B's width axis
  ];
  for (const [axX, axY] of axes) {
    const [aMin, aMax] = projectOBB(ax, ay, aHl, aHw, aCa, aSa, axX, axY);
    const [bMin, bMax] = projectOBB(bx, by, bHl, bHw, bCa, bSa, axX, axY);
    if (aMax < bMin || bMax < aMin) return false;   // separating axis found
  }
  return true;
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
  // Cooldown: skip collision detection while still flashing.
  if (player.collisionFlash > FLASH_DURATION * 0.5) return null;

  const pSize = playerCar?.size ?? DEFAULT_PLAYER_SIZE;
  const pHl = pSize[0] / 2;
  const pHw = pSize[1] / 2;
  // Bounding-circle radius² for broad-phase reject. Using the box
  // half-diagonal guarantees no false-negative on the OBB test.
  const pDiag2 = pHl * pHl + pHw * pHw;

  let hit: CollisionEvent | null = null;
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
    // Broad-phase: if centers farther than (halfDiag_p + halfDiag_t),
    // the OBBs cannot possibly intersect. (sqrt(a²+b²) bound, applied
    // as (sqrt(pDiag2) + sqrt(tDiag2))² without the sqrts via the
    // identity x² + y² + 2·sqrt(x²·y²) ≥ above expansion.)
    const sumDiag = Math.sqrt(pDiag2) + Math.sqrt(tDiag2);
    if (d2 > sumDiag * sumDiag) continue;

    if (!obbIntersects(
      player.px, player.py, player.pAngle, pHl, pHw,
      car.px,    car.py,    car.pAngle,    tHl, tHw,
    )) continue;

    const impact = Math.min(1, player.pSpeed / MAX_SPEED);
    player.pSpeed *= COLLISION_SLOW;
    player.fuel = Math.max(0, player.fuel - FUEL_PENALTY_MAX * impact);
    car.t = Math.min(0.99, car.t + FLEE_T_BUMP);
    player.collisionFlash = FLASH_DURATION;
    if (life) {
      const impactDmg = impact * 30;
      const scrapeDmg = impact * 4;
      const pCos = Math.cos(player.pAngle);
      const pSin = Math.sin(player.pAngle);
      const zone = classifyHitZone(dx, dy, pCos, pSin, pHl, pHw);
      applyZoneDamage(life, zone, impactDmg, scrapeDmg);
    }
    hit = { impact };
    break;   // one collision per frame
  }
  void BASELINE_ROADS;
  return hit;
}
