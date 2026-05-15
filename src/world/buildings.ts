/**
 * Building registry — lookup by tile coords + I-277 polygon inside test.
 *
 * Ported from monolith L17388-17430 + the building generation logic at
 * world preprocess time. The registry is built once at world init and
 * read by both the ground-tile renderer and the collision system.
 *
 * SCAFFOLD status: types + entry signatures; bodies stubbed.
 */

/** Building tile palette + identity. Each 4×4 building footprint
 *  shares one BuildingTile so renderers don't re-randomize per tile. */
export interface BuildingTile {
  /** Color palette — pal[0] is the floor tile fill. */
  pal: readonly string[];
  /** True if this building blocks vehicle motion. */
  collidable: boolean;
  /** Per-tile-block stable seed (used for windows, roof details). */
  seed: number;
}

/** Returns the BuildingTile at the given wrapped tile coords. */
export function getBldg(_wtx: number, _wty: number): BuildingTile {
  // TODO(C24-followup): port from monolith L17389. Looks up the per-block
  // building entry (bx=Math.floor(wtx/4), by=Math.floor(wty/4)) and
  // applies the palette + seed.
  return { pal: ['#333'], collidable: true, seed: 0 };
}

/** True if the (wtx, wty) tile coord is inside the I-277 polygon
 *  (downtown ring). Tiles inside the ring use the urban building palette
 *  instead of suburban grass. From monolith L17398. */
export function isInsideI277(_wtx: number, _wty: number): boolean {
  // TODO(C24-followup): port the polygon-inside test.
  return false;
}
