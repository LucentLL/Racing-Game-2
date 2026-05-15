/**
 * Full-screen city map overlay — toggled by the minimap tap (F key on
 * desktop) when no menu/modal is up.
 *
 * v8.99.36 fix: centers on the CITY bounding box (MAP_W/2, MAP_H/2),
 * NOT the player. The minimap centers on the player; this view is the
 * "see the whole town" view, so when the player stands at one edge of
 * the city, the city stays anchored and the player dot moves with them
 * instead of the city sliding off-screen. Auto-fit scale uses 1.05×
 * padding so labels at the city edges don't clip.
 *
 * Tap-to-close is handled by the router (any tap while fullMapOpen
 * just sets fullMapOpen=false — see ui/router.ts L21730). This module
 * is pure render.
 *
 * Layered content (back to front):
 *   - background fillRect (full canvas including HUD_OFFX translation)
 *   - majorRoads polylines (color-coded by road class)
 *   - gas stations (G dots — small, drawn first to sit under H/W/A/B/F)
 *   - LIFE.carPins (colored dots with pin.label)
 *   - W = office (when LIFE.playerJob === 'OFFICE JOB')
 *   - H = home, A/B = job pickup/dropoff, F = race finish
 *   - player dot (always on top, at the player's actual city position)
 *   - bottom legend strip (76 px)
 *
 * All HUD elements ABOVE the map are suppressed by `!fullMapOpen` gates
 * elsewhere in render() — this overlay owns the screen while it's up.
 *
 * Ported from monolith L34010-end of full-map block.
 *
 * SCAFFOLD status: type contract + entry point stubbed with TODO line
 * refs.
 */

import type { PlacedPin } from '../modals/pinPicker';

/** Per-frame inputs for the full-map render. */
export interface FullMapOpts {
  /** Player world position (drives the player dot only — NOT centering). */
  px: number;
  py: number;
  /** City extents in tiles. Anchors the center-on-city transform. */
  MAP_W: number;
  MAP_H: number;
  /** Tile size in world units. */
  TILE: number;
  /** Major roads to project. */
  majorRoads: Array<{ pts: number[][]; name?: string; maj?: boolean }>;
  /** Gas station markers. */
  gasStations: Array<{ cx: number; cy: number }>;
  /** Player-placed pins. */
  carPins: PlacedPin[];
  /** Home tile, if the player has bought/rented (drives H marker). */
  homeTileX: number | null;
  homeTileY: number | null;
  /** Office tile, if LIFE.playerJob === 'OFFICE JOB'. */
  officeTileX: number | null;
  officeTileY: number | null;
  /** Active job pickup / dropoff (LIFE.jobActive). */
  jobPickupTileX: number | null;
  jobPickupTileY: number | null;
  jobDropoffTileX: number | null;
  jobDropoffTileY: number | null;
  /** Race finish (RACE.finishX/Y in world coords) when active. */
  raceFinishX: number | null;
  raceFinishY: number | null;
  /** HUD offset for the full-canvas background fill (HUD_OFFX). */
  HUD_OFFX: number;
  /** Canvas internal width / height. */
  GW: number;
  GH: number;
  WORLD_GW: number;
}

/** Draws the full-screen map: background + roads + markers + player +
 *  legend strip. Pure render — input is handled by the router (any tap
 *  closes). TODO(D32-followup): port from L34010+. */
export function drawFullMap(
  _ctx: CanvasRenderingContext2D,
  _opts: FullMapOpts,
): void {
  // TODO: L34010+. Center-on-city transform: tileToX(t) = mapCX +
  // (t - MAP_W/2) * fmScale; same for Y. fmScale =
  // min(mapW/(MAP_W*1.05), mapH/(MAP_H*1.05)). Legend strip 76 px at
  // bottom; map area is everything above (mapTop=4, mapBot=GH-80).
}
