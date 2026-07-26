/**
 * H1267: START/FINISH LINE + STARTING-GRID geometry — ONE source of truth.
 *
 * The user's report was that the race tracks have no start/finish line and no
 * indicator lines for starting positions. H1249 did emit a "Starting grid", but
 * as a PARKING LOT polygon whose placement search (mapRegistry mkGrid) required
 * `trackClearance >= TRACK_HALF_TILES + 0.3` = 2.9 tiles from the centerline —
 * while the w=6 race surface is only 2.55 tiles half-width. By construction it
 * could only ever land on the grass verge BESIDE the track, where it rendered
 * as a pale slab with perpendicular parking stripes and two tree planters. So
 * there has never been a marking on the racing surface itself.
 *
 * This module is deliberately a CONFIG leaf: both `render/startGrid` (which
 * paints the boxes) and `sim/trackRace` (which parks cars in them) import it,
 * so the paint and the grid can never drift apart. Everything is in TILES;
 * multiply by TILE for world px.
 *
 * Layout follows the user's reference photos (Nürburgring start/finish and the
 * pixel-art strip): a checkered band across the full pavement, then two
 * STAGGERED columns of white L-corner boxes behind it — the left column half a
 * pitch ahead of the right, which is what makes a real grid read as a grid
 * rather than as rows of parked cars.
 */

/** US-DOT standard lane width in tiles. Mirrors LANE_W_STD in
 *  render/roads/crossingGeom — duplicated as a literal (rather than imported)
 *  because config is a leaf: render/sim import config, never the reverse. */
export const LANE_W_STD_T = 1.275;

/** Lateral offset of a grid column from the centerline, in tiles.
 *  0.75 lanes = 0.956 t = 17.2 world px, so the two columns sit 34.4 px apart —
 *  a full car width — and both stay inside the 2.55-tile half-pavement of a w=6
 *  race surface. This is the SAME number spawnCircuitGrid used before H1267
 *  (`0.75 * LANE_W_STD_T`), kept so existing grid spacing is unchanged. */
export const GRID_LANE_T = 0.75 * LANE_W_STD_T;

/** Longitudinal pitch between consecutive grid SLOTS, in tiles. Slots
 *  alternate columns, so the pitch within one column is 2× this (5.5 t = 15.8 m,
 *  the H1245 GRID_ROW_TILES). 2.75 t = 7.89 m of stagger, within 1.5% of the
 *  real 8 m F1 slot offset. */
export const GRID_SLOT_PITCH_T = 2.75;

/** Distance from the start/finish line back to the POLE box's centre (tiles).
 *  The box is 2.6 t long, so its leading edge sits 0.9 t (2.6 m) behind the
 *  line — cars nose up to the line without straddling it. */
export const GRID_FIRST_T = 2.2;

/** Painted box footprint (tiles). A car body is ~1.57 t long × 0.63 t wide, so
 *  this leaves ~1.5 m front/rear and ~1 m either side. */
export const GRID_BOX_LEN_T = 2.6;
export const GRID_BOX_WID_T = 1.10;

/** Length of each arm of the L-shaped corner bracket (tiles). */
export const GRID_BRACKET_ARM_T = 0.5;
/** Bracket stroke thickness in WORLD PX (paint is a fixed real width, it does
 *  not scale with the road). ~0.35 m, a wide road-marking line. */
export const GRID_BRACKET_PX = 2.2;

/** How many painted slots a circuit grid gets. CIRCUIT_FIELD is 5 AI + the
 *  player = 6; 8 boxes leaves room for the field to grow (the pit RACE SETUP
 *  panel is meant to expose field size) without a second geometry pass. */
export const GRID_SLOTS = 8;

/** Drag strip: lane centre offset in tiles. Matches mapRegistry LANE_HALF and
 *  the rival placement in trackRace (`(startTile[0] ± LANE_HALF) * TILE`), so a
 *  staged car sits inside its painted box. */
export const DRAG_LANE_T = 0.64;
/** Drag staging box: shorter offset (you stage right up to the beams) and a
 *  narrower box, because the strip is only 2.55 t of pavement total. */
export const DRAG_FIRST_T = 1.9;
export const DRAG_BOX_WID_T = 0.90;
/** Pre-stage bracket pair, one car length further back. */
export const DRAG_PRESTAGE_T = 3.6;

/** Depth of a checkered start/finish band along the track, in tiles.
 *  1.05 t = 3.0 m — two rows of ~1.5 m squares, the real thing. */
export const START_BAND_DEPTH_T = 1.05;
/** Depth of a SOLID painted line (the drag strip's start line), in tiles.
 *  0.35 t = 1.0 m. */
export const START_LINE_DEPTH_T = 0.35;

/** One grid slot: how far BEHIND the start/finish line its centre sits, and
 *  which side of the centerline it is on.
 *
 *  Slot 0 (pole) takes the negative lane and the shortest setback; odd slots
 *  take the positive lane. Because the setback grows by GRID_SLOT_PITCH_T per
 *  slot rather than per row, consecutive slots alternate sides AND step back —
 *  which is exactly the staggered two-column grid in the reference photos. */
export function gridSlot(k: number): { backT: number; laneT: number } {
  return {
    backT: GRID_FIRST_T + k * GRID_SLOT_PITCH_T,
    laneT: (k % 2 === 0 ? -1 : 1) * GRID_LANE_T,
  };
}

/** Drag strip: the two staging boxes, side by side on the line. Slot 0 is the
 *  LEFT lane — where switchMap spawns the player (spawnTile x = centre −
 *  LANE_HALF) — and slot 1 the right, where trackRace stages the rival. */
export function dragSlot(k: number): { backT: number; laneT: number } {
  return { backT: DRAG_FIRST_T, laneT: (k === 0 ? 1 : -1) * DRAG_LANE_T };
}
