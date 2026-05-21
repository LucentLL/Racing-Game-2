/**
 * Terrain-surface speed penalties + final-tick speed clamp. Three
 * effects fire after the gas/brake/coast dispatch decides the
 * gross delta to pSpeed:
 *
 *   1. OFF-ROAD GRASS DRAG — gentle drag when driving fast on grass
 *      / water-tile / forest. Calibrated as a nudge, not a wall —
 *      shoulders, briefly cutting a corner, etc. shouldn't stop the
 *      car cold. Gated on |pSpeed| > 8 so the player can creep onto
 *      grass to park.
 *
 *   2. DIRT / CANYON / EARTH-COLORED SOIL — speed bleed when above
 *      55% of top speed. Not a hard limit; the car keeps slowing
 *      below the threshold via this branch alone (no drag below).
 *      Matches the "dirt road maxes out around 60 mph" feel.
 *
 *   3. FINAL SPEED CLAMP — bound pSpeed to [-topSpeed*0.15, maxSpd]
 *      where maxSpd depends on surface (full on road, half on
 *      grass, ~35% on everything else). Reverse cap is symmetric
 *      across surfaces (the 15% reverse limit is engine-mechanical,
 *      not friction-bound).
 *
 * The grass-drag branch also fires a controller-rumble effect to
 * give haptic feedback that the player is off-pavement — exposed
 * via the optional `rumble` callback so headless tests / desktop-
 * keyboard users can drop the dep.
 *
 * Monolith source: inside update() at L24112-L24125.
 */

/** Subset of CAR() the terrain pass reads. */
export interface TerrainCar {
  /** Top speed in game units. */
  topSpeed: number;
  /** Off-road drag coefficient (game units per second²). Per-car
   *  property — heavier / less aerodynamic cars get higher values
   *  so dropping off-road feels more punishing in a truck than in
   *  a sports car. */
  offRoadDrag: number;
}

/** Whether the player is on each surface kind. Computed upstream by
 *  the tile-readback + nearest-road-cache logic; passed in here so
 *  the penalty function stays pure. */
export interface TerrainSurfaceState {
  onRoad: boolean;
  onGrass: boolean;
  /** Live tile value at the player's position. 12 / 14 / 16 trigger
   *  the dirt-canyon speed bleed. Other values pass through (handled
   *  by the upstream physics — water is grass-equivalent, etc.). */
  onTile: number;
}

/** Optional haptic-feedback callback. Fires once per grass-drag tick
 *  with ~30% probability — matches monolith's stochastic rumble at
 *  L24116. Caller wires this to the gamepad rumble API; absent on
 *  keyboard-only or test contexts. */
export type RumbleCallback = (
  /** Low-frequency intensity, 0..1. */
  low: number,
  /** High-frequency intensity, 0..1. */
  high: number,
  /** Duration in milliseconds. */
  durationMs: number,
) => void;

/** Speed threshold above which off-road grass drag fires (game
 *  units). Matches monolith L24113. */
export const GRASS_DRAG_MIN_SPEED = 8;

/** Off-road drag scale factor — applies a fraction of the car's
 *  full `offRoadDrag` per tick. The 0.3 factor (monolith L24115)
 *  tunes the penalty as a nudge not a wall — full would feel like
 *  driving through molasses. */
export const GRASS_DRAG_FACTOR = 0.3;

/** Rumble fire-rate for the grass-drag haptic effect — 30%
 *  probability per tick (monolith L24116). */
export const GRASS_RUMBLE_PROB = 0.3;

/** Dirt / canyon speed-bleed multiplier (per second). pSpeed shrinks
 *  by 80% over one second when on dirt and above the threshold —
 *  asymptotic decay toward the threshold. */
export const DIRT_DECAY_RATE = 0.8;

/** Dirt / canyon speed threshold — bleed fires only when pSpeed is
 *  above 55% of top speed (monolith L24119). Below this, the
 *  car just settles. */
export const DIRT_DECAY_THRESHOLD_FRACTION = 0.55;

/** Tile values that trigger the dirt-canyon speed bleed. 12 / 14 /
 *  16 — the dirt / canyon / soil family. Other off-road tiles
 *  (grass, water, forest) go through the GRASS branch instead. */
const DIRT_TILE_VALUES = new Set([12, 14, 16]);

/** Per-surface maxSpd multiplier for the final clamp.
 *
 *    onRoad  → topSpeed * 1.0   (full)
 *    onGrass → topSpeed * 0.5   (50%)
 *    other   → topSpeed * 0.35  (35% — water, building, etc.)
 *
 *  Reverse cap is hardcoded at 15% of topSpeed regardless of
 *  surface (the engine-mechanical reverse limit, not friction-
 *  bound). Per monolith L24124-L24125.
 */
function speedCapForSurface(surface: TerrainSurfaceState, topSpeed: number): number {
  if (surface.onRoad) return topSpeed;
  if (surface.onGrass) return topSpeed * 0.5;
  return topSpeed * 0.35;
}

/** Apply the terrain-surface speed penalties + final clamp.
 *
 *  Returns the new pSpeed. Caller assigns. Optional rumble
 *  callback fires inside the grass-drag branch when the player
 *  has a connected gamepad — caller passes `() => {}` (or omits)
 *  on keyboard-only.
 *
 *  PIPELINE:
 *    1. Grass drag       — only when onGrass AND |pSpeed| > 8.
 *                          Subtracts (offRoadDrag * 0.3) * dt in
 *                          the direction of motion. Fires rumble
 *                          stochastically (30% per tick).
 *    2. Dirt / canyon    — only when onTile ∈ {12, 14, 16} AND
 *                          |pSpeed| > 0.55 * topSpeed. Multiplies
 *                          pSpeed by (1 - 0.8 * dt) — exponential
 *                          decay toward the 55% threshold.
 *    3. Final clamp      — bound to [-topSpeed * 0.15, surfaceMax].
 *
 *  Ported 1:1 from monolith L24112-L24125.
 */
export function applyTerrainPenaltiesAndClamp(
  pSpeed: number,
  car: TerrainCar,
  surface: TerrainSurfaceState,
  dt: number,
  rumble?: RumbleCallback,
): number {
  let speed = pSpeed;

  // 1. Grass drag.
  if (surface.onGrass && Math.abs(speed) > GRASS_DRAG_MIN_SPEED) {
    const sign = speed > 0 ? 1 : -1;
    speed -= sign * car.offRoadDrag * GRASS_DRAG_FACTOR * dt;
    if (rumble && Math.random() < GRASS_RUMBLE_PROB) {
      rumble(0.08, 0.12, 30);
    }
  }

  // 2. Dirt / canyon / soil.
  if (
    DIRT_TILE_VALUES.has(surface.onTile) &&
    Math.abs(speed) > car.topSpeed * DIRT_DECAY_THRESHOLD_FRACTION
  ) {
    speed *= 1 - DIRT_DECAY_RATE * dt;
  }

  // 3. Final clamp.
  const maxSpd = speedCapForSurface(surface, car.topSpeed);
  return Math.max(-car.topSpeed * 0.15, Math.min(maxSpd, speed));
}
