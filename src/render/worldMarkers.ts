/**
 * World-space navigation markers — home and player-placed carPins.
 *
 * Painted inside the world camera transform alongside the H203
 * job markers. Both gated on player-within-TILE*80 culling so they
 * only draw when the player is in render range.
 *
 *   - drawHomeMarker: cyan disc + 'H' label at LIFE.homeX/Y. Solid
 *     0.7 alpha (no blink — distinguishes from the blinking A/B
 *     job markers).
 *   - drawCarPinsWorld: the listed car, actually parked, with a
 *     colored label disc floating above it.
 *
 * 1:1 port of monolith L32712-32722 (home) and L50310-50345 (pins).
 *
 * H1262 — THE CAR IS A REAL CAR NOW, AND IT PARKS.
 *
 * Two bugs, reported together: "I used the Newspaper to view a car, but there
 * is no car sprite visible in the world... Parked (preferably off the road, or
 * in a driveway)."
 *
 *   1. The silhouette was a flat 20x8 `#888` rect — a grey rectangle on grey
 *      asphalt, which at night read as a road smudge rather than a car. It was
 *      always meant to be temporary (the old header called the real render "a
 *      small follow-up that needs a static preview-deps factory"). That
 *      factory exists: trafficDrawDeps in render/traffic.ts. So the pin now
 *      goes through drawTopCar with a snapshot built from the listing's own
 *      catalog row, which means the car's REAL sprite when one is baked, and
 *      drawTopCar's own vector/X-ray fallback when it isn't — the user's
 *      "if a car sprite is not available, the x-ray version should be
 *      displayed".
 *   2. The pin's world coords come from randomRoadPos, which returns a ROAD
 *      TILE CENTRE — so the listing sat in the middle of the carriageway (on a
 *      six-lane highway, in the reported case). parkedPose walks out
 *      perpendicular to the road until it finds ground that isn't road and
 *      parks there, nosed along the road like a parked car.
 *
 * Both the pose and the sprite resolve lazily on first draw and cache on the
 * pin, so this also fixes listings already sitting in old saves.
 */

import { TILE } from '@/config/world/tiles';
import { CAR_CATALOG } from '@/config/cars/catalog';
import { GT4_SPECS } from '@/config/cars/gt4Database';
import { SPRITE_BUFFER } from '@/config/cars/spriteBuffer';
import { getVehicleSprite, hasVehicleSprite } from '@/engine/sprites';
import { drawTopCar } from '@/render/carBody';
import { nearestRoadAngleAt } from '@/render/worldMap';
import { isOnRoad, type TileMap } from '@/world/tileMap';
import type { LifeState, CarPin } from '@/state/life';

const RENDER_RADIUS_PX = TILE * 80;
const HOME_CIRCLE_R = TILE * 1.2;

/** How far past the road edge the car sits, in tiles. Enough to be clearly
 *  off the carriageway without floating out in a field. */
const SHOULDER_CLEARANCE_TILES = 0.9;
/** Give up looking for the verge after this far — a wide junction or a plaza
 *  can read as road for a long way, and a car parked 8 tiles out is worse than
 *  one left where the listing put it. */
const MAX_SHOULDER_SEARCH_TILES = 8;

/** Cyan 'H' disc at the home tile center. No blink — distinguishes
 *  from the blinking A/B job markers (H203). 1:1 with monolith
 *  L32713-32722. */
