/**
 * H1178 — the ONE crossing width model.
 *
 * Before this module, junction geometry had two disagreeing detectors:
 * the H788 junction-box quad sized itself from lane-standardized
 * asphalt widths (worldMap getLaneGeom / laneStandardizedWidth) while
 * the crosswalk/stop-bar painter sized from RAW row tiles (w × 0.42) —
 * so on w5 minors (whose painted asphalt is only 2.55 t wide) the
 * decals floated past the pavement onto grass, and on w6 collectors
 * they cut inside the bare-asphalt box. Everything here is shared by
 * worldMap (box quad), crosswalks (decals), and roadCrossings (leg
 * existence) so the three can never disagree again.
 *
 * No per-frame work: all consumers call these at rebuild / module-init
 * time, or on a handful of culled crossings.
 */

import { TILE } from '@/config/world/tiles';

/** US-DOT standard lane width (12 ft @ ~9.4 ft/tile). Mirrors monolith
 *  L18602 LANE_W_STD. Used by inner-edge stripe geometry to derive
 *  median half-width from lane-count + median-fraction config. */
export const LANE_W_STD = 1.275;

/** Obliquity floor shared by the box quad and the decal offsets: a
 *  1/sinθ projection is clamped so a near-parallel graze (<30°) can't
 *  blow the junction footprint out to kilometer scale. The painter
 *  historically clamped at 0.4 while the box used 0.5 — unified at the
 *  box's 0.5 so decals and box agree at oblique crossings. */
export const CROSSING_SIN_CLAMP = 0.5;

/** The box quad's breathing room past the pavement half-width (H788:
 *  `alongHalf * 1.15`). Decal offsets ride the same factor so bands
 *  land just outside the bare-asphalt box instead of inside it. */
export const CROSSING_BOX_MARGIN = 1.15;

/** World-px gap between the box edge and the crosswalk band so the
 *  band never touches the bare-asphalt quad. */
export const CROSSING_DECAL_PAD_PX = 2;

/** H677: quick-fallback total asphalt width (tiles) when an entry's
 *  cached `laneGeom` isn't available (editor preview path during
 *  drag-edits). Computes a getLaneGeom-equivalent asphaltW without
 *  the dividerOffsets / wear / oil arrays, so call sites that only
 *  need the width can stay cheap. (H1178: moved verbatim out of
 *  worldMap so world/roadCrossings + render/crosswalks can share it
 *  without importing the 5k-line worldMap.) */
export function laneStandardizedWidth(name: string, w: number): number {
  let lps: number;
  let medFrac: number;
  let isDivided: boolean;
  if (name === 'I-485') {
    lps = 3; medFrac = 0.25; isDivided = true;
  } else if (w === 11) {
    // H995: user "divided · asphalt median" preset (Lanes → Split·A). Real
    // paved median between the carriageways, NO grass, NO jersey barrier —
    // asphalt shows between the flanking yellow stripes.
    lps = 3; medFrac = 0.22; isDivided = true;
  } else if (w === 10) {
    // H995: user "divided · grass median" preset (Lanes → Split·G), same
    // median geometry as baseline I-485.
    lps = 3; medFrac = 0.25; isDivided = true;
  } else if (w >= 12) {
    lps = 4; medFrac = 0.02; isDivided = true;
  } else if (w >= 8) {
    lps = 3; medFrac = 0; isDivided = false; // H1200: undivided 6-lane, no phantom median
  } else if (w >= 6) {
    lps = 2; medFrac = 0;    isDivided = false;
  } else {
    lps = 1; medFrac = 0;    isDivided = false;
  }
  // H974: w===2 = the inherently one-way Lanes-1 road — one lane TOTAL
  // (lockstep with gameLoop's canonical getRoadProfile halving).
  const laneCount = (w === 2) ? lps : lps * 2;
  const carriageW = laneCount * LANE_W_STD;
  const medHalf = (medFrac > 0) ? carriageW * medFrac * 0.5 : 0;
  const totalW = carriageW + medHalf * 2;
  const shoulderW = isDivided ? 0.5 * LANE_W_STD : 0;
  return totalW + 2 * shoulderW;
}

/** Clamped |sin| of the angle between two crossing roads' tangents. */
export function crossingSinTheta(ang1: number, ang2: number): number {
  return Math.max(CROSSING_SIN_CLAMP, Math.abs(Math.sin(ang1 - ang2)));
}

/** Half of a road's PAINTED asphalt in world px — the true curb line,
 *  as opposed to the raw row half-width (w/2 tiles) which over-reads
 *  minors (w5 paints 2.55 t of asphalt, not 5 t). */
export function asphaltHalfPx(name: string, w: number): number {
  return laneStandardizedWidth(name, w) * 0.5 * TILE;
}

/** Distance (world px) from the crossing point, measured ALONG a road,
 *  at which that road's crosswalk band sits: the PEER road's asphalt
 *  half-width stretched by obliquity (the peer's footprint projects to
 *  half/sinθ along us), pushed out by the box quad's 1.15 margin plus
 *  a 2-px pad — i.e. just outside the junction box's bare asphalt.
 *  Identical constants to the H788 quad, so bands frame the box.
 *
 *  KNOWN RESIDUAL (accepted, pre-existing behavior was worse): below
 *  the clamp (~<28° crossings, sinθ true < 0.5) the LATER-painted
 *  road's band can sit up to ~7 px inside the quad's ACROSS face
 *  (which uses 1.1×half with NO 1/sinθ stretch, worldMap ~3538) —
 *  this offset is a projection along ONE road, not a true box-exit
 *  distance min(al/|cosθ|, ac/|sinθ|). No baseline crossing is that
 *  acute (sharpest = 30.9°); the stage-3 marking-exclusion pass
 *  (markGaps) needs the real box-exit helper and fixes this family. */
export function crossingDecalOffset(peerName: string, peerW: number, sinTheta: number): number {
  return (laneStandardizedWidth(peerName, peerW) * 0.5 * CROSSING_BOX_MARGIN / sinTheta) * TILE
    + CROSSING_DECAL_PAD_PX;
}