export function drawHomeMarker(
  ctx: CanvasRenderingContext2D,
  life: LifeState,
  px: number,
  py: number,
): void {
  const hx = life.homeX * TILE + TILE / 2;
  const hy = life.homeY * TILE + TILE / 2;
  const dx = px - hx;
  const dy = py - hy;
  if (dx * dx + dy * dy >= RENDER_RADIUS_PX * RENDER_RADIUS_PX) return;
  ctx.fillStyle = 'rgba(0, 255, 255, 0.7)';
  ctx.beginPath();
  ctx.arc(hx, hy, HOME_CIRCLE_R, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#000';
  ctx.font = 'bold ' + (TILE * 0.9) + 'px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('H', hx, hy + TILE * 0.35);
  ctx.textAlign = 'left';
}

/**
 * H1262: where the car actually sits, given a pin dropped on the road.
 *
 * Takes the road's own heading at the pin, then steps perpendicular in BOTH
 * directions looking for the nearest tile that isn't road, and parks
 * SHOULDER_CLEARANCE_TILES beyond that edge, nosed along the road. Trying both
 * sides matters: a pin on the inside lane of a divided highway has its nearest
 * verge one way and a median the other.
 *
 * Falls back to the pin's own coords (and a deterministic angle) when there is
 * no road geometry nearby or no verge within reach — a car in the road is
 * wrong, but a car nowhere is worse.
 *
 * Exported for headless verification.
 */
export function parkedPose(
  map: TileMap | null,
  worldX: number,
  worldY: number,
): { x: number; y: number; angle: number } {
  const roadAng = nearestRoadAngleAt(worldX, worldY);
  // No road nearby: keep the old deterministic-from-coords angle so the car
  // at least doesn't swivel between frames.
  if (roadAng == null || !map) {
    return { x: worldX, y: worldY, angle: (worldX * 7 + worldY * 13) % 6.28 };
  }
  const px = -Math.sin(roadAng);
  const py = Math.cos(roadAng);
  const step = TILE * 0.5;
  const maxSteps = Math.ceil((MAX_SHOULDER_SEARCH_TILES * TILE) / step);
  for (let i = 1; i <= maxSteps; i++) {
    for (const side of [1, -1]) {
      const tx = worldX + px * side * step * i;
      const ty = worldY + py * side * step * i;
      if (isOnRoad(map, tx, ty)) continue;
      // Found the verge on this side — clear the edge and settle.
      const clear = SHOULDER_CLEARANCE_TILES * TILE;
      return {
        x: tx + px * side * clear,
        y: ty + py * side * clear,
        angle: roadAng,
      };
    }
  }
  // Road all the way out to the search limit. Stay put, but at least lie
  // along the road rather than across it.
  return { x: worldX, y: worldY, angle: roadAng };
}

/** DrawTopCarDeps for a parked listing. Mirrors trafficDrawDeps, but the
 *  snapshot is built per-pin from the listing's catalog row so the real car
 *  renders rather than a generic body type. */
function pinCarDeps(car: { name: string; color: string; size: readonly [number, number]; isBike: boolean }) {
  return {
    player: {
      name: car.name,
      color: car.color,
      size: car.size,
      isBike: car.isBike,
      isReverse: false,
      steerAngle: 0,
      leftHeadlightOut: false,
      rightHeadlightOut: false,
      leftTaillightOut: false,
      rightTaillightOut: false,
      // Sprite first; drawTopCar falls through to its vector / X-ray body on
      // its own when the sprite for this car was never baked.
      xrayBody: false,
    },
    hour: 12,
    getVehicleSprite,
    hasVehicleSprite,
    spriteBuffer: SPRITE_BUFFER,
    gt4Lookup: (n: string) => GT4_SPECS[n],
  };
}

/** For each carPin within render range, paints the listed car parked on the
 *  shoulder + a blinking color-coded label disc floating above it.
 *  Suppresses the pin when the sellerVisit is in menu/testdrive
 *  phase AND its source pin matches this one — the player can't
 *  also see the pin while inside its seller flow (1:1 with monolith
 *  L50317-50318 guard).
 *
 *  CarPin.listing is unknown at the type level — we cast through to
 *  { id?: string } so the renderer can resolve the catalog row. Listings
 *  without a recognized id fall back to a generic sedan body (the label disc
 *  is still useful navigation even if the car art is generic). */
export function drawCarPinsWorld(
  ctx: CanvasRenderingContext2D,
  life: LifeState,
  px: number,
  py: number,
  /** H1262: needed to find the road edge to park against. Omitted → the car
   *  stays on the pin coords (the pre-H1262 behaviour). */
  map?: TileMap | null,
): void {
  if (!life.carPins || life.carPins.length === 0) return;
  const blink = Math.sin(Date.now() * 0.006) > 0;
  const svPin = life.sellerVisit
    && (life.sellerVisit.phase === 'menu' || life.sellerVisit.phase === 'testdrive')
    ? (life.sellerVisit as { _fromPin?: CarPin })._fromPin
    : null;

  for (const pin of life.carPins) {
    const dx = px - pin.worldX;
    const dy = py - pin.worldY;
    if (dx * dx + dy * dy >= RENDER_RADIUS_PX * RENDER_RADIUS_PX) continue;
    if (svPin === pin) continue; // pin is inside its own seller visit

    // Resolve catalog entry from the listing id (when present).
    const listing = pin.listing as { id?: string } | undefined;
    const car = listing?.id ? CAR_CATALOG[listing.id] : undefined;

    // Solve the parked pose once, then cache on the pin — the walk is a
    // handful of tile lookups but it must not run per-frame per-pin, and the
    // car must not shuffle around as the player approaches.
    if (pin._parkX == null || pin._parkY == null || pin._parkAngle == null) {
      const pose = parkedPose(map ?? null, pin.worldX, pin.worldY);
      pin._parkX = pose.x;
      pin._parkY = pose.y;
      pin._parkAngle = pose.angle;
    }
    const cx = pin._parkX;
    const cy = pin._parkY;
    const ang = pin._parkAngle;

    // The real car. Sprite when one is baked for it, drawTopCar's own
    // vector / X-ray body when not.
    const snap = {
      name: car?.name ?? 'Sedan',
      color: car?.color ?? '#888',
      size: car?.size ?? ([28, 11] as const),
      isBike: !!car?.isBike,
    };
    drawTopCar(
      ctx,
      {
        cx, cy, angle: ang, color: snap.color,
        isPlayer: true, steerAngle: 0, isBraking: false,
      },
      pinCarDeps(snap),
    );

    // Label disc floating above the car. Blinks the pin color
    // between 0.45 (off) and 0.85 (on) alpha. Label text in #000
    // at TILE*1.0 monospace. 1:1 with monolith L50335-50342.
    ctx.save();
    ctx.globalAlpha = blink ? 0.85 : 0.45;
    ctx.fillStyle = pin.color;
    ctx.beginPath();
    ctx.arc(cx, cy - TILE * 2.5, TILE * 1.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#000';
    ctx.font = 'bold ' + (TILE * 1.0) + 'px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(pin.label, cx, cy - TILE * 2.1);
    ctx.textAlign = 'left';
    ctx.restore();
  }
}
