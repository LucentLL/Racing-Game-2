/**
 * H8/H11/H52 world-map render — strokes baseline road polylines onto
 * the main canvas. Caller must have applied the camera translate.
 *
 * Per-major-road render passes:
 *   1. ASPHALT BAND — textured pattern (H43), full width.
 *   2. INNER BAND — narrower stroke (width - 2 tiles total) in a
 *      slightly lighter shade so the visible boundary reads as the
 *      shoulder edge stripe.
 *   3. LANE DIVIDERS (H52) — for majors with width >= 6 tiles, stroke
 *      one or two pairs of WHITE DASHED offset polylines at quarter
 *      and three-quarter widths. Real 4-6 lane highways get visible
 *      lane separators instead of one big gray ribbon.
 *   4. CENTERLINE — dashed yellow down the middle.
 *
 * Path offsetting is per-segment perpendicular (no bisector smoothing
 * at vertex joins) — at game zoom the small kinks at vertices are
 * invisible, and the simpler math means no degenerate cases at sharp
 * turns.
 *
 * Minors get pass 1 only (just the textured asphalt — residential
 * streets aren't striped in the monolith either).
 *
 * INTENTIONALLY simpler than the monolith's render() roads pass
 * (L30577-30738) — lane-aware wear paths (prof.wearOffsets,
 * prof.oilOffsets), auto-taper merges, and per-segment material
 * overrides all port later.
 */

import { BASELINE_ROADS, type BaselineRoadRow } from '@/config/world/baselineRoads';
import { TILE } from '@/config/world/tiles';
import { getAsphaltPattern, getRoadBaseColor } from './roadTextures';
import { rebuildBridgeStructures } from '@/world/bridgeRuntime';
import type { BridgeRoadFull } from '@/world/bridgeGeometry';
// H787: pure-geometry merge helpers shared with the editor render so
// committed merge rows draw the SAME one-lane asymmetric polygon
// in-game that the editor previews (H786). taper.ts has no DOM/state
// dependencies — it's polyline math only.
import {
  _weBuildTaperedMergeEdges,
  _computeMergeInnerDir,
  type InnerDirRoad,
} from '@/editor/merge/taper';
import { smoothFlatPolyline } from './pathSmoothing';
import { _weLoadBaselineEdits, _weLoadOverlayFromStorage } from '@/editor/storage';

/** H126: an entry in the unified render list — a BaselineRoadRow paired
 *  with its pre-smoothed Catmull-Rom polyline. Both baseline rows (with
 *  edits / deletes applied) and editor overlay rows funnel through this
 *  shape so the same strokeRoad pipeline renders them.
 *  H128: exported so the minimap bake reads the same data the main
 *  game-render canvas does. Both see Catmull-Rom smoothing + editor
 *  edits + overlay rows. */
export interface RenderEntry {
  row: BaselineRoadRow;
  smoothed: number[];
  /** H141: tile-coord points where this road's polyline crosses one of
   *  lower z. Computed by computeBridgePts() at rebuild time; consumed
   *  by drawBridgeOverlay() to draw concrete deck sections over the
   *  asphalt at the crossing. Undefined for non-elevated roads and for
   *  elevated roads that don't cross any lower road. */
  bridgePts?: ReadonlyArray<{ x: number; y: number }>;
  /** H275: bbox of the smoothed polyline in WORLD pixels (already
   *  multiplied by TILE) — let strokeRoad early-out for roads entirely
   *  outside the viewport. Mirrors monolith road._bbox + the per-road
   *  cull at L30559-L30577. Computed at rebuildRenderEntries time so
   *  there's zero per-frame cost. */
  bbox?: { minX: number; minY: number; maxX: number; maxY: number };
  /** H268: editor-set material override ('asphalt' | 'concrete'). When
   *  set, getAsphaltPattern uses this instead of the row-name fallback.
   *  Mirrors monolith road.material at L2760. */
  material?: 'asphalt' | 'concrete';
  /** H268: editor-set age override ('new' | 'old'). When set, getAsphaltPattern
   *  uses this instead of the hash-derived default. Mirrors monolith
   *  road.age at L2740. */
  age?: 'new' | 'old';
  /** H269: editor-set per-segment material/age overrides. `seg` indexes
   *  into entry.smoothed (i.e. seg ranges 0..smoothed.length/2 - 2).
   *  Missing entries fall through to the road-level material/age.
   *  Mirrors monolith road.materialOverrides at L15373. */
  materialOverrides?: ReadonlyArray<{
    seg: number;
    material?: 'asphalt' | 'concrete';
    age?: 'new' | 'old';
  }>;
  /** H281: T-junction zones on THIS road's polyline where another
   *  road's endpoint touches mid-segment. Populated by
   *  computeTeeJunctions during rebuildRenderEntries. Consumed (in
   *  H282) by the edge-stripe erase pass to gap the solid white fog
   *  line over each cross-street's pavement. Coords are in TILE space;
   *  segIdx indexes into the RAW polyline (polylinePoints(row)), NOT
   *  the smoothed array. Mirrors monolith road._teeJunctions at
   *  L19636-L19642. */
  teeJunctions?: ReadonlyArray<TeeJunction>;
  /** H283: auto-taper polygon at THIS road's start endpoint (raw
   *  polyline index 0). Populated by computeAutoTapers when this road
   *  joins a wider peer at its start — encodes the flared transition
   *  polygon used by H284's render pass to fill the asphalt gap +
   *  align edge stripes with the wider peer. Mirrors monolith
   *  road._autoTaperStart at L19384. */
  autoTaperStart?: AutoTaperMeta;
  /** H283: same shape for the end endpoint (raw polyline index N-1).
   *  Mirrors monolith road._autoTaperEnd at L19385. */
  autoTaperEnd?: AutoTaperMeta;
  /** H650: pre-built Path2D of the smoothed polyline in WORLD pixels —
   *  consumed by strokeRoad's asphalt fill. Eliminates the per-frame
   *  tracePath() polyline walk. Skipped on materialOverrides roads (they
   *  per-segment stroke with different colors). */
  mainPath?: Path2D;
  /** H650: pre-built Path2D per signed lane-divider offset (4 entries
   *  for a 2-lps road: ±off1; 6 for 3-lps; etc.). strokeRoadMarkings
   *  strokes each instead of re-calling tracePathOffset per frame. */
  dividerPaths?: Path2D[];
  /** H650: pre-built Path2D pair (outer ±edgeOff) for the white fog
   *  lines. Empty when w < 3 or edgeOff <= 0. */
  edgePaths?: Path2D[];
  /** H650: pre-built Path2D pair (inner ±innerOff) for divided-highway
   *  yellow inner-edge stripes. Empty for non-divided roads. */
  innerEdgePaths?: Path2D[];
  /** H650: pre-built Path2D of the smoothed polyline (centerline offset
   *  0) for the centerline, jersey barrier, and major-band passes —
   *  they all stroke the same path with different lineWidth/style. */
  centerPath?: Path2D;
  /** H651: cached raw polyline (tile coords, NOT smoothed) — replaces
   *  the per-call polylinePoints(row) allocation in the three nearest-
   *  road scans (playerSpeedLimitWpx / playerRoadInfoAt / playerLayerZAt).
   *  Same data polylinePoints would return; built once at rebuild and
   *  reused per frame. */
  rawPts?: ReadonlyArray<readonly [number, number]>;
  /** H652: cached LaneGeom for this entry (depends only on name + w,
   *  both fixed for the entry's lifetime). strokeRoadMarkings reads it
   *  every frame; pre-H652 it called getLaneGeom() which does string
   *  comparisons and arithmetic per call. */
  laneGeom?: LaneGeom;
  /** H791: true for editor-drawn overlay rows. Bridge-layer synthetic
   *  structures are restricted to these — baseline elevated roads keep
   *  render-only elevation (their road-level z predates the editor's
   *  z system and is unreliable for collision; see bridgeBlocked's
   *  v126.21 note). */
  fromOverlay?: boolean;
  /** H787: merge metadata decoded from the overlay row's mergeFlag
   *  (tens digit = mergeType, ones digit = mergeAlign — see
   *  editor/draft.ts _decodeMergeFlag). Present only on editor merge
   *  rows; both undefined on baseline + plain overlay roads. */
  mergeType?: number;
  mergeAlign?: number;
  /** H787: pre-built render geometry for merge rows — the same
   *  one-lane asymmetric polygon the editor draws (H786), baked to
   *  world-px Path2Ds at rebuild time. When present, strokeRoad
   *  renders fill + edge strokes and skips the standard full-width
   *  asphalt/marking pipeline (which would straddle the destination
   *  exactly like the pre-H786 editor bug). */
  mergePaths?: {
    fill: Path2D;
    outer: Path2D;
    inner: Path2D;
    /** True when an inner direction resolved (asymmetric render) —
     *  the inner edge strokes dashed, matching the editor. */
    asym: boolean;
  };
  /** H788: same-z road crossings where THIS entry paints later than
   *  the peer (paint order = post-sort array order). strokeRoad
   *  overpaints a plain-asphalt junction box aligned to the peer's
   *  tangent after this road's markings, so the intersection interior
   *  reads as bare pavement with both roads' markings breaking at the
   *  box edges (the peer's markings are already under this road's
   *  asphalt). Coordinates in tile units; tangent is the PEER road's
   *  unit direction at the crossing segment. */
  crossings?: Array<{
    x: number;
    y: number;
    tx: number;
    ty: number;
    /** Half-extent ALONG the peer tangent = this road's asphalt halfW. */
    alongHalf: number;
    /** Half-extent ACROSS the peer tangent = the peer's asphalt halfW. */
    acrossHalf: number;
  }>;
  /** H790: rounded end-caps for FREE road termini (endpoints not
   *  connected to any other same-z road). Butt caps stay correct for
   *  connected ends (flush against the peer's pavement — H286), but a
   *  road that simply ends in space showed a hard square slab edge.
   *  Each cap is a half-disc of asphalt beyond the endpoint plus a
   *  fog-line arc wrapping the end. World-px coords, outward angle. */
  endCaps?: Array<{ x: number; y: number; ang: number; halfWpx: number }>;
  /** H662: per-chunk Path2D + bbox subdivision for long roads. The
   *  per-entry bbox cull stops short for huge roads like I-485 whose
   *  bbox covers the whole city — once the entry passes that cull, the
   *  prior code stroked its full ~1000-sample smoothed polyline 60+
   *  times per frame (wear + oil + dividers + edges). Chunking splits
   *  the polyline into CHUNK_SAMPLES-sample pieces with per-chunk bbox
   *  + per-chunk Path2D per stripe; each frame only the chunks whose
   *  bbox intersects the viewport get stroked. Mirrors monolith
   *  preprocessRoadsForRender chunking at L18964-L19033. */
  chunks?: RoadChunk[];
}

/** H662: one chunk of a long road. Each chunk holds pre-built Path2Ds
 *  for every stripe pass the renderer needs (asphalt main, lane
 *  dividers, white edge fog lines, yellow inner-edge stripes for
 *  divided highways, wear and oil for majors). `dashLen` is the
 *  cumulative path length (world pixels) from the smoothed polyline's
 *  origin to this chunk's start — used as the base `lineDashOffset`
 *  for dashed strokes so the dash phase stays continuous across chunk
 *  boundaries. Mirrors monolith chunk record at L19025-L19030. */
export interface RoadChunk {
  bbox: { minX: number; minY: number; maxX: number; maxY: number };
  /** Smoothed polyline subset for this chunk (flat tile coords). Used
   *  by the tee-erase and lane-add fallbacks that still walk samples. */
  pts: number[];
  mainPath: Path2D;
  /** H771: single-Path2D unions across lanes/sides per pass. A GPU
   *  stroke call costs ~0.05-0.1 ms of raster regardless of path length
   *  (measured H771 — the 19-27 fps highway dips were ~250-330 stroke
   *  calls/frame, not pixel fill), so a multi-lane highway chunk
   *  issuing ~40 calls across the marking passes was the frame budget.
   *  Passes whose style/width/dash state is identical across lanes
   *  (solid wear/oil baselines, dividers, fog lines, inner edges)
   *  stroke ONE combined path instead — identical pixels, since dash
   *  phase resets per subpath exactly as it did per separate stroke. */
  dividerPathAll?: Path2D;
  edgePathAll?: Path2D;
  innerEdgePathAll?: Path2D;
  wearPathAll?: Path2D;
  oilPathAll?: Path2D;
  /** H783: the dashed wear/oil emphasis passes with the dash pattern +
   *  per-lane phase stagger pre-baked into the geometry (one subpath
   *  per dash, all lanes combined). Strokes solid — no setLineDash, no
   *  per-lane lineDashOffset loop — one call per chunk per pass. */
  wearDash2Path?: Path2D;
  oilDash2Path?: Path2D;
  /** H772: pre-baked subset path of just the segments within
   *  BRIDGE_R_TILES of any bridgePoint. Only present on elevated
   *  entries that have `bridgePts`. drawBridgeOverlay strokes this
   *  path 3× (shadow / rim / drive) instead of iterating segments
   *  + calling nearBridge() per-segment per-pass. Undefined when no
   *  segment in this chunk qualifies (the cull then skips the chunk). */
  bridgePath?: Path2D;
  /** Cumulative path length (world pixels) at this chunk's start. */
  dashLen: number;
}

/** H281: one T-junction zone on a through road. Built by
 *  computeTeeJunctions when another road's endpoint projects to the
 *  middle of one of this road's raw-polyline segments (within
 *  TOLERANCE_TILES perpendicular). `radius` is the arc-distance (tile
 *  units) the edge-stripe gap should extend on either side of the
 *  junction point — proportional to the through road's half asphaltW,
 *  clamped [1, 4] tiles so narrow roads still show a visible gap and
 *  highways don't gap their entire stripe. Mirrors monolith
 *  _teeJunctions record shape at L19636-L19642. */
export interface TeeJunction {
  /** Junction point in tile coords (perpendicular projection of the
   *  branch road's endpoint onto this road's segment). */
  x: number;
  y: number;
  /** Raw-polyline segment index on the through road (this entry). */
  segIdx: number;
  /** Parametric position along that segment, 0..1. Bounded
   *  [SEG_MIN_T, SEG_MAX_T] (~0.05..0.95) so true vertex joins are
   *  excluded — those are handled by the auto-taper pass, not the
   *  edge-erase pass. */
  t: number;
  /** Arc-distance radius of the erase zone (tile units). */
  radius: number;
}

/** H283: auto-taper polygon metadata at one endpoint of a road. Built
 *  by buildAutoTaperPolygon when a narrower road joins a wider peer
 *  at a shared vertex (within TAPER_RADIUS tiles). The polygon flares
 *  from `currentHalfW` at the interior end of the taper to `peerHalfW`
 *  at the joined endpoint, so the narrow road's asphalt visually
 *  widens to match the peer's at the junction.
 *
 *  outer / inner are the polygon EDGES in tile coords, ordered from
 *  sample[0] (joined endpoint) to sample[L-1] (taper interior).
 *  Polygon fill = outer + reversed-inner, closed.
 *
 *  outerStripe / innerStripe shadow outer/inner but offset INWARD by
 *  1.7/TILE (STRIPE_INSET) so the edge-stripe stroke endpoints align
 *  with each peer road's normal prof.edgeOffsets stripes (which are
 *  also inset 1.7 px). Without this inset the taper's edge stripe
 *  would end at peerHalfW while the wider road's stripe ends at
 *  peerHalfW - 1.7/TILE — a visible step at the junction (~4.7 px at
 *  zoom 50). Monolith fix at L10942-L10959 / v8.99.126.64. */
export interface AutoTaperMeta {
  outer: ReadonlyArray<readonly [number, number]>;
  inner: ReadonlyArray<readonly [number, number]>;
  outerStripe: ReadonlyArray<readonly [number, number]>;
  innerStripe: ReadonlyArray<readonly [number, number]>;
  /** H285: lane-addition dashed channelizing stripe samples (DOT MUTCD
   *  entrance-taper marking). Tile-coord polylines at the NARROW road's
   *  pre-taper edge offset (currentHalfW - 1.7/TILE) — i.e., where the
   *  edge stripe would have been if the road hadn't widened. Vehicles
   *  cross this line to enter the newly-added lane. Plus / Minus are
   *  the two sides. Optional — may be missing on very narrow roads
   *  where narrowEdgeOff <= 0.01. Mirrors monolith
   *  road._autoTaperStartLaneAddSamplesPlus / Minus at L19491. */
  laneAddPlus?: ReadonlyArray<readonly [number, number]>;
  laneAddMinus?: ReadonlyArray<readonly [number, number]>;
  taperLen: number;
  peerHalfW: number;
  currentHalfW: number;
}

/** H141: line-segment intersection — 1:1 port of monolith L9624-9631.
 *  Returns the intersection point if both segments cross strictly inside
 *  their parameter ranges (excludes endpoints). The 0.01 / 0.99 inner
 *  band keeps adjacent-segment shared-endpoint geometry from being
 *  reported as a "crossing." Coords are in tile space. */
function segHit(
  x1: number, y1: number, x2: number, y2: number,
  x3: number, y3: number, x4: number, y4: number,
): { x: number; y: number } | null {
  const d = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
  if (Math.abs(d) < 0.01) return null;
  const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / d;
  const u = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / d;
  if (t > 0.01 && t < 0.99 && u > 0.01 && u < 0.99) {
    return { x: x1 + t * (x2 - x1), y: y1 + t * (y2 - y1) };
  }
  return null;
}

/** H141: extract the original polyline (NOT smoothed) from a row as
 *  [[x,y], ...] tile-coord pairs. Bridge-pt computation matches the
 *  monolith by working on the raw polyline; the smoothed path is for
 *  rendering only and its curved insertions would produce false-positive
 *  intersections at near-tangent passings. */
function polylinePoints(row: BaselineRoadRow): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 4; i + 1 < row.length; i += 2) {
    out.push([row[i] as number, row[i + 1] as number]);
  }
  return out;
}

/** H141: bridge-crossing threshold radius. Monolith L30549 uses 20
 *  tiles — segments whose midpoint OR either endpoint lies within
 *  20 tiles of a crossing render as concrete bridge deck instead of
 *  asphalt. Generous radius so the deck extends visibly past the
 *  intersection point on both approaches. */
const BRIDGE_R_TILES = 20;

/** H141: bridge-deck side barrier width in tiles. Monolith L31147
 *  uses 0.2 tile = ~3.6px parapet on each side of the deck. The drive
 *  surface is the deck width minus 2× this on each side. */
const BRIDGE_BARRIER_W_TILES = 0.2;

/** H141: populate `bridgePts` on every elevated entry by scanning for
 *  crossings against every lower-z entry. 1:1 port of monolith L9634-
 *  9703 + L10401-10458 — runs Pass A (segment-segment intersection) and
 *  Pass B (polyline-point near segment-projection) so snap-endpoint
 *  geometry doesn't fall through segHit's open interval check. Clusters
 *  within 2 tiles to keep the bridge deck contiguous. */
function computeBridgePts(entries: RenderEntry[]): void {
  for (let i = 0; i < entries.length; i++) {
    const e1 = entries[i];
    const z1 = e1.row[3] as number;
    if (z1 < 2) {
      e1.bridgePts = undefined;
      continue;
    }
    const pts1 = polylinePoints(e1.row);
    const bps: Array<{ x: number; y: number }> = [];
    const addBp = (x: number, y: number): void => {
      for (const bp of bps) {
        if (Math.abs(bp.x - x) < 2 && Math.abs(bp.y - y) < 2) return;
      }
      bps.push({ x, y });
    };
    for (let j = 0; j < entries.length; j++) {
      if (i === j) continue;
      const e2 = entries[j];
      const z2 = e2.row[3] as number;
      // Comparative z (monolith v8.99.124.39 — L10426): only consider
      // roads strictly below me. A z=4 highway crossing another z=4
      // highway is treated as a same-level junction, not a bridge.
      if (z2 >= z1) continue;
      const pts2 = polylinePoints(e2.row);
      const w2 = e2.row[0] as number;
      const halfW = w2 * 0.5;
      const halfW2 = halfW * halfW;
      // Pass A: mid-segment intersections.
      for (let a = 0; a < pts1.length - 1; a++) {
        for (let b = 0; b < pts2.length - 1; b++) {
          const h = segHit(
            pts1[a][0], pts1[a][1], pts1[a + 1][0], pts1[a + 1][1],
            pts2[b][0], pts2[b][1], pts2[b + 1][0], pts2[b + 1][1],
          );
          if (h) addBp(h.x, h.y);
        }
      }
      // Pass B: bridge polyline point lies within the ground road's
      // half-width of a ground segment. Catches snap-endpoint cases
      // where segHit excluded the t=0/1 corners.
      for (let a = 0; a < pts1.length; a++) {
        const px = pts1[a][0];
        const py = pts1[a][1];
        for (let b = 0; b < pts2.length - 1; b++) {
          const ax = pts2[b][0];
          const ay = pts2[b][1];
          const bx = pts2[b + 1][0];
          const by = pts2[b + 1][1];
          const vx = bx - ax;
          const vy = by - ay;
          const len2 = vx * vx + vy * vy;
          if (len2 < 0.0001) continue;
          let t = ((px - ax) * vx + (py - ay) * vy) / len2;
          t = Math.max(0, Math.min(1, t));
          const projX = ax + t * vx;
          const projY = ay + t * vy;
          const dd = (projX - px) * (projX - px) + (projY - py) * (projY - py);
          if (dd < halfW2) addBp(projX, projY);
        }
      }
    }
    e1.bridgePts = bps.length > 0 ? bps : undefined;
  }
}

/** H788: minimum distance (tiles) from a crossing point to either
 *  road's endpoint for it to count as a 4-way crossing. Closer hits
 *  are T-junction / auto-taper territory (handled by H281/H283) and
 *  double-treating them would erase their stripe work. */
const CROSSING_ENDPOINT_GUARD = 2.5;

/** H788: populate `crossings` on the LATER-painted entry of every
 *  same-z mid-segment road crossing. Paint order (post z-sort array
 *  order) already hides the earlier road's markings under the later
 *  road's asphalt at the junction; the stored zones let strokeRoad
 *  overpaint the later road's OWN markings inside the box, leaving
 *  the intersection interior as bare pavement — markings break at
 *  the box edge like real junctions instead of running through. */
function computeRoadCrossings(entries: RenderEntry[]): void {
  for (const e of entries) e.crossings = undefined;
  for (let j = 1; j < entries.length; j++) {
    const ej = entries[j];
    const zj = ej.row[3] as number;
    // H791: elevated same-z pairs participate too — the erase runs at
    // the end of strokeRoadMarkings, which the deferred elevated
    // marking pass (drawBridgeOverlays) also calls.
    if (ej.mergeAlign !== undefined) continue; // merge ribbons bond, not cross
    const ptsJ = ej.rawPts ?? polylinePoints(ej.row);
    if (ptsJ.length < 2) continue;
    const halfWJ = (ej.laneGeom?.asphaltW
      ?? laneStandardizedWidth(String(ej.row[2] ?? ''), ej.row[0] as number)) * 0.5;
    for (let i = 0; i < j; i++) {
      const ei = entries[i];
      if ((ei.row[3] as number) !== zj) continue;
      if (ei.mergeAlign !== undefined) continue;
      // bbox early-out (world px, padded at build time).
      if (ej.bbox && ei.bbox && (
        ej.bbox.maxX < ei.bbox.minX || ej.bbox.minX > ei.bbox.maxX
        || ej.bbox.maxY < ei.bbox.minY || ej.bbox.minY > ei.bbox.maxY
      )) continue;
      const ptsI = ei.rawPts ?? polylinePoints(ei.row);
      if (ptsI.length < 2) continue;
      const halfWI = (ei.laneGeom?.asphaltW
        ?? laneStandardizedWidth(String(ei.row[2] ?? ''), ei.row[0] as number)) * 0.5;
      for (let a = 0; a < ptsJ.length - 1; a++) {
        for (let b = 0; b < ptsI.length - 1; b++) {
          const h = segHit(
            ptsJ[a][0], ptsJ[a][1], ptsJ[a + 1][0], ptsJ[a + 1][1],
            ptsI[b][0], ptsI[b][1], ptsI[b + 1][0], ptsI[b + 1][1],
          );
          if (!h) continue;
          // Endpoint guard — leave tees/tapers to their own passes.
          const g2 = CROSSING_ENDPOINT_GUARD * CROSSING_ENDPOINT_GUARD;
          const nearEnd = (pp: ReadonlyArray<readonly [number, number]>): boolean => {
            const s = pp[0];
            const e2 = pp[pp.length - 1];
            return ((h.x - s[0]) * (h.x - s[0]) + (h.y - s[1]) * (h.y - s[1])) < g2
                || ((h.x - e2[0]) * (h.x - e2[0]) + (h.y - e2[1]) * (h.y - e2[1])) < g2;
          };
          if (nearEnd(ptsJ) || nearEnd(ptsI)) continue;
          // Peer (earlier road) tangent at the crossing segment.
          let tx = ptsI[b + 1][0] - ptsI[b][0];
          let ty = ptsI[b + 1][1] - ptsI[b][1];
          const tl = Math.hypot(tx, ty) || 1;
          tx /= tl; ty /= tl;
          // H791: obliquity scaling. The box's along-peer extent must
          // cover OUR band's footprint through the peer — for a skew
          // crossing that footprint stretches by 1/|sin θ| (θ = angle
          // between the tangents). The user's drive test showed
          // markings slicing through boxes at acute interchange
          // crossings. Clamp at 30° so near-parallel grazes don't
          // produce kilometer boxes.
          let jx = ptsJ[a + 1][0] - ptsJ[a][0];
          let jy = ptsJ[a + 1][1] - ptsJ[a][1];
          const jl = Math.hypot(jx, jy) || 1;
          jx /= jl; jy /= jl;
          const sinTheta = Math.max(0.5, Math.abs(jx * ty - jy * tx));
          const list = ej.crossings ?? (ej.crossings = []);
          // Dedup within 2 tiles (parallel multi-segment grazes).
          let dup = false;
          for (const cz of list) {
            if (Math.abs(cz.x - h.x) < 2 && Math.abs(cz.y - h.y) < 2) { dup = true; break; }
          }
          if (dup) continue;
          list.push({
            x: h.x, y: h.y, tx, ty,
            alongHalf: halfWJ / sinTheta,
            acrossHalf: halfWI,
          });
        }
      }
    }
  }
}

/** H790: connection tolerance past the peer's asphalt half-width. An
 *  endpoint within (peerHalfW + this) of a same-z peer's centerline is
 *  CONNECTED (tee, shared vertex, or merge bond) and keeps its flat
 *  butt cap; anything farther is a free terminus and gets a rounded
 *  end-cap. */
const ENDCAP_CONNECT_SLACK = 0.75;

/** H790: populate `endCaps` on every non-merge entry whose start/end
 *  endpoint is a free terminus. Uses the smoothed polyline's end
 *  tangent for the cap orientation so the half-disc continues the
 *  curve, and the lane-standardized asphalt half-width for its
 *  radius. */
function computeEndCaps(entries: RenderEntry[]): void {
  for (const entry of entries) {
    entry.endCaps = undefined;
    if (entry.mergeAlign !== undefined) continue; // merge tips taper to apexes
    const raw = entry.rawPts;
    const sm = entry.smoothed;
    if (!raw || raw.length < 2 || sm.length < 4) continue;
    const zSelf = entry.row[3] as number;
    const halfW = (entry.laneGeom?.asphaltW
      ?? laneStandardizedWidth(String(entry.row[2] ?? ''), entry.row[0] as number)) * 0.5;
    const isConnected = (ex: number, ey: number): boolean => {
      const exPx = ex * TILE;
      const eyPx = ey * TILE;
      for (const o of entries) {
        if (o === entry) continue;
        if ((o.row[3] as number) !== zSelf) continue;
        const oPts = o.rawPts;
        if (!oPts || oPts.length < 2) continue;
        if (o.bbox && (
          exPx < o.bbox.minX || exPx > o.bbox.maxX
          || eyPx < o.bbox.minY || eyPx > o.bbox.maxY
        )) continue;
        const oHalf = (o.laneGeom?.asphaltW
          ?? laneStandardizedWidth(String(o.row[2] ?? ''), o.row[0] as number)) * 0.5;
        const rr = oHalf + ENDCAP_CONNECT_SLACK;
        const rr2 = rr * rr;
        for (let i = 0; i < oPts.length - 1; i++) {
          const ax = oPts[i][0];
          const ay = oPts[i][1];
          const bx = oPts[i + 1][0];
          const by = oPts[i + 1][1];
          const dx = bx - ax;
          const dy = by - ay;
          const lenSq = dx * dx + dy * dy;
          if (lenSq < 0.0001) continue;
          let t = ((ex - ax) * dx + (ey - ay) * dy) / lenSq;
          if (t < 0) t = 0;
          else if (t > 1) t = 1;
          const qx = ax + dx * t;
          const qy = ay + dy * t;
          if ((ex - qx) * (ex - qx) + (ey - qy) * (ey - qy) <= rr2) return true;
        }
      }
      return false;
    };
    const caps: NonNullable<RenderEntry['endCaps']> = [];
    const M = sm.length / 2;
    // Start cap — outward tangent points AWAY from the road body.
    if (!isConnected(raw[0][0], raw[0][1])) {
      const ang = Math.atan2(sm[1] - sm[3], sm[0] - sm[2]);
      caps.push({ x: sm[0] * TILE, y: sm[1] * TILE, ang, halfWpx: halfW * TILE });
    }
    if (!isConnected(raw[raw.length - 1][0], raw[raw.length - 1][1])) {
      const ang = Math.atan2(
        sm[(M - 1) * 2 + 1] - sm[(M - 2) * 2 + 1],
        sm[(M - 1) * 2]     - sm[(M - 2) * 2],
      );
      caps.push({
        x: sm[(M - 1) * 2] * TILE,
        y: sm[(M - 1) * 2 + 1] * TILE,
        ang,
        halfWpx: halfW * TILE,
      });
    }
    if (caps.length > 0) entry.endCaps = caps;
  }
}

/** H281: perpendicular distance tolerance for "endpoint lies on
 *  segment" — branches that come in further off the centerline than
 *  this aren't counted as T-junctions. Mirrors monolith L19571's
 *  TOLERANCE_TILES = 0.5. */
const TEE_TOLERANCE_TILES = 0.5;
/** H281: exclude segment endpoints. Vertex-to-vertex joins (t ≈ 0 or
 *  t ≈ 1) are handled by the auto-taper geometry pass, not this
 *  detector. Mirrors monolith L19572-L19573. */
const TEE_SEG_MIN_T = 0.05;
const TEE_SEG_MAX_T = 0.95;
/** H281: clamp range for the erase-zone radius (tile units). Keeps
 *  narrow roads from getting an invisible gap and prevents highways
 *  from gapping the stripe along most of their length. Monolith
 *  L19641 uses the same [1, 4] range. */
const TEE_RADIUS_MIN = 1;
const TEE_RADIUS_MAX = 4;
/** H281: dedup distance — junction points closer than this in tile
 *  units collapse to one record. Monolith L19633. */
const TEE_DEDUP_DIST = 0.3;
/** H282: T-junction edge-erase stroke width. Wider than the 1.4-px
 *  white fog line so the asphalt overpaint fully covers it including
 *  the anti-aliased edges. Monolith L31399 uses 2.4 px. */
const TEE_ERASE_WIDTH = 2.4;

/** H283: auto-taper detector constants. Mirror monolith L19238-L19240
 *  in _weDetectAutoTapers. */
const TAPER_RADIUS_SQ = 0.5 * 0.5;   // tile²: vertex match tolerance
const TAPER_MIN_WIDTH_DELTA = 0.5;   // tiles: minimum halfW gap to taper
const TAPER_TILES_DEFAULT = 5;       // tiles: default taper length
/** H283: edge-stripe inset for the taper's outerStripe/innerStripe.
 *  Matches getRoadProfile / EDGE_STRIPE_INSET_PX (1.7 px) converted to
 *  tile units. Monolith L10962 / L19452 (same constant in two scopes). */
const TAPER_STRIPE_INSET_TILES = 1.7 / 18; // = EDGE_STRIPE_INSET_PX / TILE

/** H283: build the auto-taper polygon edges at one endpoint of a road.
 *  1:1 port of monolith _weBuildAutoTaperPolygon at L10902-L11007.
 *
 *  Walks `taperLen` tiles into the road from the chosen `side` end,
 *  collecting raw polyline vertices (plus a clipped final sample at
 *  exactly taperLen arc-distance). For each sample, computes a
 *  perpendicular and a linearly-interpolated half-width that flares
 *  from `peerHalfW` at the joined endpoint (sample[0]) to
 *  `currentHalfW` at the interior (sample[L-1]).
 *
 *  sample[0]'s tangent — and therefore its perpendicular — comes from
 *  the WIDER peer road's tangent (`joinedTangent`) when supplied, not
 *  this road's tangent. Otherwise a small angular mismatch between the
 *  two roads' tangents at the shared vertex creates a perpendicular
 *  offset gap = halfW * sin(Δθ) (e.g., ~4 screen px at zoom 40 for
 *  Δθ=5°). Monolith fix at L10967-L10984 / v8.99.126.65. Sample[1..L-1]
 *  use the narrow road's natural interior tangent so the perpendicular
 *  smoothly transitions from peer-aligned at the joint to narrow-aligned
 *  at the interior.
 *
 *  Returns null on degenerate inputs (zero-length polyline / first
 *  segment, taperLen ≤ 0, sample count < 2). */
function buildAutoTaperPolygon(
  tilePts: ReadonlyArray<readonly [number, number]>,
  side: 'start' | 'end',
  currentHalfW: number,
  peerHalfW: number,
  taperLen: number,
  joinedTangent: readonly [number, number] | null,
): { outer: Array<[number, number]>; inner: Array<[number, number]>;
     outerStripe: Array<[number, number]>; innerStripe: Array<[number, number]> } | null {
  if (!tilePts || tilePts.length < 2) return null;
  if (!(taperLen > 0)) return null;
  const N = tilePts.length;
  const walkStep = side === 'end' ? -1 : +1;
  const walkIdx = side === 'end' ? N - 1 : 0;
  // samples: [x, y, arcLengthFromEndpoint]
  const samples: Array<[number, number, number]> = [
    [tilePts[walkIdx][0], tilePts[walkIdx][1], 0],
  ];
  let arc = 0;
  let prevX = tilePts[walkIdx][0];
  let prevY = tilePts[walkIdx][1];
  let cur = walkIdx;
  while (true) {
    const nxt = cur + walkStep;
    if (nxt < 0 || nxt >= N) break;
    const nx = tilePts[nxt][0];
    const ny = tilePts[nxt][1];
    const segLen = Math.hypot(nx - prevX, ny - prevY);
    if (segLen < 1e-6) { cur = nxt; prevX = nx; prevY = ny; continue; }
    if (arc + segLen >= taperLen) {
      const remain = taperLen - arc;
      const t = remain / segLen;
      samples.push([prevX + t * (nx - prevX), prevY + t * (ny - prevY), taperLen]);
      break;
    }
    samples.push([nx, ny, arc + segLen]);
    arc += segLen;
    cur = nxt;
    prevX = nx; prevY = ny;
  }
  if (samples.length < 2) return null;
  const outer: Array<[number, number]> = [];
  const inner: Array<[number, number]> = [];
  const outerStripe: Array<[number, number]> = [];
  const innerStripe: Array<[number, number]> = [];
  const M = samples.length;
  for (let i = 0; i < M; i++) {
    let tx: number, ty: number;
    if (i === 0 && joinedTangent) {
      tx = joinedTangent[0];
      ty = joinedTangent[1];
    } else if (i < M - 1) {
      tx = samples[i + 1][0] - samples[i][0];
      ty = samples[i + 1][1] - samples[i][1];
    } else {
      tx = samples[i][0] - samples[i - 1][0];
      ty = samples[i][1] - samples[i - 1][1];
    }
    const tLen = Math.hypot(tx, ty);
    if (tLen < 1e-6) return null;
    tx /= tLen; ty /= tLen;
    const px = -ty;
    const py =  tx;
    const ratio = samples[i][2] / taperLen; // 0 at endpoint, 1 at interior
    const hw = peerHalfW * (1 - ratio) + currentHalfW * ratio;
    outer.push([samples[i][0] + px * hw, samples[i][1] + py * hw]);
    inner.push([samples[i][0] - px * hw, samples[i][1] - py * hw]);
    const hwStripe = Math.max(0, hw - TAPER_STRIPE_INSET_TILES);
    outerStripe.push([samples[i][0] + px * hwStripe, samples[i][1] + py * hwStripe]);
    innerStripe.push([samples[i][0] - px * hwStripe, samples[i][1] - py * hwStripe]);
  }
  return { outer, inner, outerStripe, innerStripe };
}

/** H285: build the lane-addition channelizing stripe sample polylines
 *  for one auto-taper polygon. 1:1 port of monolith _buildLaneAdd at
 *  L19453-L19480 (inside _weDetectAutoTapers).
 *
 *  Reconstructs the centerline of the taper region from the outer/inner
 *  midpoint (by construction, outer[k] = sample[k] + perp*hw and
 *  inner[k] = sample[k] - perp*hw, so midpoint = sample[k]). From each
 *  midpoint, steps ±perpendicular by narrowEdgeOff = currentHalfW -
 *  1.7/TILE — the narrow road's pre-taper edge stripe position. The
 *  resulting Plus / Minus polylines mark where the edge stripe WOULD
 *  have been if the road hadn't widened, so vehicles see a dashed
 *  channelizing line in the lane-add region.
 *
 *  Returns null when the road is too narrow for a stripe (currentHalfW
 *  near or below the inset). */
function buildLaneAddSamples(meta: {
  outer: ReadonlyArray<readonly [number, number]>;
  inner: ReadonlyArray<readonly [number, number]>;
  currentHalfW: number;
}): { plus: Array<[number, number]>; minus: Array<[number, number]> } | null {
  const { outer, inner } = meta;
  const L = outer.length;
  if (L < 2 || inner.length !== L) return null;
  const narrowEdgeOff = Math.max(0, meta.currentHalfW - TAPER_STRIPE_INSET_TILES);
  if (narrowEdgeOff < 0.01) return null;
  const centers: Array<[number, number]> = new Array(L);
  for (let k = 0; k < L; k++) {
    centers[k] = [
      (outer[k][0] + inner[k][0]) * 0.5,
      (outer[k][1] + inner[k][1]) * 0.5,
    ];
  }
  const plus: Array<[number, number]> = new Array(L);
  const minus: Array<[number, number]> = new Array(L);
  for (let k = 0; k < L; k++) {
    let tx: number, ty: number;
    if (k < L - 1) {
      tx = centers[k + 1][0] - centers[k][0];
      ty = centers[k + 1][1] - centers[k][1];
    } else {
      tx = centers[k][0] - centers[k - 1][0];
      ty = centers[k][1] - centers[k - 1][1];
    }
    const tLen = Math.hypot(tx, ty);
    if (tLen < 1e-6) return null;
    tx /= tLen; ty /= tLen;
    const px = -ty * narrowEdgeOff;
    const py =  tx * narrowEdgeOff;
    plus[k]  = [centers[k][0] + px, centers[k][1] + py];
    minus[k] = [centers[k][0] - px, centers[k][1] - py];
  }
  return { plus, minus };
}

/** H283: detect auto-tapers across every entry pair. For each entry's
 *  two endpoints, find the WIDEST peer entry whose endpoint sits
 *  within TAPER_RADIUS tiles. If the peer is at least MIN_WIDTH_DELTA
 *  wider, build a taper polygon at this entry's endpoint flaring from
 *  currentHalfW (interior) to peerHalfW (joint). Stores the result on
 *  entry.autoTaperStart or entry.autoTaperEnd. 1:1 port of monolith
 *  _weDetectAutoTapers at L19236-L19387 (sans Path2D-building tail —
 *  H284 will consume the tile-coord arrays directly with
 *  beginPath/moveTo/lineTo, no Path2D needed).
 *
 *  taperLen is clamped at min(TAPER_TILES_DEFAULT, arcLen * 0.45) so
 *  two tapers (one at each end of a short road) don't overlap in the
 *  middle. */
function computeAutoTapers(entries: RenderEntry[]): void {
  if (entries.length === 0) return;
  const halfAsphaltW = new Array<number>(entries.length);
  const ptsCache: Array<Array<[number, number]>> = new Array(entries.length);
  const arcLen = new Array<number>(entries.length).fill(0);
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const w = e.row[0] as number;
    const name = String(e.row[2] ?? '');
    halfAsphaltW[i] = getLaneGeom(name, w).asphaltW * 0.5;
    const p = polylinePoints(e.row);
    ptsCache[i] = p;
    let s = 0;
    for (let k = 0; k + 1 < p.length; k++) {
      s += Math.hypot(p[k + 1][0] - p[k][0], p[k + 1][1] - p[k][1]);
    }
    arcLen[i] = s;
    // Defensive: clear stale state.
    e.autoTaperStart = undefined;
    e.autoTaperEnd = undefined;
  }
  for (let i = 0; i < entries.length; i++) {
    const ra = entries[i];
    const ptsA = ptsCache[i];
    if (ptsA.length < 2) continue;
    const halfA = halfAsphaltW[i];
    const N = ptsA.length;
    for (const endIdx of [0, N - 1] as const) {
      const ax = ptsA[endIdx][0];
      const ay = ptsA[endIdx][1];
      let widestHalfW = halfA;
      let foundWider = false;
      let widestPeerPts: ReadonlyArray<readonly [number, number]> | null = null;
      let widestPeerEndIdx = -1;
      for (let j = 0; j < entries.length; j++) {
        if (i === j) continue;
        const halfB = halfAsphaltW[j];
        if (halfB <= widestHalfW + 0.001) continue; // not wider
        const ptsB = ptsCache[j];
        if (ptsB.length < 2) continue;
        const M = ptsB.length;
        for (const endIdxB of [0, M - 1] as const) {
          const bx = ptsB[endIdxB][0];
          const by = ptsB[endIdxB][1];
          const dd = (ax - bx) * (ax - bx) + (ay - by) * (ay - by);
          if (dd <= TAPER_RADIUS_SQ) {
            widestHalfW = halfB;
            widestPeerPts = ptsB;
            widestPeerEndIdx = endIdxB;
            foundWider = true;
            break;
          }
        }
      }
      if (!foundWider) continue;
      if (widestHalfW - halfA < TAPER_MIN_WIDTH_DELTA * 0.5) continue;
      const taperLen = Math.min(TAPER_TILES_DEFAULT, arcLen[i] * 0.45);
      if (taperLen < 0.5) continue;
      // Wider peer's tangent at the junction, pointing INTO the narrow
      // road's interior. Sample[0]'s perp will use this so the taper's
      // edge stripe endpoint aligns exactly with where the wide road's
      // edge stripe ends. Monolith L19349-L19368.
      let joinedTangent: [number, number] | null = null;
      if (widestPeerPts && widestPeerEndIdx >= 0) {
        const Mp = widestPeerPts.length;
        const otherIdx = widestPeerEndIdx === 0 ? 1 : Mp - 2;
        if (otherIdx >= 0 && otherIdx < Mp) {
          const jtx = widestPeerPts[widestPeerEndIdx][0] - widestPeerPts[otherIdx][0];
          const jty = widestPeerPts[widestPeerEndIdx][1] - widestPeerPts[otherIdx][1];
          const jLen = Math.hypot(jtx, jty);
          if (jLen > 1e-6) joinedTangent = [jtx / jLen, jty / jLen];
        }
      }
      const edges = buildAutoTaperPolygon(
        ptsA, endIdx === 0 ? 'start' : 'end',
        halfA, widestHalfW, taperLen, joinedTangent,
      );
      if (!edges) continue;
      const meta: AutoTaperMeta = {
        outer: edges.outer,
        inner: edges.inner,
        outerStripe: edges.outerStripe,
        innerStripe: edges.innerStripe,
        taperLen,
        peerHalfW: widestHalfW,
        currentHalfW: halfA,
      };
      // H285: lane-add channelizing samples — null on roads too narrow
      // for a stripe (narrowEdgeOff <= 0.01).
      const laneAdd = buildLaneAddSamples(meta);
      if (laneAdd) {
        meta.laneAddPlus  = laneAdd.plus;
        meta.laneAddMinus = laneAdd.minus;
      }
      if (endIdx === 0) ra.autoTaperStart = meta;
      else              ra.autoTaperEnd = meta;
    }
  }
}

/** H282: walk a raw polyline outward from a junction point until
 *  ±radius arc-distance is covered on each side. Returns samples in
 *  tile coords going from far-back through the junction point to
 *  far-forward. 1:1 port of monolith _samplesInZone L19651-L19712.
 *
 *  segIdx + t pin the junction to a specific point along the polyline
 *  (between pts[segIdx] and pts[segIdx+1]); the walk steps along the
 *  raw segments collecting vertices until the cumulative segment-by-
 *  segment distance from the junction point hits `radius`, then clips
 *  to the exact radius point on the final segment. Vertex-aware
 *  walking means curving roads pick up their natural sample density
 *  through the zone instead of being interpolated, which keeps the
 *  perpendicular-offset trace from cutting corners on multi-segment
 *  curves passing through the junction. */
function samplesInZone(
  pts: ReadonlyArray<readonly [number, number]>,
  segIdx: number,
  t: number,
  radius: number,
): Array<[number, number]> {
  const N = pts.length;
  if (N < 2 || segIdx < 0 || segIdx >= N - 1) return [];
  const jx = pts[segIdx][0] + t * (pts[segIdx + 1][0] - pts[segIdx][0]);
  const jy = pts[segIdx][1] + t * (pts[segIdx + 1][1] - pts[segIdx][1]);
  // Backward walk — collect into a reversed list, then re-emit so the
  // final samples array goes far-back → junction → far-forward.
  const backList: Array<[number, number]> = [];
  let walkSeg = segIdx;
  let walkPos: [number, number] = [jx, jy];
  let distB = 0;
  while (walkSeg >= 0) {
    const aBack = pts[walkSeg];
    const ddx = walkPos[0] - aBack[0];
    const ddy = walkPos[1] - aBack[1];
    const segPart = Math.hypot(ddx, ddy);
    if (distB + segPart >= radius) {
      const rem = radius - distB;
      const ratio = rem / segPart;
      backList.push([walkPos[0] - ratio * ddx, walkPos[1] - ratio * ddy]);
      break;
    }
    backList.push([aBack[0], aBack[1]]);
    distB += segPart;
    walkSeg--;
    if (walkSeg < 0) break;
    walkPos = [aBack[0], aBack[1]];
  }
  const samples: Array<[number, number]> = [];
  for (let k = backList.length - 1; k >= 0; k--) samples.push(backList[k]);
  samples.push([jx, jy]);
  // Forward walk.
  let distF = 0;
  walkSeg = segIdx;
  walkPos = [jx, jy];
  while (walkSeg < N - 1) {
    const aFwd = pts[walkSeg + 1];
    const ddx = aFwd[0] - walkPos[0];
    const ddy = aFwd[1] - walkPos[1];
    const segPart = Math.hypot(ddx, ddy);
    if (distF + segPart >= radius) {
      const rem = radius - distF;
      const ratio = rem / segPart;
      samples.push([walkPos[0] + ratio * ddx, walkPos[1] + ratio * ddy]);
      break;
    }
    samples.push([aFwd[0], aFwd[1]]);
    distF += segPart;
    walkSeg++;
    if (walkSeg >= N - 1) break;
    walkPos = [aFwd[0], aFwd[1]];
  }
  return samples;
}

/** H282: build a perpendicular-offset path in world pixels through the
 *  given tile-coord samples, calling ctx.moveTo/lineTo. Forward-
 *  difference tangent at each sample except the last (which uses
 *  backward difference). Offset in TILE units; positive = +perp
 *  (matching tracePathOffset / monolith _strokePathAtOffset
 *  L19713-L19734). */
function traceOffsetSamples(
  ctx: CanvasRenderingContext2D,
  samples: ReadonlyArray<readonly [number, number]>,
  offsetTiles: number,
): void {
  const M = samples.length;
  if (M < 2) return;
  ctx.beginPath();
  let started = false;
  for (let i = 0; i < M; i++) {
    let tx: number, ty: number;
    if (i < M - 1) {
      tx = samples[i + 1][0] - samples[i][0];
      ty = samples[i + 1][1] - samples[i][1];
    } else {
      tx = samples[i][0] - samples[i - 1][0];
      ty = samples[i][1] - samples[i - 1][1];
    }
    const tLen = Math.hypot(tx, ty);
    if (tLen < 1e-6) continue;
    tx /= tLen; ty /= tLen;
    const px = -ty * offsetTiles;
    const py =  tx * offsetTiles;
    const wx = (samples[i][0] + px) * TILE;
    const wy = (samples[i][1] + py) * TILE;
    if (!started) { ctx.moveTo(wx, wy); started = true; }
    else          { ctx.lineTo(wx, wy); }
  }
}

/** H281: detect T-junctions across every entry pair. For each entry's
 *  two endpoints, project onto every other entry's segments; if the
 *  projection lands strictly inside the segment (t in [SEG_MIN_T,
 *  SEG_MAX_T]) AND the perpendicular distance is within
 *  TEE_TOLERANCE_TILES, push a TeeJunction record onto the through
 *  road. The branch road (whose endpoint is the trigger) gets nothing
 *  — only the through road needs to gap its edge stripe. 1:1 port of
 *  monolith _weDetectTeeJunctions at L19569-L19646, minus the
 *  Path2D-building tail (deferred to H282).
 *
 *  Bbox early-out uses entry.bbox (already populated by the time this
 *  runs in rebuildRenderEntries) to skip the inner segment loop when
 *  the candidate endpoint is far outside the through road's footprint.
 *  Drops the inner loop by >95% on the 118-road Charlotte baseline. */
function computeTeeJunctions(entries: RenderEntry[]): void {
  if (entries.length === 0) return;
  // Pre-resolve asphaltW per entry (skip nothing — modular has no
  // merge-polygon roads yet, so every entry is a candidate). Also
  // pre-build the raw polyline once per entry to avoid recomputing in
  // the O(R²) outer loops.
  const halfAsphaltW = new Array<number>(entries.length);
  const ptsCache: Array<Array<[number, number]>> = new Array(entries.length);
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const w = e.row[0] as number;
    const name = String(e.row[2] ?? '');
    halfAsphaltW[i] = getLaneGeom(name, w).asphaltW * 0.5;
    ptsCache[i] = polylinePoints(e.row);
    // Defensive: clear stale state from any prior rebuild. (Each call
    // to rebuildRenderEntries creates fresh entries so this should be
    // a no-op, but the pattern keeps the function safely re-runnable.)
    e.teeJunctions = undefined;
  }
  const TILE_PAD = TILE * 1.0;
  for (let i = 0; i < entries.length; i++) {
    const ptsA = ptsCache[i];
    if (ptsA.length < 2) continue;
    const N = ptsA.length;
    // Each road has two endpoints. (Loop matches monolith — closed
    // rings just test both ends and dedup catches duplicates.)
    for (const endIdx of [0, N - 1] as const) {
      const ax = ptsA[endIdx][0];
      const ay = ptsA[endIdx][1];
      const aWx = ax * TILE + TILE / 2;
      const aWy = ay * TILE + TILE / 2;
      for (let j = 0; j < entries.length; j++) {
        if (i === j) continue;
        const rb = entries[j];
        const bb = rb.bbox;
        if (bb) {
          if (aWx < bb.minX - TILE_PAD || aWx > bb.maxX + TILE_PAD
           || aWy < bb.minY - TILE_PAD || aWy > bb.maxY + TILE_PAD) continue;
        }
        const halfB = halfAsphaltW[j];
        const ptsB = ptsCache[j];
        const M = ptsB.length;
        for (let s = 0; s < M - 1; s++) {
          const ex = ptsB[s][0];
          const ey = ptsB[s][1];
          const fx = ptsB[s + 1][0];
          const fy = ptsB[s + 1][1];
          const vx = fx - ex;
          const vy = fy - ey;
          const lenSq = vx * vx + vy * vy;
          if (lenSq < 0.01) continue;
          const t = ((ax - ex) * vx + (ay - ey) * vy) / lenSq;
          if (t < TEE_SEG_MIN_T || t > TEE_SEG_MAX_T) continue;
          const projX = ex + t * vx;
          const projY = ey + t * vy;
          const dx = ax - projX;
          const dy = ay - projY;
          if (dx * dx + dy * dy > TEE_TOLERANCE_TILES * TEE_TOLERANCE_TILES) continue;
          // Through-road B has a T-junction at (projX, projY).
          let list = rb.teeJunctions as TeeJunction[] | undefined;
          if (!list) {
            list = [];
            rb.teeJunctions = list;
          }
          let dup = false;
          for (const tj of list) {
            const ddx = tj.x - projX;
            const ddy = tj.y - projY;
            if (ddx * ddx + ddy * ddy < TEE_DEDUP_DIST * TEE_DEDUP_DIST) {
              dup = true; break;
            }
          }
          if (dup) continue;
          list.push({
            x: projX, y: projY, segIdx: s, t,
            radius: Math.min(TEE_RADIUS_MAX, Math.max(TEE_RADIUS_MIN, halfB * 1.1)),
          });
        }
      }
    }
  }
}

/** H141: render the concrete bridge deck stack (shadow + rim + drive
 *  surface) for every original-polyline segment whose midpoint or either
 *  endpoint is within BRIDGE_R_TILES of a stored bridgePt. 1:1 port of
 *  monolith L31150-31183. Strokes are drawn in three width-ordered
 *  passes so the shadow extends past the rim and the rim extends past
 *  the drive surface — the visible visual is parapet walls flanking a
 *  concrete deck with a dark ground-cast shadow underneath. */
function drawBridgeOverlay(
  ctx: CanvasRenderingContext2D,
  entry: RenderEntry,
  w: number,
  visibleChunks: RoadChunk[] | null = null,
): void {
  const bPts = entry.bridgePts;
  if (!bPts || bPts.length === 0) return;

  // H677: bridge concrete tracks the lane-standardized asphalt
  // width (matches the asphalt stroke in strokeRoad). 0.85× factor
  // keeps the concrete slightly narrower than the road surface so
  // the deck reads as the structural element under the road rather
  // than its full footprint.
  const _asphaltWTiles = entry.laneGeom?.asphaltW
    ?? laneStandardizedWidth(String(entry.row[2] ?? ''), w);
  const outerRW = 0.85 * _asphaltWTiles * TILE;
  const barrierW = BRIDGE_BARRIER_W_TILES * TILE;
  const driveRW = Math.max(0, outerRW - 2 * barrierW);

  const prevCap = ctx.lineCap;
  ctx.lineCap = 'butt';

  // H772: cached-Path2D fast path. Each chunk carries a pre-baked
  // bridgePath containing only the segments within BRIDGE_R_TILES of
  // a bridgePoint, built once at rebuildRenderEntries. Iterating
  // visible chunks + 3× ctx.stroke replaces the prior 3-pass
  // per-segment polyline walk + per-segment nearBridge() distance²
  // scan, dropping ~O(visibleChunks × N × B × 9) work to
  // O(visibleChunks × 3). I-485-near-camera frames were spending the
  // largest share of frame budget here pre-H772.
  const chunks = visibleChunks ?? entry.chunks;
  if (chunks) {
    // Shadow under the bridge — widest stroke, semi-transparent black.
    ctx.lineWidth = outerRW + 6;
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    for (const ck of chunks) if (ck.bridgePath) ctx.stroke(ck.bridgePath);
    // Concrete rim + barrier zone (parapet color).
    ctx.lineWidth = outerRW + 3;
    ctx.strokeStyle = '#888884';
    for (const ck of chunks) if (ck.bridgePath) ctx.stroke(ck.bridgePath);
    // Concrete drive surface (lane area between the parapets).
    ctx.lineWidth = driveRW;
    ctx.strokeStyle = '#6a6a68';
    for (const ck of chunks) if (ck.bridgePath) ctx.stroke(ck.bridgePath);
  } else {
    // Fallback for un-chunked short bridges (entry.chunks === null
    // when the smoothed polyline fits in one chunk). Same per-segment
    // walk as pre-H772 — only fires on tiny overpasses where the
    // O(N×B) cost is bounded anyway. Uses the un-smoothed raw row
    // polyline to preserve the original visual.
    const pts = polylinePoints(entry.row);
    if (pts.length < 2) { ctx.lineCap = prevCap; return; }
    const R2 = BRIDGE_R_TILES * BRIDGE_R_TILES;
    const nearBridge = (tx: number, ty: number): boolean => {
      for (const bp of bPts) {
        const dd = (tx - bp.x) * (tx - bp.x) + (ty - bp.y) * (ty - bp.y);
        if (dd < R2) return true;
      }
      return false;
    };
    const passes: Array<[number, string]> = [
      [outerRW + 6, 'rgba(0,0,0,0.35)'],
      [outerRW + 3, '#888884'],
      [driveRW, '#6a6a68'],
    ];
    for (const [lw, style] of passes) {
      ctx.lineWidth = lw;
      ctx.strokeStyle = style;
      for (let i = 0; i < pts.length - 1; i++) {
        const mx = (pts[i][0] + pts[i + 1][0]) / 2;
        const my = (pts[i][1] + pts[i + 1][1]) / 2;
        if (!nearBridge(mx, my) && !nearBridge(pts[i][0], pts[i][1]) && !nearBridge(pts[i + 1][0], pts[i + 1][1])) continue;
        ctx.beginPath();
        ctx.moveTo(pts[i][0] * TILE + TILE / 2, pts[i][1] * TILE + TILE / 2);
        ctx.lineTo(pts[i + 1][0] * TILE + TILE / 2, pts[i + 1][1] * TILE + TILE / 2);
        ctx.stroke();
      }
    }
  }

  ctx.lineCap = prevCap;
}

/** Construct a synthetic BaselineRoadRow from an editor overlay row. The
 *  overlay schema is [w, maj, name, z, x1, y1, ...] (legacy) or
 *  [w, maj, name, z, mergeFlag, x1, y1, ...] (merge). We keep the
 *  [w, maj, name, z] meta block intact (dropping merge flag — the asphalt
 *  + stripe passes don't read it) and re-emit the coords flat. The cast
 *  is safe: BaselineRoadRow's runtime shape is just an array of numbers
 *  + the name string. */
function overlayRowToBaseline(raw: readonly (string | number)[]): BaselineRoadRow | null {
  if (raw.length < 6) return null;
  const w = raw[0] as number;
  const maj = (raw[1] === 1 ? 1 : 0) as 0 | 1;
  const name = String(raw[2] ?? '');
  const z = raw[3] as number;
  const xStart = raw.length % 2 === 0 ? 4 : 5;
  const synth: (number | string)[] = [w, maj, name, z];
  for (let i = xStart; i + 1 < raw.length; i += 2) {
    synth.push(raw[i] as number, raw[i + 1] as number);
  }
  return synth as unknown as BaselineRoadRow;
}

/** H123/H126: the complete list of roads to render this session.
 *  Built once at module init by reading the editor's localStorage
 *  payload and combining it with BASELINE_ROADS:
 *
 *  1. For each baseline row, skip if marked deleted in the editor.
 *  2. If the editor has vertex edits for that row, build a synthesized
 *     row carrying the edited coords + reuse the original row's meta
 *     (so name / w / maj / z stay intact).
 *  3. Pre-smooth via Catmull-Rom — the same smoothFlatPolyline the
 *     editor + tile-stamper use, so all three see the same geometry.
 *  4. Append each editor-drawn overlay row as a synthesized baseline-
 *     shaped entry. Overlay rows render through the same strokeRoad
 *     pipeline so they get full asphalt texture + centerline + lane
 *     divider treatment, not just a plain road-tile fill underneath.
 *
 *  Reading from storage at module init means the editor's Ctrl+S
 *  saves take effect on the NEXT page reload. Live re-render after a
 *  save would require an in-game refresh hook the editor calls — port
 *  later. */
/** Unified render list. Module-init builds it; rebuildRenderEntries()
 *  refreshes after editor saves. Exported so the minimap bake reads
 *  identical geometry. Mutated in place — consumers must NOT cache
 *  the array elsewhere or those copies will go stale on rebuild. */
export const RENDER_ENTRIES: RenderEntry[] = [];

/** H127: rebuild the in-memory render list from current localStorage
 *  contents. Called at module init (first invocation) and again from
 *  the editor's Ctrl+S handler so a save → exit-editor flow shows the
 *  new geometry without a page reload. Mutates RENDER_ENTRIES in place
 *  rather than reassigning so consumers holding a reference (none
 *  currently, but defensive against future split-renderers) still see
 *  fresh data. */
export function rebuildRenderEntries(): void {
  const baselineEdits = _weLoadBaselineEdits();
  const overlay = _weLoadOverlayFromStorage();
  const deletedSet = new Set(baselineEdits.deletes);
  RENDER_ENTRIES.length = 0;
  // H651: invalidate the nearest-road scan memo — the entries it
  // walks have changed.
  _scanCache = null;
  // H268: narrow the storage's loose {material?: string} to the typed
  // material/age unions before stamping onto the RenderEntry — anything
  // else is dropped (defensive vs corrupted localStorage).
  const pickProps = (
    p: { material?: string; age?: string } | undefined,
  ): { material?: 'asphalt' | 'concrete'; age?: 'new' | 'old' } => {
    const out: { material?: 'asphalt' | 'concrete'; age?: 'new' | 'old' } = {};
    if (p?.material === 'asphalt' || p?.material === 'concrete') out.material = p.material;
    if (p?.age === 'new' || p?.age === 'old') out.age = p.age;
    return out;
  };
  // H269: same narrowing for the per-segment override list. Entries
  // without a numeric `seg` or with an unrecognized material/age are
  // dropped. Returns undefined when no usable entries remain so the
  // RenderEntry stays slim (and strokeRoad takes its fast path).
  const pickOverrides = (
    list: Array<{ seg: number; material?: string; age?: string }> | undefined,
  ): RenderEntry['materialOverrides'] | undefined => {
    if (!Array.isArray(list) || list.length === 0) return undefined;
    const out: Array<{ seg: number; material?: 'asphalt' | 'concrete'; age?: 'new' | 'old' }> = [];
    for (const o of list) {
      if (typeof o?.seg !== 'number') continue;
      const e: { seg: number; material?: 'asphalt' | 'concrete'; age?: 'new' | 'old' } = { seg: o.seg };
      if (o.material === 'asphalt' || o.material === 'concrete') e.material = o.material;
      if (o.age === 'new' || o.age === 'old') e.age = o.age;
      if (e.material || e.age) out.push(e);
    }
    return out.length > 0 ? out : undefined;
  };
  for (let rIdx = 0; rIdx < BASELINE_ROADS.length; rIdx++) {
    if (deletedSet.has(rIdx)) continue;
    const sourceRow = BASELINE_ROADS[rIdx];
    const edited = baselineEdits.edits[String(rIdx)];
    const props = pickProps(baselineEdits.roadProps[String(rIdx)]);
    const materialOverrides = pickOverrides(baselineEdits.materialOverrides[String(rIdx)]);
    if (edited && edited.length >= 2) {
      const synth: (number | string)[] = [sourceRow[0], sourceRow[1], sourceRow[2], sourceRow[3]];
      for (const p of edited) synth.push(p[0], p[1]);
      const synthRow = synth as unknown as BaselineRoadRow;
      RENDER_ENTRIES.push({
        row: synthRow,
        smoothed: smoothFlatPolyline(synthRow.slice(4) as readonly number[]),
        ...props,
        ...(materialOverrides ? { materialOverrides } : {}),
      });
    } else {
      RENDER_ENTRIES.push({
        row: sourceRow,
        smoothed: smoothFlatPolyline(sourceRow.slice(4) as readonly number[]),
        ...props,
        ...(materialOverrides ? { materialOverrides } : {}),
      });
    }
  }
  for (let oIdx = 0; oIdx < overlay.roads.length; oIdx++) {
    const raw = overlay.roads[oIdx];
    const synth = overlayRowToBaseline(raw as readonly (string | number)[]);
    if (!synth) continue;
    const pts = synth.slice(4) as readonly number[];
    if (pts.length < 4) continue;
    const props = pickProps(overlay.roadProps[String(oIdx)]);
    const materialOverrides = pickOverrides(overlay.materialOverrides[String(oIdx)]);
    // H787: merge rows have odd raw length with row[4] = mergeFlag
    // (tens = mergeType, ones = mergeAlign). overlayRowToBaseline
    // strips the flag for the synth row; decode it here so the render
    // can route merge rows to the polygon pipeline.
    const rawArr = raw as readonly (string | number)[];
    const _mergeFlag = rawArr.length % 2 === 1 ? ((rawArr[4] as number) | 0) : 0;
    RENDER_ENTRIES.push({
      row: synth,
      smoothed: smoothFlatPolyline(pts),
      fromOverlay: true,
      ...props,
      ...(materialOverrides ? { materialOverrides } : {}),
      ...(_mergeFlag > 0
        ? {
            mergeType: Math.floor(_mergeFlag / 10),
            mergeAlign: _mergeFlag % 10 || 1,
          }
        : {}),
    });
  }
  // H141: sort ground-first so elevated roads paint OVER ground roads
  // (mirrors monolith L19166 `_sortedRoadsByZ` ascending sort). Without
  // this the bridge concrete would be hidden by minor roads that were
  // appended after the highways in BASELINE_ROADS source order.
  RENDER_ENTRIES.sort((a, b) => (a.row[3] as number) - (b.row[3] as number));
  // H141: compute bridge crossing points AFTER the z-sort so an
  // elevated entry can scan against every lower-z entry in the final
  // render order. The pass mutates entries in place — bridgePts ends
  // up populated only on entries with z >= 2 that actually cross
  // something lower.
  computeBridgePts(RENDER_ENTRIES);
  // H275: per-entry bbox of the smoothed polyline (in WORLD pixels).
  // Lets drawBaselineRoads + drawBridgeOverlays skip roads entirely
  // outside the visible viewport without a per-segment hit. Padded by
  // ~2 tiles to cover the asphaltW + edge band tint footprint past
  // each polyline vertex.
  const BBOX_PAD = 2 * TILE;
  for (const entry of RENDER_ENTRIES) {
    const pts = entry.smoothed;
    if (pts.length < 2) continue;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i + 1 < pts.length; i += 2) {
      const x = pts[i]     * TILE;
      const y = pts[i + 1] * TILE;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    entry.bbox = {
      minX: minX - BBOX_PAD,
      minY: minY - BBOX_PAD,
      maxX: maxX + BBOX_PAD,
      maxY: maxY + BBOX_PAD,
    };
  }
  // H650: build Path2D caches per entry — main asphalt path, centerline,
  // lane dividers, edge fog lines, inner-edge yellow stripes. All
  // expensive polyline walks (tracePath / tracePathOffset) now happen
  // once at rebuild time instead of every frame in strokeRoad /
  // strokeRoadMarkings. Per-frame stroke calls become ctx.stroke(path).
  buildRoadPathCaches(RENDER_ENTRIES);
  // H281: detect T-junctions (one road's endpoint on another road's
  // segment middle). Must run AFTER the bbox loop above — the detector
  // uses entry.bbox for an O(N) early-out that drops >95% of the
  // O(N²) candidate pairs on the Charlotte baseline. Populates
  // entry.teeJunctions for the H282 edge-erase render pass.
  computeTeeJunctions(RENDER_ENTRIES);
  // H283: detect auto-tapers (this entry's endpoint sharing a vertex
  // with a wider peer entry's endpoint). Populates
  // entry.autoTaperStart / autoTaperEnd with the flared polygon edges
  // for the H284 render pass — taper polygon fill + edge stripes that
  // visually widen the narrow road's asphalt at the junction to match
  // the peer's. Independent of teeJunctions: tee = endpoint on mid-
  // segment (T-shape); auto-taper = endpoint on endpoint with width
  // mismatch (Y or stub-join with flared transition).
  computeAutoTapers(RENDER_ENTRIES);
  // H787: bake the merge-row polygon geometry (one-lane asymmetric
  // ribbon + gore apexes). Needs rawPts (buildRoadPathCaches above).
  buildMergePolygons(RENDER_ENTRIES);
  // H788: detect same-z 4-way crossings for the junction-box marking
  // erase. Needs rawPts + laneGeom (buildRoadPathCaches) and runs
  // after buildMergePolygons so merge entries can be excluded.
  computeRoadCrossings(RENDER_ENTRIES);
  // H790: rounded end-caps for free road termini.
  computeEndCaps(RENDER_ENTRIES);
  // H785: rebuild the bridge-layer structures from the final entry
  // list (baseline + editor edits + overlay rows, post z-sort).
  // Synthetic structure ids/upper-road lookups key on road NAME, and
  // editor roads commonly share the default "New Road" — suffix
  // duplicates so every elevated road gets its own structure and the
  // layer system's name→polyline lookup stays unambiguous.
  const _bridgeRoads: BridgeRoadFull[] = [];
  const _bridgeSources: BridgeRoadFull[] = [];
  const _bridgeNameSeen = new Map<string, number>();
  for (const entry of RENDER_ENTRIES) {
    const rawPts = entry.rawPts;
    if (!rawPts || rawPts.length < 2) continue;
    const baseName = String(entry.row[2] ?? 'road');
    const dupes = _bridgeNameSeen.get(baseName) ?? 0;
    _bridgeNameSeen.set(baseName, dupes + 1);
    const br: BridgeRoadFull = {
      name: dupes === 0 ? baseName : `${baseName}#${dupes}`,
      pts: rawPts,
      maj: entry.row[1] === 1,
      z: entry.row[3] as number,
      _prof: {
        totalW: entry.laneGeom?.asphaltW
          ?? laneStandardizedWidth(baseName, entry.row[0] as number),
      },
    };
    _bridgeRoads.push(br);
    // H791: only editor-drawn elevated roads own collision structures.
    if (entry.fromOverlay) _bridgeSources.push(br);
  }
  rebuildBridgeStructures(_bridgeRoads, _bridgeSources);
}

// H559: initial build moved to end-of-file. Was here at L1039
// where it fired before const declarations further down
// (LANE_W_STD at L1099 etc.) had initialized — function-hoisted
// getLaneGeom was callable but its `const carriageW = lps * 2 *
// LANE_W_STD` read threw a TDZ ReferenceError, crashing module
// load with a black screen. See bottom of file for the relocated
// call.

/** Yellow centerline color — solid, matches monolith pass 13 (#f0c83a,
 *  US-DOT bright yellow, 1.4 px). Drawn on any road with w >= 3 so
 *  minor city streets get parity with majors. */
const CENTERLINE_COLOR = '#f0c83a';
const CENTERLINE_WIDTH = 1.4;
/** White dashed lane divider — matches monolith pass 14 (L31250-L31251:
 *  rgba(255,255,255,0.55), [6,8] dash pattern, 1.2 px). The prior
 *  rgba(220,220,220,0.85) + [12,12] read too solid/bright vs the white
 *  edge stripes, and the longer dashes didn't match real US-DOT lane-
 *  marking proportions (~6 ft dash / 8 ft gap at world scale). */
const LANE_DIVIDER_COLOR = 'rgba(255, 255, 255, 0.55)';
const LANE_DIVIDER_DASH: [number, number] = [6, 8];
const LANE_DIVIDER_WIDTH = 1.2;
/** White edge stripe ("fog line") — solid, both sides of the asphalt.
 *  Color + width match monolith pass 15 (L31360: rgba(255,255,255,0.78),
 *  1.4 px). Fixed-pixel 1.7-px inset from the asphalt edge regardless
 *  of road width (v8.99.124.36) keeps the stripe at a consistent
 *  distance independent of road class. */
const EDGE_STRIPE_COLOR = 'rgba(255, 255, 255, 0.78)';
const EDGE_STRIPE_WIDTH = 1.4;
const EDGE_STRIPE_INSET_PX = 1.7;
/** H665: hoisted wear/oil setLineDash arrays. Pre-H665 these were
 *  literal-array allocations inside strokeRoadMarkings, so every
 *  visible major road allocated 4 fresh 8-element arrays per frame
 *  (and after H662 chunking, that's per visible chunk too). Reusing
 *  the same const arrays cuts the alloc; setLineDash doesn't mutate
 *  its input so sharing is safe. Sums + per-pass dash-phase steps
 *  documented at the strokeRoadMarkings call sites. */
const WEAR_DASH_PASS2: readonly number[] = [70, 35, 45, 60, 90, 30, 50, 80];
const WEAR_DASH_PASS3: readonly number[] = [55, 25, 70, 40, 65, 35, 50, 57];
const OIL_DASH_PASS2:  readonly number[] = [55, 70, 30, 90, 40, 50, 80, 35];
const OIL_DASH_PASS3:  readonly number[] = [45, 60, 35, 80, 25, 55, 70, 31];
/** Yellow inner-edge stripes for divided highways — solid, both sides
 *  of the median. Color + width match monolith pass 18 (L31569:
 *  rgba(240,200,58,0.85), 1.4 px). Drawn only on I-485 (grass median)
 *  and I-77/I-85 (jersey barrier, w >= 12); regular roads keep the
 *  yellow centerline instead. */
const INNER_EDGE_COLOR = 'rgba(240, 200, 58, 0.85)';
const INNER_EDGE_WIDTH = 1.4;
/** I-485 grass median — dark green strip running between the two
 *  carriageways. Color matches monolith pass 11 (L31214: #1a3a1a).
 *  Stroked at width = medHalf*2*TILE so it spans the full median
 *  between the inner-edge yellow stripes. */
const GRASS_MEDIAN_COLOR = '#1a3a1a';
/** I-77/I-85 jersey barrier — thin concrete-gray stroke down the
 *  centerline of w >= 12 interstates (sans I-485). Color + width
 *  match monolith pass 12 (L31220-L31223: #555 at lineWidth 2). The
 *  H262 inner-edge yellow stripes flank this stroke to produce the
 *  classic "yellow / concrete / yellow" jersey-barrier band. */
const JERSEY_BARRIER_COLOR = '#555';
const JERSEY_BARRIER_WIDTH = 2;
/** H285: lane-add channelizing stripe — width + color + dash pattern.
 *  Erase width 2.4 px (wider than the 1.4-px stripe so the asphalt
 *  overpaint fully covers it). Dash [6, 8] unifies with the in-game
 *  lane divider pattern so the painted-marking hierarchy reads as one
 *  coherent system. Color rgba(240,240,240,0.78) matches monolith
 *  L31435. */
const LANE_ADD_ERASE_WIDTH = 2.4;
const LANE_ADD_DASH_WIDTH = 1.4;
const LANE_ADD_DASH_COLOR = 'rgba(240, 240, 240, 0.78)';
const LANE_ADD_DASH: [number, number] = [6, 8];

// H271 + H272 (tire-wear band + oil-drip streak constants) deleted in
// H278 along with the per-frame stroke loop they fed. Both are
// re-introducible once chunking lands — see monolith pass 7
// (L31197-L31265) for wear and pass 8 (L31267-L31332) for oil.
/** US-DOT standard lane width (12 ft @ ~9.4 ft/tile). Mirrors monolith
 *  L18602 LANE_W_STD. Used by inner-edge stripe geometry to derive
 *  median half-width from lane-count + median-fraction config. */
const LANE_W_STD = 1.275;

/** Per-road lane / median geometry. Mirrors monolith L18604-L18632
 *  getRoadProfile: maps (name, w) to lanes-per-side, median half-
 *  width (tiles), and whether the median is "real" enough to warrant
 *  divided-highway treatment (grass median or jersey barrier rendering
 *  + yellow inner-edge stripes instead of a centerline).
 *
 *  H265: also returns positive dividerOffsets in tile units. Callers
 *  mirror across ± for the per-side stripes. Replaces the H259
 *  hardcoded halfW*0.33/0.67 fractions with the same laneW-aware
 *  positions the monolith uses (medHalf + i*laneW). */
interface LaneGeom {
  /** Lanes per side. 1 = one-lane road, 2 = standard 4-lane, etc. */
  lps: number;
  /** Median half-width in tiles — the physical median between the two
   *  carriageways' inner asphalt edges. Used by inner-edge stripe
   *  geometry (medHalf + 1.7/TILE inset). */
  medHalf: number;
  /** H287: effective grass-median half-width. The visible grass strip
   *  is medHalf minus the inner shoulders that eat into the median —
   *  the leftmost lane sits against the inner shoulder, not against
   *  the grass directly. Mirrors monolith L18758 `effectiveMedHalf =
   *  max(0, medHalf - shoulderW)`. Used by the I-485 grass median
   *  pass to paint the green strip at its true narrowed width. For
   *  jersey-barrier highways (medHalf < shoulderW), clamps to 0. */
  effectiveMedHalf: number;
  /** Total carriageway + median width in tiles. Mirrors monolith
   *  L18620 `totalW = carriageW + medHalf*2`. Used by the bridge-
   *  deck pass for the outer concrete width. */
  totalW: number;
  /** Visible asphalt stroke width in tiles. For divided highways =
   *  totalW + 2*shoulderW (one laneW of shoulder past each carriageway
   *  edge); for non-divided = totalW. Mirrors monolith L18757
   *  `asphaltW = totalW + 2*shoulderW`. */
  asphaltW: number;
  /** Whether the road gets divided-highway markings (grass / jersey
   *  barrier + flanking yellow stripes, no centerline). */
  isDivided: boolean;
  /** Positive divider offsets from the centerline (tile units). For
   *  each `off` the renderer paints two dashed stripes at +off and
   *  -off. Length === lps - 1. */
  dividerOffsets: number[];
  /** H561: tire-wear track offsets in tiles, signed (both sides of
   *  the road). Two per lane at lane_center ± laneW*0.25 — the
   *  wheel paths each lane's traffic actually rolls on. Length ===
   *  4 * lps. Empty for non-divided / minor roads (only majors get
   *  the wear pass). Mirrors monolith L18644 wearOffsets. */
  wearOffsets: number[];
  /** H561: oil-drip offsets in tiles, signed (both sides). One per
   *  lane center — engine/transmission drips concentrate down the
   *  middle of each lane. Length === 2 * lps. Empty for non-divided /
   *  minor roads. Mirrors monolith L18647 oilOffsets. */
  oilOffsets: number[];
  /** H561: nominal lane width in tiles — used by the wear/oil pass
   *  to size dashed stripe widths (baseWearW = laneW*TILE*0.18 etc).
   *  Mirrors monolith prof.laneW. */
  laneW: number;
}

/** H677: quick-fallback total asphalt width (tiles) when an entry's
 *  cached `laneGeom` isn't available (editor preview path during
 *  drag-edits). Computes a getLaneGeom-equivalent asphaltW without
 *  the dividerOffsets / wear / oil arrays, so the call site that
 *  only needs the width can stay cheap. */
function laneStandardizedWidth(name: string, w: number): number {
  let lps: number;
  let medFrac: number;
  let isDivided: boolean;
  if (name === 'I-485') {
    lps = 3; medFrac = 0.25; isDivided = true;
  } else if (w >= 12) {
    lps = 4; medFrac = 0.02; isDivided = true;
  } else if (w >= 8) {
    lps = 3; medFrac = 0.02; isDivided = false;
  } else if (w >= 6) {
    lps = 2; medFrac = 0;    isDivided = false;
  } else {
    lps = 1; medFrac = 0;    isDivided = false;
  }
  const carriageW = lps * 2 * LANE_W_STD;
  const medHalf = (medFrac > 0) ? carriageW * medFrac * 0.5 : 0;
  const totalW = carriageW + medHalf * 2;
  const shoulderW = isDivided ? 0.5 * LANE_W_STD : 0;
  return totalW + 2 * shoulderW;
}

function getLaneGeom(name: string, w: number): LaneGeom {
  let lps: number;
  let medFrac: number;
  let isDivided: boolean;
  if (name === 'I-485') {
    lps = 3; medFrac = 0.25; isDivided = true;
  } else if (w >= 12) {
    lps = 4; medFrac = 0.02; isDivided = true;
  } else if (w >= 8) {
    lps = 3; medFrac = 0.02; isDivided = false;
  } else if (w >= 6) {
    lps = 2; medFrac = 0;    isDivided = false;
  } else {
    lps = 1; medFrac = 0;    isDivided = false;
  }
  const carriageW = lps * 2 * LANE_W_STD;
  const medHalf = (medFrac > 0) ? carriageW * medFrac * 0.5 : 0;
  const totalW = carriageW + medHalf * 2;
  // H274: shoulder math. Divided highways (real median) get a 0.5×laneW
  // paved shoulder past each carriageway edge; non-divided roads have
  // no shoulder. Mirrors monolith L18756.
  const shoulderW = isDivided ? 0.5 * LANE_W_STD : 0;
  const asphaltW = totalW + 2 * shoulderW;
  // H287: inner shoulders eat into the median area, so the visible grass
  // strip is narrower than medHalf by shoulderW per side. For I-485
  // (medHalf > shoulderW): grass narrows by 2*shoulderW. For w>=12 jersey
  // barrier (medHalf < shoulderW): clamps to 0 — the leftmost lanes sit
  // directly against the barrier with no usable inner-shoulder gap.
  // Mirrors monolith L18758.
  const effectiveMedHalf = Math.max(0, medHalf - shoulderW);
  const dividerOffsets: number[] = [];
  for (let i = 1; i < lps; i++) {
    dividerOffsets.push(medHalf + i * LANE_W_STD);
  }
  // H561: wear / oil offsets — only meaningful when the road has
  // multiple lanes per side (lps >= 2). Single-lane minors get empty
  // arrays so the wear/oil pass no-ops cheaply for them.
  //
  // Lane center for lane i (0-indexed from the centerline outward) is
  // medHalf + (i + 0.5) * LANE_W_STD. The wear-track inset is
  // LANE_W_STD * 0.25 — wheels roll a quarter-lane in from each side
  // of the lane center. Mirrors monolith L18638-L18656.
  const wearOffsets: number[] = [];
  const oilOffsets: number[] = [];
  if (lps >= 2) {
    const wearInset = LANE_W_STD * 0.25;
    for (let i = 0; i < lps; i++) {
      const laneCenter = medHalf + (i + 0.5) * LANE_W_STD;
      // Wear: two tracks per lane, both signs (4 entries / lane).
      wearOffsets.push(laneCenter - wearInset);
      wearOffsets.push(laneCenter + wearInset);
      wearOffsets.push(-(laneCenter - wearInset));
      wearOffsets.push(-(laneCenter + wearInset));
      // Oil: one entry at lane center per side.
      oilOffsets.push(laneCenter);
      oilOffsets.push(-laneCenter);
    }
  }
  return {
    lps, medHalf, effectiveMedHalf, totalW, asphaltW, isDivided,
    dividerOffsets, wearOffsets, oilOffsets, laneW: LANE_W_STD,
  };
}

function tracePath(ctx: CanvasRenderingContext2D, pts: readonly number[]): void {
  ctx.beginPath();
  ctx.moveTo(pts[0] * TILE, pts[1] * TILE);
  for (let i = 2; i + 1 < pts.length; i += 2) {
    ctx.lineTo(pts[i] * TILE, pts[i + 1] * TILE);
  }
}

/** H650: build a Path2D from a smoothed polyline (flat tile-coord array).
 *  Same math as tracePath, just into a free-standing Path2D instead of a
 *  CanvasRenderingContext2D. World-pixel coords (* TILE). */
function buildPolylinePath(pts: readonly number[]): Path2D {
  const p = new Path2D();
  if (pts.length < 4) return p;
  p.moveTo(pts[0] * TILE, pts[1] * TILE);
  for (let i = 2; i + 1 < pts.length; i += 2) {
    p.lineTo(pts[i] * TILE, pts[i + 1] * TILE);
  }
  return p;
}

/** H650/H783: central-difference perpendicular offset samples in WORLD
 *  px (flat [x0,y0,...]). Shared by buildOffsetPath and
 *  buildDashedOffsetPath — same normal math as tracePathOffset (the
 *  per-frame helper), kept in lockstep so cached paths match the
 *  fallback path pixel-for-pixel. */
function offsetSamplesWorldPx(pts: readonly number[], tileOffset: number): number[] {
  const n = pts.length / 2;
  const out: number[] = new Array(n * 2);
  for (let s = 0; s < n; s++) {
    const pi = Math.max(0, s - 1);
    const ni = Math.min(n - 1, s + 1);
    const tdx = (pts[ni * 2]     as number) - (pts[pi * 2]     as number);
    const tdy = (pts[ni * 2 + 1] as number) - (pts[pi * 2 + 1] as number);
    const tlen = Math.sqrt(tdx * tdx + tdy * tdy) || 1;
    const nx = -tdy / tlen;
    const ny =  tdx / tlen;
    out[s * 2]     = ((pts[s * 2]     as number) + nx * tileOffset) * TILE;
    out[s * 2 + 1] = ((pts[s * 2 + 1] as number) + ny * tileOffset) * TILE;
  }
  return out;
}

/** H650: build a Path2D from a smoothed polyline at a perpendicular
 *  tile-offset. */
function buildOffsetPath(pts: readonly number[], tileOffset: number): Path2D {
  const p = new Path2D();
  const n = pts.length / 2;
  if (n < 2) return p;
  const op = offsetSamplesWorldPx(pts, tileOffset);
  p.moveTo(op[0], op[1]);
  for (let i = 2; i + 1 < op.length; i += 2) {
    p.lineTo(op[i], op[i + 1]);
  }
  return p;
}

/** H783: build a Path2D whose subpaths are the "on" intervals of a
 *  canvas dash pattern applied along the offset polyline. Replaces the
 *  per-frame per-lane dashed strokes of the wear/oil emphasis passes —
 *  GPU raster cost is ~per stroke CALL, so 12 dashed lane strokes per
 *  chunk became the highway frame budget. Baking the dashes into
 *  geometry lets the whole pass stroke ONE solid path per chunk.
 *
 *  `phase` matches the lineDashOffset the runtime pass used
 *  (ck.dashLen + lane stagger): canvas dash semantics put the pattern
 *  position at arc length s at (phase + s) mod sum, with the pattern
 *  starting "on" at index 0. Butt caps + round joins reproduce the
 *  dashed-stroke pixels exactly. */
function buildDashedOffsetPath(
  pts: readonly number[],
  tileOffset: number,
  dash: readonly number[],
  phase: number,
): Path2D {
  const p = new Path2D();
  const n = pts.length / 2;
  if (n < 2 || dash.length === 0) return p;
  // Canvas duplicates odd-length dash arrays; mirror that.
  const pat = dash.length % 2 === 1 ? [...dash, ...dash] : dash;
  let sum = 0;
  for (const d of pat) sum += d;
  if (!(sum > 0)) return p;
  const op = offsetSamplesWorldPx(pts, tileOffset);
  // Pattern state at arc length 0.
  let pos = ((phase % sum) + sum) % sum;
  let di = 0;
  while (pos >= pat[di]) { pos -= pat[di]; di++; }
  let remaining = pat[di] - pos;
  let penDown = false;
  let ax = op[0], ay = op[1];
  for (let i = 0; i + 3 < op.length; i += 2) {
    const bx = op[i + 2], by = op[i + 3];
    const sdx = bx - ax, sdy = by - ay;
    let segLen = Math.sqrt(sdx * sdx + sdy * sdy);
    if (segLen <= 1e-9) { ax = bx; ay = by; continue; }
    const ux = sdx / segLen, uy = sdy / segLen;
    while (segLen > 1e-9) {
      const step = Math.min(segLen, remaining);
      const ex = ax + ux * step, ey = ay + uy * step;
      if ((di & 1) === 0) { // "on" interval
        if (!penDown) { p.moveTo(ax, ay); penDown = true; }
        p.lineTo(ex, ey);
      }
      ax = ex; ay = ey;
      segLen -= step;
      remaining -= step;
      if (remaining <= 1e-9) {
        di = (di + 1) % pat.length;
        remaining = pat[di];
        penDown = false; // pen lifts at every interval boundary
      }
    }
    // Snap to the exact vertex so float drift never accumulates.
    ax = bx; ay = by;
  }
  return p;
}

/** H662: smoothed-samples per chunk. Monolith uses 12 source vertices
 *  per chunk (L18976). At 8× Catmull-Rom densification that's 96
 *  samples — matches the same physical chunk length the monolith
 *  picked. The +1 overlap baked into buildChunks below makes adjacent
 *  chunks share their boundary sample so wide strokes visually join
 *  without gaps. */
const CHUNK_SAMPLES = 96;
/** H662: only chunk roads whose bbox dim exceeds this — short roads
 *  (city streets, ramps) aren't worth the per-chunk Path2D + cull
 *  overhead. Mirrors monolith CHUNK_THRESHOLD at L18978. */
const CHUNK_THRESHOLD_PX = 1500;

/** H662: split a smoothed flat polyline into CHUNK_SAMPLES-sized
 *  pieces with one-sample overlap so adjacent chunks visually join.
 *  Returns `null` when the polyline is too short to benefit. Each
 *  returned chunk carries its own `pts` subarray (zero-copy slice via
 *  Array.prototype.slice) plus the cumulative px length from the
 *  polyline origin to the chunk's first sample. */
interface ChunkSpec {
  pts: number[];
  dashLen: number;
  bbox: { minX: number; minY: number; maxX: number; maxY: number };
}
function chunkSmoothed(
  smoothed: readonly number[],
  pad: number,
  bboxDim: number,
): ChunkSpec[] | null {
  const N = smoothed.length / 2;
  if (N < CHUNK_SAMPLES + 2) return null;
  if (bboxDim <= CHUNK_THRESHOLD_PX) return null;
  const chunks: ChunkSpec[] = [];
  let cumLen = 0;
  let cumAt = 0;
  for (let cStart = 0; cStart < N - 1; cStart += CHUNK_SAMPLES) {
    // Advance cumulative px-length from the prior chunk's start to this one.
    while (cumAt < cStart) {
      const dx = (smoothed[(cumAt + 1) * 2]     - smoothed[cumAt * 2]    ) * TILE;
      const dy = (smoothed[(cumAt + 1) * 2 + 1] - smoothed[cumAt * 2 + 1]) * TILE;
      cumLen += Math.sqrt(dx * dx + dy * dy);
      cumAt++;
    }
    // +1 sample overlap so adjacent chunks share their boundary point.
    const cEnd = Math.min(cStart + CHUNK_SAMPLES + 1, N);
    if (cEnd - cStart < 2) continue;
    const sub: number[] = new Array((cEnd - cStart) * 2);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < cEnd - cStart; i++) {
      const x = smoothed[(cStart + i) * 2];
      const y = smoothed[(cStart + i) * 2 + 1];
      sub[i * 2]     = x;
      sub[i * 2 + 1] = y;
      const wx = x * TILE;
      const wy = y * TILE;
      if (wx < minX) minX = wx;
      if (wy < minY) minY = wy;
      if (wx > maxX) maxX = wx;
      if (wy > maxY) maxY = wy;
    }
    chunks.push({
      pts: sub,
      dashLen: cumLen,
      bbox: { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad },
    });
  }
  return chunks.length > 1 ? chunks : null;
}

/** H772: build a Path2D containing only the segments of `pts` whose
 *  midpoint or either endpoint lies within BRIDGE_R_TILES of any
 *  bridgePoint. Mirrors the per-segment `nearBridge` triple-check the
 *  old drawBridgeOverlay did per-frame; doing it once at chunk-build
 *  time bakes the result into a Path2D the renderer can stroke 3×
 *  with no inner loop. Returns null when no segment qualifies (caller
 *  leaves chunk.bridgePath undefined). */
function buildBridgeSegPath(
  pts: number[],
  bridgePts: ReadonlyArray<{ x: number; y: number }>,
): Path2D | null {
  const n = pts.length / 2;
  if (n < 2) return null;
  const path = new Path2D();
  const R2 = BRIDGE_R_TILES * BRIDGE_R_TILES;
  let any = false;
  let lastIdx = -1;
  for (let i = 0; i < n - 1; i++) {
    const x0 = pts[i * 2]     as number;
    const y0 = pts[i * 2 + 1] as number;
    const x1 = pts[(i + 1) * 2]     as number;
    const y1 = pts[(i + 1) * 2 + 1] as number;
    const mx = (x0 + x1) * 0.5;
    const my = (y0 + y1) * 0.5;
    let near = false;
    for (const bp of bridgePts) {
      const dxm = mx - bp.x; const dym = my - bp.y;
      if (dxm * dxm + dym * dym < R2) { near = true; break; }
      const dx0 = x0 - bp.x; const dy0 = y0 - bp.y;
      if (dx0 * dx0 + dy0 * dy0 < R2) { near = true; break; }
      const dx1 = x1 - bp.x; const dy1 = y1 - bp.y;
      if (dx1 * dx1 + dy1 * dy1 < R2) { near = true; break; }
    }
    if (!near) { lastIdx = -1; continue; }
    if (lastIdx !== i) {
      path.moveTo(x0 * TILE + TILE / 2, y0 * TILE + TILE / 2);
    }
    path.lineTo(x1 * TILE + TILE / 2, y1 * TILE + TILE / 2);
    lastIdx = i + 1;
    any = true;
  }
  return any ? path : null;
}

/** H662: build a RoadChunk[] from per-chunk pts + dashLen specs and
 *  the LaneGeom-derived stripe offsets that this road needs. Per-pass
 *  Path2Ds are only built when the corresponding offset array is
 *  non-empty so minor roads (no dividers / wear / oil) don't pay for
 *  paths they'll never stroke. */
function buildChunks(
  specs: ChunkSpec[],
  w: number,
  laneGeom: LaneGeom,
  bridgePts?: ReadonlyArray<{ x: number; y: number }>,
): RoadChunk[] {
  const { dividerOffsets, wearOffsets, oilOffsets, isDivided, medHalf, asphaltW } = laneGeom;
  const insetTiles = EDGE_STRIPE_INSET_PX / TILE;
  const shoulderTiles = isDivided ? 0.5 * LANE_W_STD : 0;
  // H679: track lane-standardized asphaltW, not raw `w`. H677 narrowed
  // the asphalt stroke (e.g. w=5 minor: 5 → 2.55 tiles) but left this
  // edge-stripe offset on the raw w, so the stripes ended up well
  // outside the asphalt — visible as "border lines not connecting" on
  // minors and a strip of asphalt past the fog line on highways.
  const edgeOff = w >= 3 ? asphaltW * 0.5 - shoulderTiles - insetTiles : 0;
  const innerOff = isDivided ? medHalf + insetTiles : 0;
  const out: RoadChunk[] = [];
  for (const spec of specs) {
    const mainPath = buildPolylinePath(spec.pts);
    const chunk: RoadChunk = {
      bbox: spec.bbox,
      pts: spec.pts,
      mainPath,
      dashLen: spec.dashLen,
    };
    if (dividerOffsets.length > 0) {
      const dAll = new Path2D();
      for (const off of dividerOffsets) {
        dAll.addPath(buildOffsetPath(spec.pts, off));
        dAll.addPath(buildOffsetPath(spec.pts, -off));
      }
      chunk.dividerPathAll = dAll;
    }
    if (edgeOff > 0) {
      const eAll = new Path2D();
      eAll.addPath(buildOffsetPath(spec.pts, edgeOff));
      eAll.addPath(buildOffsetPath(spec.pts, -edgeOff));
      chunk.edgePathAll = eAll;
    }
    if (isDivided && innerOff > 0) {
      const iAll = new Path2D();
      iAll.addPath(buildOffsetPath(spec.pts, innerOff));
      iAll.addPath(buildOffsetPath(spec.pts, -innerOff));
      chunk.innerEdgePathAll = iAll;
    }
    if (wearOffsets.length > 0) {
      const wAll = new Path2D();
      const wDash = new Path2D();
      for (let i = 0; i < wearOffsets.length; i++) {
        wAll.addPath(buildOffsetPath(spec.pts, wearOffsets[i]));
        // Phase mirrors the runtime pass: ck.dashLen + lane index * 37.
        wDash.addPath(buildDashedOffsetPath(
          spec.pts, wearOffsets[i], WEAR_DASH_PASS2, spec.dashLen + i * 37));
      }
      chunk.wearPathAll = wAll;
      chunk.wearDash2Path = wDash;
    }
    if (oilOffsets.length > 0) {
      const oAll = new Path2D();
      const oDash = new Path2D();
      for (let i = 0; i < oilOffsets.length; i++) {
        oAll.addPath(buildOffsetPath(spec.pts, oilOffsets[i]));
        // Phase mirrors the runtime pass: ck.dashLen + i * 73 + 200.
        oDash.addPath(buildDashedOffsetPath(
          spec.pts, oilOffsets[i], OIL_DASH_PASS2, spec.dashLen + i * 73 + 200));
      }
      chunk.oilPathAll = oAll;
      chunk.oilDash2Path = oDash;
    }
    if (bridgePts && bridgePts.length > 0) {
      const bp = buildBridgeSegPath(spec.pts, bridgePts);
      if (bp) chunk.bridgePath = bp;
    }
    out.push(chunk);
  }
  return out;
}

/** H650 + H657 + H662: build the per-entry preprocessed caches that
 *  strokeRoad / strokeRoadMarkings consume each frame. Called once at
 *  the end of refreshRenderEntries (after smoothing + bbox but before
 *  T-junction detection, since the detectors don't need these caches).
 *
 *  H657 bisected away the Path2D builds because — without chunking —
 *  Chromium's retained-mode dispatch wasn't GPU-accelerating I-485's
 *  full ~1000-sample path; the imperative trace was faster per frame.
 *  H662 restores Path2D building INSIDE chunked sub-paths: each chunk
 *  is short (≤96 samples), and the per-chunk bbox cull means most
 *  chunks never get stroked at all. That moves the per-frame cost from
 *  "all stripes × full polyline" to "all stripes × visible chunks
 *  only" — a 5–10× reduction on big highways. Short roads (below
 *  CHUNK_THRESHOLD_PX) stay on the imperative fallback because the
 *  bisect's finding still applies to them. */
function buildRoadPathCaches(entries: RenderEntry[]): void {
  for (const entry of entries) {
    // H651: rawPts cache for the nearest-road scans. Always populated
    // (cheap allocation) regardless of smoothed length.
    entry.rawPts = polylinePoints(entry.row);
    const pts = entry.smoothed;
    if (pts.length < 4) continue;
    const w = entry.row[0];
    const name = String(entry.row[2] ?? '');
    // H652: cache the LaneGeom on the entry so strokeRoadMarkings can
    // skip the per-frame getLaneGeom() call (string compares + arith).
    // name + w are immutable per-entry so this never goes stale.
    entry.laneGeom = getLaneGeom(name, w);
    // H662: chunk long roads. Pad the per-chunk bbox by the road's
    // half-width plus a small margin so wide strokes whose stroke band
    // extends past the chunk's sample bbox still trigger the cull.
    // H677: half-width now derives from the lane-standardized asphaltW
    // matching the actual stroke width.
    const pad = entry.laneGeom.asphaltW * TILE * 0.5 + 8;
    const bb = entry.bbox;
    const bboxDim = bb ? Math.max(bb.maxX - bb.minX, bb.maxY - bb.minY) : 0;
    const specs = chunkSmoothed(pts, pad, bboxDim);
    if (specs) {
      entry.chunks = buildChunks(specs, w as number, entry.laneGeom, entry.bridgePts);
    }
  }
}

/** H787: bake the in-game render geometry for editor merge rows.
 *
 *  Mirrors the editor's _weDrawTaperedMergeRoad inputs (H786): bond
 *  detection is edge-aware (an endpoint counts as bonded when it sits
 *  within destHalfW + 1 of another road's centerline — bonded tips are
 *  placed ON the destination's edge stripe, ≈destHalfW out), inner
 *  directions resolve against the bonded road specifically, and
 *  cloverleaf rows coerce to click-bonded asymmetric. The resulting
 *  one-lane polygon is converted to world-px Path2Ds once at rebuild;
 *  strokeRoad then renders fill + two edge strokes per frame. */
function buildMergePolygons(entries: RenderEntry[]): void {
  interface MergeBondRoad extends InnerDirRoad { halfW: number }
  let roadsList: MergeBondRoad[] | null = null;
  const buildRoadsList = (): MergeBondRoad[] => {
    const out: MergeBondRoad[] = [];
    for (const e of entries) {
      if (!e.rawPts || e.rawPts.length < 2) continue;
      out.push({
        pts: e.rawPts,
        halfW: (e.laneGeom?.asphaltW
          ?? laneStandardizedWidth(String(e.row[2] ?? ''), e.row[0] as number)) * 0.5,
      });
    }
    return out;
  };
  for (const entry of entries) {
    entry.mergePaths = undefined;
    if (entry.mergeAlign === undefined && entry.mergeType === undefined) continue;
    const pts = entry.rawPts;
    if (!pts || pts.length < 2) continue;
    if (!roadsList) roadsList = buildRoadsList();
    const self = roadsList.find((r) => r.pts === pts) ?? { pts, halfW: 0 };
    // Edge-aware nearest-road scan at one endpoint (H786 semantics).
    const bondedRoadAt = (ex: number, ey: number): MergeBondRoad | null => {
      let best: MergeBondRoad | null = null;
      let bestD2 = Infinity;
      for (const r of roadsList!) {
        if (r === self || r.pts === pts) continue;
        const rr = r.halfW + 1.0;
        const rr2 = rr * rr;
        for (let i = 0; i < r.pts.length - 1; i++) {
          const ax = r.pts[i][0];
          const ay = r.pts[i][1];
          const bx = r.pts[i + 1][0];
          const by = r.pts[i + 1][1];
          const dx = bx - ax;
          const dy = by - ay;
          const lenSq = dx * dx + dy * dy;
          if (lenSq < 0.0001) continue;
          let t = ((ex - ax) * dx + (ey - ay) * dy) / lenSq;
          if (t < 0) t = 0;
          else if (t > 1) t = 1;
          const qx = ax + dx * t;
          const qy = ay + dy * t;
          const d2 = (ex - qx) * (ex - qx) + (ey - qy) * (ey - qy);
          if (d2 <= rr2 && d2 < bestD2) {
            bestD2 = d2;
            best = r;
          }
        }
      }
      return best;
    };
    const bondedS = bondedRoadAt(pts[0][0], pts[0][1]);
    const bondedE = bondedRoadAt(pts[pts.length - 1][0], pts[pts.length - 1][1]);
    const mt = entry.mergeType ?? 0;
    // H786: cloverleaf loops are always outboard-asymmetric.
    const ma = mt === 1 ? 4 : (entry.mergeAlign || 1);
    const innerDirStart = ma !== 1 && bondedS
      ? _computeMergeInnerDir(pts, 0, [bondedS], self, bondedS.halfW + 1.0)
      : null;
    const innerDirEnd = ma !== 1 && bondedE
      ? _computeMergeInnerDir(pts, pts.length - 1, [bondedE], self, bondedE.halfW + 1.0)
      : null;
    const edges = _weBuildTaperedMergeEdges({
      tilePts: pts,
      prof: {},
      bondedStart: bondedS !== null,
      bondedEnd: bondedE !== null,
      innerDirStart,
      innerDirEnd,
      mergeAlign: ma,
      mergeType: mt,
    });
    if (!edges || edges.outer.length < 2) continue;
    const N = edges.outer.length;
    const fill = new Path2D();
    fill.moveTo(edges.outer[0][0] * TILE, edges.outer[0][1] * TILE);
    for (let i = 1; i < N; i++) fill.lineTo(edges.outer[i][0] * TILE, edges.outer[i][1] * TILE);
    for (let i = N - 1; i >= 0; i--) fill.lineTo(edges.inner[i][0] * TILE, edges.inner[i][1] * TILE);
    fill.closePath();
    const outer = new Path2D();
    outer.moveTo(edges.outer[0][0] * TILE, edges.outer[0][1] * TILE);
    for (let i = 1; i < N; i++) outer.lineTo(edges.outer[i][0] * TILE, edges.outer[i][1] * TILE);
    const inner = new Path2D();
    inner.moveTo(edges.inner[0][0] * TILE, edges.inner[0][1] * TILE);
    for (let i = 1; i < N; i++) inner.lineTo(edges.inner[i][0] * TILE, edges.inner[i][1] * TILE);
    entry.mergePaths = {
      fill,
      outer,
      inner,
      asym: !!(innerDirStart || innerDirEnd),
    };
  }
}

/** H259 — Central-difference perpendicular offset trace. For each
 *  sample, the tangent is computed from samples[s-1] → samples[s+1]
 *  (averaged across the vertex), and the offset uses that smoothed
 *  normal. Replaces the prior per-segment version, whose offsets
 *  jumped at each Catmull-Rom sample on curves, producing visible
 *  "swirling" zigzags in the lane dividers. Mirrors the monolith's
 *  drawRoadOverlay fallback path at L31310-L31318. */
function tracePathOffset(
  ctx: CanvasRenderingContext2D,
  pts: readonly number[],
  tileOffset: number,
): void {
  const n = pts.length / 2;
  if (n < 2) return;
  ctx.beginPath();
  for (let s = 0; s < n; s++) {
    const pi = Math.max(0, s - 1);
    const ni = Math.min(n - 1, s + 1);
    const tdx = (pts[ni * 2]     as number) - (pts[pi * 2]     as number);
    const tdy = (pts[ni * 2 + 1] as number) - (pts[pi * 2 + 1] as number);
    const tlen = Math.sqrt(tdx * tdx + tdy * tdy) || 1;
    const nx = -tdy / tlen;
    const ny =  tdx / tlen;
    const ox = (pts[s * 2]     as number) + nx * tileOffset;
    const oy = (pts[s * 2 + 1] as number) + ny * tileOffset;
    if (s === 0) ctx.moveTo(ox * TILE, oy * TILE);
    else ctx.lineTo(ox * TILE, oy * TILE);
  }
}

/** H259: paint the stripe stack on a road. Mirrors the monolith's
 *  drawRoadOverlay marking passes:
 *    - Major-only inner band + dashed lane dividers (lps >= 2, i.e.
 *      w >= 6) — paints the shoulders + lane separators.
 *    - Solid yellow centerline on any road with w >= 3 (monolith
 *      pass 13). Previously the centerline was gated to majors only,
 *      so minor city streets rendered as bare asphalt; with this
 *      gate moved out, the m0–m111 streets now paint a centerline
 *      matching their major counterparts.
 *  Caller is responsible for ctx.lineCap / lineJoin — this helper
 *  does not reset them. */
function strokeRoadMarkings(
  ctx: CanvasRenderingContext2D,
  entry: RenderEntry,
  visibleChunks: RoadChunk[] | null = null,
): void {
  const { row, smoothed: pts } = entry;
  const w = row[0];
  if (pts.length < 4) return;
  const name = String(row[2] ?? '');
  // H262/H265: divided-highway flag + lane geometry. medHalf gates the
  // grass / jersey-barrier passes, isDivided gates the centerline skip
  // and inner-edge stripe paint, dividerOffsets places the dashed
  // white lane dividers at the correct laneW-based positions.
  // H287: effectiveMedHalf for the I-485 grass median — the visible
  // grass strip is narrower than medHalf by the inner shoulders that
  // eat into the median area.
  // H652: prefer the cached LaneGeom on the entry (built once in
  // buildRoadPathCaches). Falls back to getLaneGeom for the editor
  // preview path, where pts may exist before the cache pass runs.
  const {
    medHalf, effectiveMedHalf, isDivided, dividerOffsets,
    wearOffsets, oilOffsets, laneW, asphaltW,
  } = entry.laneGeom ?? getLaneGeom(name, w);

  if (row[1] === 1) {
    // H561: tire-wear + oil-drip lane-aware stripes. Painted FIRST so
    // the subsequent major edge band tint (rgba 80,80,80,0.4) lightly
    // darkens them — matches the monolith z-order at L30814 (wear/oil)
    // before L31200 (major edge band). Gated on lps >= 2 so single-
    // lane minors don't pay the cost.
    //
    // Three passes per feature (wear, oil) layered for irregular
    // longitudinal variance:
    //   1. solid baseline — narrow + low alpha, ensures the band is
    //      always visible during dash gaps.
    //   2. dashed emphasis — wider + higher alpha, irregular 8-element
    //      dash pattern (no two values equal), per-lane phase stagger
    //      so adjacent lanes don't sync.
    //   3. secondary dashed emphasis — relatively-prime dash sum (vs
    //      pass 2) so the combined wear/oil pattern has an effective
    //      period of ~10k game units — non-repeating in practice.
    //
    // Wear and oil use DIFFERENT dash sums (460 vs 450, 397 vs 401)
    // and different per-lane phase steps so the two features never
    // visually sync at any given lane.
    //
    // Unchunked: each stroke walks the full smoothed polyline. The
    // monolith chunked these into ~50-tile Path2D pieces to bound
    // dashed-stroke cost; chunking is deferred to a follow-up hop.
    // 1:1 with monolith L30814-L31057 fallback branch.
    if (wearOffsets.length > 0) {
      const baseWearW = Math.max(2, laneW * TILE * 0.18);
      const baseOilW = Math.max(0.5, laneW * TILE * 0.025);
      const prevDash = ctx.getLineDash();
      const prevDashOff = ctx.lineDashOffset;
      const prevCap = ctx.lineCap;
      ctx.lineCap = 'butt';

      // H662: chunked fast path — iterate only the chunks whose bbox
      // intersects the viewport, and stroke each chunk's pre-built
      // wear/oil Path2D (built once at rebuild time). dashLen carries
      // cross-chunk phase continuity for the dashed-emphasis passes
      // so the visible dash pattern doesn't reset at chunk seams.
      // Fallback retains the per-frame tracePathOffset walk for
      // medium-length roads without chunks.
      const useChunked = !!(visibleChunks && visibleChunks[0]?.wearPathAll);

      // ---- WEAR pass 1: solid baseline ----
      ctx.setLineDash([]);
      ctx.lineDashOffset = 0;
      ctx.lineWidth = baseWearW * 0.65;
      ctx.strokeStyle = 'rgba(0,0,0,0.07)';
      if (useChunked && visibleChunks) {
        // H771: one combined-path stroke per chunk (was one per lane).
        for (const ck of visibleChunks) {
          if (ck.wearPathAll) ctx.stroke(ck.wearPathAll);
        }
      } else {
        for (const off of wearOffsets) {
          tracePathOffset(ctx, pts, off);
          ctx.stroke();
        }
      }

      // ---- WEAR pass 2: primary dashed emphasis (sum 460) ----
      // Per-path step 37 (prime, ≈ 1/12 of dash sum) staggers each
      // lane's phase so adjacent wear tracks never co-align.
      ctx.lineWidth = baseWearW * 1.15;
      ctx.strokeStyle = 'rgba(0,0,0,0.13)';
      if (useChunked && visibleChunks) {
        // H783: dash pattern + per-lane stagger are pre-baked into
        // wearDash2Path's geometry — ONE solid stroke per chunk
        // replaces one dashed stroke per lane (12 calls on a 3-lps
        // highway). setLineDash stays [] from pass 1.
        for (const ck of visibleChunks) {
          if (ck.wearDash2Path) ctx.stroke(ck.wearDash2Path);
        }
      } else {
        ctx.setLineDash(WEAR_DASH_PASS2);
        for (let pi = 0; pi < wearOffsets.length; pi++) {
          ctx.lineDashOffset = pi * 37;
          tracePathOffset(ctx, pts, wearOffsets[pi]);
          ctx.stroke();
        }
      }

      // ---- WEAR pass 3: REMOVED (H719) ----
      // Was: secondary dashed emphasis (sum 397, prime) at alpha 0.10.
      // Purpose was to make the combined wear pattern non-repeating
      // over ~182k px. Removed for FPS — at low alpha against the
      // primary pass 2 (alpha 0.13) the secondary pass was barely
      // visible but cost a full lane-by-lane dashed stroke per
      // visible chunk. User reported PC 30-60 fps while driving;
      // dropping the wear+oil pass 3 cuts ~33 % of marking work.

      const useChunkedOil = !!(visibleChunks && visibleChunks[0]?.oilPathAll);

      // ---- OIL pass 1: solid baseline ----
      ctx.setLineDash([]);
      ctx.lineDashOffset = 0;
      ctx.lineWidth = baseOilW * 0.55;
      ctx.strokeStyle = 'rgba(8,5,2,0.20)';
      if (useChunkedOil && visibleChunks) {
        // H771: one combined-path stroke per chunk (was one per lane).
        for (const ck of visibleChunks) {
          if (ck.oilPathAll) ctx.stroke(ck.oilPathAll);
        }
      } else {
        for (const off of oilOffsets) {
          tracePathOffset(ctx, pts, off);
          ctx.stroke();
        }
      }

      // ---- OIL pass 2: primary dashed emphasis (sum 450) ----
      // Phase step 73 (prime, ≈ 1/6 of dash sum) for the smaller
      // oilOffsets set; +200 bias separates oil's phase from wear's
      // at the same lane.
      ctx.lineWidth = baseOilW * 1.10;
      ctx.strokeStyle = 'rgba(8,5,2,0.42)';
      if (useChunkedOil && visibleChunks) {
        // H783: pre-baked dashes — one solid stroke per chunk.
        for (const ck of visibleChunks) {
          if (ck.oilDash2Path) ctx.stroke(ck.oilDash2Path);
        }
      } else {
        ctx.setLineDash(OIL_DASH_PASS2);
        for (let pi = 0; pi < oilOffsets.length; pi++) {
          ctx.lineDashOffset = pi * 73 + 200;
          tracePathOffset(ctx, pts, oilOffsets[pi]);
          ctx.stroke();
        }
      }

      // ---- OIL pass 3: REMOVED (H719) ----
      // Was: secondary dashed emphasis (sum 401, prime) at alpha 0.30.
      // Same shape and rationale as wear pass 3 above — paired
      // removal so the wear and oil tail-passes drop together.

      ctx.setLineDash(prevDash);
      ctx.lineDashOffset = prevDashOff;
      ctx.lineCap = prevCap;
    }

    // Major edge band tint — monolith pass 10's translucent darker
    // overlay covering the full asphalt breadth so majors read
    // slightly darker than minors. H677: width tracks the
    // lane-standardized asphaltW matching the strokeRoad asphalt
    // stroke; the +2 keeps the tint extending one pixel past each
    // edge so the band is visible even when antialiasing eats the
    // outermost row.
    const _maEdgeW = entry.laneGeom?.asphaltW
      ?? laneStandardizedWidth(String(entry.row[2] ?? ''), w);
    ctx.strokeStyle = 'rgba(80,80,80,0.4)';
    ctx.lineWidth = _maEdgeW * TILE + 2;
    if (visibleChunks) {
      for (const ck of visibleChunks) ctx.stroke(ck.mainPath);
    } else if (entry.centerPath) {
      ctx.stroke(entry.centerPath);
    } else {
      tracePath(ctx, pts);
      ctx.stroke();
    }

    // H263: I-485 grass median — dark green strip painted between
    // the two carriageways. Parity with monolith pass 11 (L31213-
    // L31216). H287: width = effectiveMedHalf*2*TILE (was
    // medHalf*2*TILE) so the green fills only the actual median area
    // between the inner shoulders, not the shoulders themselves. The
    // prior medHalf-based width painted grass over the inner paved
    // shoulders on I-485 — visible parity bug since the monolith's
    // pass 11 has used effectiveMedHalf since v8.99.124.38. For
    // jersey-barrier highways (w >= 12), effectiveMedHalf clamps to 0
    // (inner shoulders overlap at centerline) so no grass paints.
    // Skipped here on w >= 12 anyway since their "median" is
    // symbolic-only.
    if (name === 'I-485' && effectiveMedHalf > 0) {
      const prevCap = ctx.lineCap;
      const prevJoin = ctx.lineJoin;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = GRASS_MEDIAN_COLOR;
      ctx.lineWidth = effectiveMedHalf * 2 * TILE;
      if (visibleChunks) {
        for (const ck of visibleChunks) ctx.stroke(ck.mainPath);
      } else if (entry.centerPath) {
        ctx.stroke(entry.centerPath);
      } else {
        tracePath(ctx, pts);
        ctx.stroke();
      }
      ctx.lineCap = prevCap;
      ctx.lineJoin = prevJoin;
    }

    // H264: I-77 / I-85 jersey barrier — thin concrete-gray stroke
    // down the centerline of wide non-I-485 interstates. Parity with
    // monolith pass 12 (L31220-L31223). The H262 yellow inner-edge
    // stripes flank this stroke to produce the "yellow / concrete /
    // yellow" jersey-barrier band. Round caps so the barrier reads
    // as a continuous wall through curves.
    if (w >= 12 && name !== 'I-485') {
      const prevCap = ctx.lineCap;
      const prevJoin = ctx.lineJoin;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = JERSEY_BARRIER_COLOR;
      ctx.lineWidth = JERSEY_BARRIER_WIDTH;
      if (visibleChunks) {
        for (const ck of visibleChunks) ctx.stroke(ck.mainPath);
      } else if (entry.centerPath) {
        ctx.stroke(entry.centerPath);
      } else {
        tracePath(ctx, pts);
        ctx.stroke();
      }
      ctx.lineCap = prevCap;
      ctx.lineJoin = prevJoin;
    }

    // H265: white dashed lane dividers — one stripe per lane boundary
    // per side, placed at medHalf + i*LANE_W_STD (i=1..lps-1) to match
    // monolith L18628-L18632 getRoadProfile's dividers array. Replaces
    // the prior halfW * 0.33/0.67 fractions, which placed dividers at
    // road-class-relative fractions instead of US-standard lane widths
    // — so I-485 (lps=3) only showed 2 stripes total instead of 4, and
    // I-77/I-85 (lps=4) only showed 4 stripes instead of 6.
    if (dividerOffsets.length > 0) {
      ctx.setLineDash(LANE_DIVIDER_DASH);
      ctx.strokeStyle = LANE_DIVIDER_COLOR;
      ctx.lineWidth = LANE_DIVIDER_WIDTH;
      // H662: chunked path — iterate visible chunks, restoring the dash
      // phase per chunk via ck.dashLen so the [6,8] pattern stays
      // continuous across chunk seams. H650 cached full-road Path2Ds
      // remain as a non-chunked fallback for medium roads; the
      // imperative offset walk is the last resort.
      const useChunked = !!(visibleChunks && visibleChunks[0]?.dividerPathAll);
      if (useChunked && visibleChunks) {
        // H771: one combined-path stroke per chunk (was one per lane).
        // All dividers in a chunk share the same lineDashOffset, and
        // dash phase restarts per subpath, so pixels are unchanged.
        for (const ck of visibleChunks) {
          if (!ck.dividerPathAll) continue;
          ctx.lineDashOffset = ck.dashLen;
          ctx.stroke(ck.dividerPathAll);
        }
        ctx.lineDashOffset = 0;
      } else if (entry.dividerPaths && entry.dividerPaths.length > 0) {
        for (const dp of entry.dividerPaths) ctx.stroke(dp);
      } else {
        for (const off of dividerOffsets) {
          for (const sign of [-1, 1]) {
            tracePathOffset(ctx, pts, off * sign);
            ctx.stroke();
          }
        }
      }
      ctx.setLineDash([]);
    }
  }

  // Solid yellow centerline — every non-divided road with w >= 3
  // (parity with monolith pass 13's `if (w >= 3 && !hasMedian)`).
  // Divided highways (I-485 + w >= 12) skip the centerline because
  // their inner-edge stripes flanking the median replace it.
  if (w >= 3 && !isDivided) {
    ctx.strokeStyle = CENTERLINE_COLOR;
    ctx.lineWidth = CENTERLINE_WIDTH;
    if (visibleChunks) {
      for (const ck of visibleChunks) ctx.stroke(ck.mainPath);
    } else if (entry.centerPath) {
      ctx.stroke(entry.centerPath);
    } else {
      tracePath(ctx, pts);
      ctx.stroke();
    }
  }

  // H262: yellow inner-edge stripes for divided highways — parity
  // with monolith pass 18 (L31562-L31585). Position is the median
  // half-width plus a fixed 1.7-px inset so each stripe sits ~1 px
  // inside its carriageway's inner asphalt edge. I-485 has a real
  // ~1-tile grass median between its stripes; I-77/I-85's medHalf is
  // only ~0.1 tile so the two stripes read as a double-yellow band
  // (US-DOT spec for jersey-barrier highways).
  if (isDivided) {
    const innerOff = medHalf + EDGE_STRIPE_INSET_PX / TILE;
    const prevCap = ctx.lineCap;
    ctx.lineCap = 'butt';
    ctx.strokeStyle = INNER_EDGE_COLOR;
    ctx.lineWidth = INNER_EDGE_WIDTH;
    const useChunked = !!(visibleChunks && visibleChunks[0]?.innerEdgePathAll);
    if (useChunked && visibleChunks) {
      // H771: one combined-path stroke per chunk (was one per side).
      for (const ck of visibleChunks) {
        if (ck.innerEdgePathAll) ctx.stroke(ck.innerEdgePathAll);
      }
    } else if (entry.innerEdgePaths && entry.innerEdgePaths.length > 0) {
      for (const ip of entry.innerEdgePaths) ctx.stroke(ip);
    } else {
      tracePathOffset(ctx, pts, innerOff);
      ctx.stroke();
      tracePathOffset(ctx, pts, -innerOff);
      ctx.stroke();
    }
    ctx.lineCap = prevCap;
  }

  // H261: solid white edge stripes ("fog lines"). Position matches
  // monolith pass 15 (L31348-L31376) at ±(halfW - 1.7px). For divided
  // highways we pull the stripe INWARD by shoulderW so the paved
  // shoulder is visible beyond the white line — divided highways read
  // as wider with a visible breakdown lane past the fog line, matching
  // real US-DOT spec. Non-divided roads have no shoulder so the stripe
  // sits right at the asphalt edge inset.
  //
  // H679: track lane-standardized asphaltW, not raw `w` (same bug as
  // buildChunks above). H677 narrowed the asphalt stroke but this path
  // kept the original w*0.5 half-width, so the stripes drifted into
  // the grass (minors) or left a strip of asphalt past the fog line
  // (highways).
  let edgeOff = 0;
  if (w >= 3) {
    const insetTiles = EDGE_STRIPE_INSET_PX / TILE;
    const shoulderTiles = isDivided ? 0.5 * 1.275 : 0; // 0.5 * laneW
    edgeOff = asphaltW * 0.5 - shoulderTiles - insetTiles;
    if (edgeOff > 0) {
      const prevCap = ctx.lineCap;
      ctx.lineCap = 'square';
      ctx.strokeStyle = EDGE_STRIPE_COLOR;
      ctx.lineWidth = EDGE_STRIPE_WIDTH;
      const useChunked = !!(visibleChunks && visibleChunks[0]?.edgePathAll);
      if (useChunked && visibleChunks) {
        // H771: one combined-path stroke per chunk (was one per side).
        for (const ck of visibleChunks) {
          if (ck.edgePathAll) ctx.stroke(ck.edgePathAll);
        }
      } else if (entry.edgePaths && entry.edgePaths.length > 0) {
        for (const ep of entry.edgePaths) ctx.stroke(ep);
      } else {
        tracePathOffset(ctx, pts, edgeOff);
        ctx.stroke();
        tracePathOffset(ctx, pts, -edgeOff);
        ctx.stroke();
      }
      ctx.lineCap = prevCap;
    }
  }

  // H282: T-junction edge-stripe erase (monolith pass 5b, L31378-L31405,
  // v8.99.126.62). For each pre-computed teeJunction on this road
  // (where another road's endpoint lands mid-segment), stroke the
  // asphalt pattern over the white edge stripe within the junction
  // zone so the cross-street's pavement reads as continuous with this
  // road's. Without this, the solid fog line painted by PASS 5 above
  // crosses every side-street's asphalt — visually wrong since the
  // junction's pavement is continuous.
  //
  // Width 2.4px (vs the 1.4px stripe) ensures the asphalt overpaint
  // covers the stripe including its anti-aliased edges. Erase uses
  // RAW polyline samples within the zone (not the smoothed array)
  // because teeJunction.segIdx indexes into raw — but the resulting
  // perpendicular offset at edgeOff matches PASS 5's smoothed offset
  // to within sub-pixel phase on the near-straight segments where
  // junctions typically land.
  //
  // Per-segment material overrides on the junction segment are not
  // honored here — we use the road-level (material, age) since the
  // overpaint logically reverts the stripe at the segment that owns
  // the junction, not the cross-street. Edge case: a road with the
  // junction segment overridden to 'concrete' while the rest is
  // 'asphalt' would erase with asphalt-color, leaving a 2.4-px-wide
  // streak. Deferred — no monolith parity for that case anyway.
  if (entry.teeJunctions && entry.teeJunctions.length > 0 && edgeOff > 0) {
    const rawPts = polylinePoints(row);
    const overrides = { material: entry.material, age: entry.age };
    const pattern = getAsphaltPattern(ctx, row, overrides);
    const eraseStyle = pattern ?? getRoadBaseColor(row, overrides);
    const prevCap = ctx.lineCap;
    const prevDash = ctx.getLineDash();
    ctx.lineCap = 'butt';
    ctx.lineWidth = TEE_ERASE_WIDTH;
    ctx.strokeStyle = eraseStyle;
    ctx.setLineDash([]);
    for (const tj of entry.teeJunctions) {
      const samples = samplesInZone(rawPts, tj.segIdx, tj.t, tj.radius);
      if (samples.length < 2) continue;
      traceOffsetSamples(ctx, samples, edgeOff);
      ctx.stroke();
      traceOffsetSamples(ctx, samples, -edgeOff);
      ctx.stroke();
    }
    ctx.setLineDash(prevDash);
    ctx.lineCap = prevCap;
  }

  // H285: lane-addition dashed channelizing stripe inside auto-tapers
  // (monolith PASS 5c, L31407-L31447, v8.99.126.63/65). When this road
  // has an auto-taper at either endpoint, paint a dashed white line
  // INSIDE the taper polygon at the narrow road's pre-taper edge
  // position — DOT MUTCD entrance-taper marking that vehicles cross
  // to enter the newly-added lane.
  //
  // Two-pass per side per taper:
  //   1. ERASE — stroke the asphalt pattern at 2.4 px width over the
  //      H261 solid white stripe (PASS 5 painted it across the whole
  //      polyline including the taper region).
  //   2. RESTROKE — dashed white [6,8] @ 1.4 px on the same path so
  //      the lane-add line replaces the solid stripe with a dashed
  //      channelizing line in the taper region only.
  //
  // Per the monolith comment chain on v126.65, the dash pattern unifies
  // with the in-game lane divider [6, 8] so the painted-marking
  // hierarchy reads as one coherent system (was previously a laneW-
  // derived ~9px dash that looked visually distinct).
  const taperStart = entry.autoTaperStart;
  const taperEnd   = entry.autoTaperEnd;
  if ((taperStart?.laneAddPlus || taperStart?.laneAddMinus
    || taperEnd?.laneAddPlus   || taperEnd?.laneAddMinus)) {
    const overrides2 = { material: entry.material, age: entry.age };
    const pattern2 = getAsphaltPattern(ctx, row, overrides2);
    const eraseStyle2 = pattern2 ?? getRoadBaseColor(row, overrides2);
    const prevCap2 = ctx.lineCap;
    const prevDash2 = ctx.getLineDash();
    const strokePoly = (samples: ReadonlyArray<readonly [number, number]>): void => {
      if (samples.length < 2) return;
      ctx.beginPath();
      ctx.moveTo(samples[0][0] * TILE, samples[0][1] * TILE);
      for (let k = 1; k < samples.length; k++) {
        ctx.lineTo(samples[k][0] * TILE, samples[k][1] * TILE);
      }
      ctx.stroke();
    };
    const collect: Array<ReadonlyArray<readonly [number, number]>> = [];
    if (taperStart?.laneAddPlus)  collect.push(taperStart.laneAddPlus);
    if (taperStart?.laneAddMinus) collect.push(taperStart.laneAddMinus);
    if (taperEnd?.laneAddPlus)    collect.push(taperEnd.laneAddPlus);
    if (taperEnd?.laneAddMinus)   collect.push(taperEnd.laneAddMinus);
    // Pass 1: erase the H261 solid stripe at this path.
    ctx.lineCap = 'butt';
    ctx.lineWidth = LANE_ADD_ERASE_WIDTH;
    ctx.strokeStyle = eraseStyle2;
    ctx.setLineDash([]);
    for (const samples of collect) strokePoly(samples);
    // Pass 2: re-stroke dashed white.
    ctx.lineWidth = LANE_ADD_DASH_WIDTH;
    ctx.strokeStyle = LANE_ADD_DASH_COLOR;
    ctx.setLineDash(LANE_ADD_DASH);
    for (const samples of collect) strokePoly(samples);
    ctx.setLineDash(prevDash2);
    ctx.lineCap = prevCap2;
  }

  // H788/H791: junction-box erase. For every same-z crossing where
  // THIS road paints later, overpaint a plain-asphalt box aligned to
  // the peer's tangent: along-peer extent covers the peer's
  // carriageway through our band (obliquity-scaled at detection time
  // and padded so markings break just before the box), across-peer
  // extent is the peer's asphalt half-width. The peer's markings are
  // already buried under our asphalt — this removes OUR markings
  // inside the box, leaving bare pavement. Lives at the end of
  // strokeRoadMarkings (not strokeRoad) so the deferred ELEVATED
  // marking pass in drawBridgeOverlays gets the same treatment —
  // the user's drive test showed interstate junctions still crossing
  // their markings because the erase only ran for ground roads.
  if (entry.crossings && entry.crossings.length > 0) {
    const _czOvr = { material: entry.material, age: entry.age };
    const _czPat = getAsphaltPattern(ctx, row, _czOvr)
      ?? getRoadBaseColor(row, _czOvr);
    for (const cz of entry.crossings) {
      const ca = cz.tx;
      const sa = cz.ty;
      const al = cz.alongHalf * 1.15 * TILE;
      const ac = cz.acrossHalf * 1.1 * TILE;
      const cx0 = cz.x * TILE;
      const cy0 = cz.y * TILE;
      // World-frame quad (no ctx transform) so the asphalt pattern
      // stays world-anchored and matches the surrounding texture.
      const quad = new Path2D();
      quad.moveTo(cx0 + ca * al - sa * ac, cy0 + sa * al + ca * ac);
      quad.lineTo(cx0 - ca * al - sa * ac, cy0 - sa * al + ca * ac);
      quad.lineTo(cx0 - ca * al + sa * ac, cy0 - sa * al - ca * ac);
      quad.lineTo(cx0 + ca * al + sa * ac, cy0 + sa * al - ca * ac);
      quad.closePath();
      ctx.fillStyle = _czPat;
      ctx.fill(quad);
      // Majors carry the edge-band tint (rgba 80,80,80,0.4) over
      // their full asphalt breadth — without re-applying it the box
      // reads as a darker raw-asphalt patch against the tinted road.
      if (row[1] === 1) {
        ctx.fillStyle = 'rgba(80,80,80,0.4)';
        ctx.fill(quad);
      }
    }
  }
}

/** H269: resolve the effective (material, age) for one segment of a
 *  road, honoring the entry's per-segment materialOverrides. Falls back
 *  to the road-level (entry.material / entry.age) which themselves fall
 *  back to row-name / first-vertex-hash in roadTextures.ts. Mirrors
 *  monolith _weEffectiveMaterialAge at L15370-L15385. */
function effectiveMaterialAge(
  entry: RenderEntry,
  segIdx: number,
): { material?: 'asphalt' | 'concrete'; age?: 'new' | 'old' } {
  let material = entry.material;
  let age = entry.age;
  if (entry.materialOverrides) {
    for (const o of entry.materialOverrides) {
      if (o.seg === segIdx) {
        if (o.material) material = o.material;
        if (o.age) age = o.age;
        break;
      }
    }
  }
  return { material, age };
}

/** H284: render the auto-taper polygon + edge stripes at one or both
 *  endpoints of a road. 1:1 port of monolith pass L30748-L30812
 *  (v8.99.126.61/63/64/66). Two visual sub-passes per taper:
 *
 *    1. POLYGON FILL — outer + reversed-inner closed path, filled with
 *       the same asphalt CanvasPattern the road's stroke used. The
 *       narrow road's asphalt visually widens to match the peer's at
 *       the joint, eliminating the rectangular step where two roads
 *       of different widths meet.
 *
 *    2. OUTER/INNER STRIPE STROKES — solid white at the EDGE_STRIPE
 *       offsets (the *Stripe variants of outer/inner, inset 1.7/TILE
 *       so they meet each peer road's normal prof.edgeOffsets stripes
 *       flush at the joining vertex). lineCap 'square' bridges any
 *       residual sub-pixel rounding gap with the peer road's stripe.
 *
 *  Called from strokeRoad after the asphalt stroke and before
 *  strokeRoadMarkings — matches the monolith's per-road inline order
 *  (asphalt → auto-taper → markings). For elevated roads the call
 *  still happens inline; the bridge concrete pass in
 *  drawBridgeOverlays only paints at crossings (not endpoints) so the
 *  taper at the endpoint remains visible. */
function strokeAutoTapers(ctx: CanvasRenderingContext2D, entry: RenderEntry): void {
  const start = entry.autoTaperStart;
  const end   = entry.autoTaperEnd;
  if (!start && !end) return;
  const overrides = { material: entry.material, age: entry.age };
  const pattern = getAsphaltPattern(ctx, entry.row, overrides);
  const fillStyle: string | CanvasPattern = pattern ?? getRoadBaseColor(entry.row, overrides);
  const prevCap = ctx.lineCap;
  const prevJoin = ctx.lineJoin;
  const prevDash = ctx.getLineDash();

  // --- Pass 1: polygon fill ---------------------------------------------
  ctx.fillStyle = fillStyle;
  const fillOne = (meta: AutoTaperMeta): void => {
    const { outer, inner } = meta;
    const L = outer.length;
    if (L < 2 || inner.length !== L) return;
    ctx.beginPath();
    ctx.moveTo(outer[0][0] * TILE, outer[0][1] * TILE);
    for (let k = 1; k < L; k++) {
      ctx.lineTo(outer[k][0] * TILE, outer[k][1] * TILE);
    }
    for (let k = L - 1; k >= 0; k--) {
      ctx.lineTo(inner[k][0] * TILE, inner[k][1] * TILE);
    }
    ctx.closePath();
    ctx.fill();
  };
  if (start) fillOne(start);
  if (end)   fillOne(end);

  // --- Pass 2: outer/inner stripe strokes ------------------------------
  ctx.strokeStyle = EDGE_STRIPE_COLOR;
  ctx.lineWidth = EDGE_STRIPE_WIDTH;
  ctx.lineCap = 'square';
  ctx.lineJoin = 'round';
  ctx.setLineDash([]);
  const strokePolyline = (samples: ReadonlyArray<readonly [number, number]>): void => {
    if (samples.length < 2) return;
    ctx.beginPath();
    ctx.moveTo(samples[0][0] * TILE, samples[0][1] * TILE);
    for (let k = 1; k < samples.length; k++) {
      ctx.lineTo(samples[k][0] * TILE, samples[k][1] * TILE);
    }
    ctx.stroke();
  };
  if (start) {
    strokePolyline(start.outerStripe);
    strokePolyline(start.innerStripe);
  }
  if (end) {
    strokePolyline(end.outerStripe);
    strokePolyline(end.innerStripe);
  }
  ctx.setLineDash(prevDash);
  ctx.lineCap = prevCap;
  ctx.lineJoin = prevJoin;
}

function strokeRoad(
  ctx: CanvasRenderingContext2D,
  entry: RenderEntry,
  visibleChunks: RoadChunk[] | null = null,
): void {
  // entry.row = [w, maj, name, z, x1, y1, x2, y2, ...]
  const { row, smoothed: pts } = entry;
  const w = row[0];
  if (pts.length < 4) return;

  // H787: editor merge rows render the baked one-lane polygon (same
  // geometry the editor previews per H786) — pattern fill + edge
  // strokes — instead of the standard full-width asphalt/marking
  // pipeline, which would straddle the destination's outer lane.
  if (entry.mergePaths) {
    const mp = entry.mergePaths;
    const mOverrides = { material: entry.material, age: entry.age };
    ctx.fillStyle = getAsphaltPattern(ctx, row, mOverrides)
      ?? getRoadBaseColor(row, mOverrides);
    ctx.fill(mp.fill);
    const prevCap = ctx.lineCap;
    const prevJoin = ctx.lineJoin;
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = EDGE_STRIPE_COLOR;
    ctx.lineWidth = EDGE_STRIPE_WIDTH;
    ctx.stroke(mp.outer);
    if (mp.asym) ctx.setLineDash(LANE_DIVIDER_DASH);
    ctx.stroke(mp.inner);
    ctx.setLineDash([]);
    ctx.lineCap = prevCap;
    ctx.lineJoin = prevJoin;
    return;
  }

  // H677: asphalt stroke width = lane-standardized asphaltW (the
  // total lanes × LANE_W_STD + shoulders that getLaneGeom already
  // computed and cached on entry.laneGeom). Replaces the H280
  // `w * TILE` baseline because that baseline produced an INVERSION:
  // a w=4 minor with 2 lanes (4 tiles asphalt / 2 lanes = 2 tiles
  // per lane) rendered wider per lane than a w=12 highway with 8
  // lanes (12 / 8 = 1.5 tiles per lane). Lane stripes used a
  // constant LANE_W_STD=1.275 spacing regardless of w, so the
  // visible "lane" between stripes was wider on minors than on
  // highways — exactly the user-reported bug.
  //
  // With this change every lane renders at 1.275 tiles regardless
  // of road class. Roads narrow visibly (a w=4 was 4 tiles, now
  // 2.55 tiles — a 4WD-truck-fits-but-barely look) but the per-
  // lane geometry is now physically consistent.
  const _asphaltW = entry.laneGeom?.asphaltW ?? laneStandardizedWidth(String(row[2] ?? ''), w);
  const rw = _asphaltW * TILE;

  // H286: lineCap='butt' for the asphalt stroke (monolith v8.99.126.22
  // fix at L30703-L30714). With the prior 'round' cap, every road
  // endpoint extruded a half-circle of width=rw past pts[0] / pts[N-1]
  // — visually wrong wherever roads meet at shared endpoints (the
  // bulge poked through the neighbor's pavement) and especially
  // noticeable at z-transition seams between roads and bridges. lineJoin
  // stays 'round' so mid-road bends still look smooth — only the road
  // TERMINUS changes from half-circle to flat. True road termini (a
  // road that ends in empty space) read more naturally as flat anyway.
  ctx.lineCap = 'butt';
  ctx.lineJoin = 'round';

  // Pass 1: asphalt band. H268 threads road-level material/age overrides
  // through to the texture lookup. H269: when the entry carries per-
  // segment materialOverrides, switch to a per-segment stroke loop so
  // the user can paint individual sections in different materials. Costs
  // N-1 strokes instead of one Path2D stroke, but only applies on edited
  // roads (most have no overrides → fast path).
  if (entry.materialOverrides && entry.materialOverrides.length > 0) {
    const N = pts.length / 2;
    ctx.lineWidth = rw;
    // H286: cap='round' INSIDE the per-segment loop so consecutive
    // same-material segments visually join cleanly without sub-pixel
    // butt-cap seams between sections. Restored to 'butt' below so the
    // road TERMINUS (pts[0] / pts[N-1]) still flat-caps for downstream
    // passes. Mirrors monolith L30733 + L30742.
    ctx.lineCap = 'round';
    for (let s = 0; s < N - 1; s++) {
      const eff = effectiveMaterialAge(entry, s);
      const pat = getAsphaltPattern(ctx, row, eff);
      ctx.strokeStyle = pat ?? getRoadBaseColor(row, eff);
      ctx.beginPath();
      ctx.moveTo(pts[s * 2]     * TILE, pts[s * 2 + 1] * TILE);
      ctx.lineTo(pts[(s + 1) * 2] * TILE, pts[(s + 1) * 2 + 1] * TILE);
      ctx.stroke();
    }
    ctx.lineCap = 'butt';
  } else {
    const overrides = { material: entry.material, age: entry.age };
    const pattern = getAsphaltPattern(ctx, row, overrides);
    ctx.strokeStyle = pattern ?? getRoadBaseColor(row, overrides);
    ctx.lineWidth = rw;
    // H662: visible chunks win when present (per-chunk Path2D + bbox
    // cull means most highway path never makes it into the GPU pipe).
    // H650: cached full-road Path2D for medium-length roads that don't
    // need chunking. Fallback retains the legacy walk so editor-preview
    // paths (where pts can change mid-session before a cache rebuild)
    // still render.
    if (visibleChunks) {
      for (const ck of visibleChunks) ctx.stroke(ck.mainPath);
    } else if (entry.mainPath) {
      ctx.stroke(entry.mainPath);
    } else {
      tracePath(ctx, pts);
      ctx.stroke();
    }
  }

  // H284: auto-taper polygon fill + edge stripes. Paints the flared
  // asphalt + outer/inner white fog lines at any endpoint joining a
  // wider peer (entry.autoTaperStart / autoTaperEnd, populated by H283
  // computeAutoTapers). Fast no-op when both fields are undefined — the
  // common case for roads without width-mismatched joins.
  strokeAutoTapers(ctx, entry);

  // H790: rounded asphalt end-caps at free termini — a half-disc past
  // the endpoint so dead-end roads finish in a smooth curve instead of
  // the butt stroke's hard square edge (connected ends keep butt for
  // the H286 flush-join reason). The fog-line arc that wraps the cap
  // paints after the markings below so it layers like the edge stripes.
  if (entry.endCaps) {
    const _ecOvr = { material: entry.material, age: entry.age };
    const _ecPat = getAsphaltPattern(ctx, row, _ecOvr)
      ?? getRoadBaseColor(row, _ecOvr);
    for (const cap of entry.endCaps) {
      const disc = new Path2D();
      disc.arc(cap.x, cap.y, cap.halfWpx, cap.ang - Math.PI / 2, cap.ang + Math.PI / 2);
      disc.closePath();
      ctx.fillStyle = _ecPat;
      ctx.fill(disc);
      // Majors carry the edge-band tint over their asphalt — re-apply
      // so the cap matches the band-tinted body (same as H788's box).
      if (row[1] === 1) {
        ctx.fillStyle = 'rgba(80,80,80,0.4)';
        ctx.fill(disc);
      }
    }
  }

  // H143: bridge concrete deck is a separate late pass
  // (drawBridgeOverlays) so the player can render UNDER overpasses.
  // H144: maj stripes for ELEVATED roads also defer to that late
  // pass — they need to paint ON TOP of the bridge concrete (monolith
  // L31200+), and that only works if they run after drawBridgeOverlays.
  // Ground-z roads still get their stripes inline here so the
  // surface-street look stays unchanged.
  if ((row[3] as number) < 2) {
    strokeRoadMarkings(ctx, entry, visibleChunks);
    // H790: fog-line arc wrapping each free end-cap, inset by the
    // same 1.7-px stripe gap the straight edge stripes use so the
    // arc meets them flush and the road end reads as one continuous
    // painted edge.
    if (entry.endCaps) {
      const prevCapStyle = ctx.lineCap;
      ctx.lineCap = 'butt';
      ctx.strokeStyle = EDGE_STRIPE_COLOR;
      ctx.lineWidth = EDGE_STRIPE_WIDTH;
      for (const cap of entry.endCaps) {
        const r = cap.halfWpx - 1.7;
        if (r <= 0) continue;
        ctx.beginPath();
        ctx.arc(cap.x, cap.y, r, cap.ang - Math.PI / 2, cap.ang + Math.PI / 2);
        ctx.stroke();
      }
      ctx.lineCap = prevCapStyle;
    }
  }
}

/** Draws every road in world coords — baseline (with editor edits +
 *  deletes applied) and editor-drawn overlay rows. Both flow through
 *  the same strokeRoad pipeline so an overlay road authored in the
 *  dev editor renders with the same asphalt + lane stripes a baseline
 *  highway does. */
/** H275: viewport cull bounds. When supplied, each entry whose bbox
 *  lies entirely outside the inflated viewport rect is skipped — no
 *  asphalt stroke, no marking passes. Optional so the editor preview
 *  path (which renders at a different transform) can still call with
 *  no cull. focusX/Y are world-pixel coords of the camera centre;
 *  cullR is the half-extent of the visible viewport (already in world
 *  pixels — gameLoop computes this as `cullRadius` for tile passes). */
export function drawBaselineRoads(
  ctx: CanvasRenderingContext2D,
  focusX?: number,
  focusY?: number,
  cullR?: number,
): void {
  const canCull = focusX !== undefined && focusY !== undefined && cullR !== undefined;
  for (const entry of RENDER_ENTRIES) {
    if (canCull && entry.bbox) {
      const m = cullR * 1.6; // monolith's `viewR * 1.6` cull margin (L30560).
      if (entry.bbox.maxX < focusX - m || entry.bbox.minX > focusX + m
       || entry.bbox.maxY < focusY - m || entry.bbox.minY > focusY + m) continue;
    }
    // H662: when the road is chunked, pre-filter to visible chunks with
    // a tighter cull margin (viewR + 1-second-of-460-wpx lookahead so a
    // freshly-revealed chunk paints in the same frame the car reaches
    // its boundary). Mirrors monolith L30637-L30647. Empty list → no
    // visible chunks → skip the road entirely without invoking
    // strokeRoad's per-pass setup.
    let visibleChunks: RoadChunk[] | null = null;
    if (entry.chunks) {
      if (!canCull) {
        visibleChunks = entry.chunks;
      } else {
        const cm = cullR + 460;
        const list: RoadChunk[] = [];
        for (const ck of entry.chunks) {
          const cb = ck.bbox;
          if (cb.maxX < focusX - cm || cb.minX > focusX + cm
           || cb.maxY < focusY - cm || cb.minY > focusY + cm) continue;
          list.push(ck);
        }
        if (list.length === 0) continue;
        visibleChunks = list;
      }
    }
    strokeRoad(ctx, entry, visibleChunks);
  }
}

/** H143: stand-alone pass that paints the bridge concrete deck for
 *  every elevated entry with stored bridgePts. Caller sequences this
 *  RELATIVE to the player car based on player.layerZ:
 *    - layerZ < 2 (player on ground / off-road): call AFTER
 *      drawPlayerCar so the bridge concrete renders OVER the player
 *      (player is visually under the bridge).
 *    - layerZ >= 2 (player on the elevated road): call BEFORE
 *      drawPlayerCar so the player is visually ON the bridge.
 *  Mirrors the monolith's z-ordered render — its bridge concrete is
 *  drawn inline with the road (L31150-31183) but the overall
 *  render() at L29957+ is z-pass ordered, achieving the same effect.
 *  Iterates only elevated entries that have bridgePts populated, so
 *  the cost is bounded by the small set of elevated roads (typically
 *  6 in baseline Charlotte). */
export function drawBridgeOverlays(
  ctx: CanvasRenderingContext2D,
  focusX?: number,
  focusY?: number,
  cullR?: number,
): void {
  const canCull = focusX !== undefined && focusY !== undefined && cullR !== undefined;
  const m = canCull ? cullR * 1.6 : 0;
  // Pass 1: concrete deck for every elevated entry with bridgePts.
  // H772: chunk-cull mirrors Pass 2 so a 6000-px-long I-485 entry only
  // strokes the 1-2 chunks under the camera instead of its full
  // polyline — same lookahead (cullR + 460) as the ground-pass margin.
  for (const entry of RENDER_ENTRIES) {
    const z = entry.row[3] as number;
    if (z < 2) continue;
    if (!entry.bridgePts) continue;
    if (canCull && entry.bbox) {
      if (entry.bbox.maxX < focusX - m || entry.bbox.minX > focusX + m
       || entry.bbox.maxY < focusY - m || entry.bbox.minY > focusY + m) continue;
    }
    let visibleChunks: RoadChunk[] | null = null;
    if (entry.chunks) {
      if (!canCull) {
        visibleChunks = entry.chunks;
      } else {
        const cm = cullR + 460;
        const list: RoadChunk[] = [];
        for (const ck of entry.chunks) {
          const cb = ck.bbox;
          if (cb.maxX < focusX - cm || cb.minX > focusX + cm
           || cb.maxY < focusY - cm || cb.minY > focusY + cm) continue;
          list.push(ck);
        }
        if (list.length === 0) continue;
        visibleChunks = list;
      }
    }
    const w = entry.row[0] as number;
    drawBridgeOverlay(ctx, entry, w, visibleChunks);
  }
  // H144 Pass 2: elevated-road maj stripes (inner band + lane
  // dividers + centerline). Runs over EVERY elevated entry — even
  // ones without bridgePts — so the highway markings everywhere
  // along the elevated path land at the same z as their road's
  // bridge-zone markings. Painting at this late stage means the
  // stripes sit on top of the bridge concrete (the user-facing
  // visual that matches the monolith's L31200+ ordering). Matches
  // monolith strokeRoad's two-block structure: bridge concrete first
  // (L31150-31183), then maj edge / divider / centerline second
  // (L31185-L31203).
  //
  // H779: lineCap='butt' (was 'round'). The major edge band tint
  // inside strokeRoadMarkings strokes at full asphalt width
  // (~218 px for I-77/I-85/I-485) and doesn't override the cap, so
  // 'round' here was extruding a half-circle of radius ~109 px past
  // every chunk seam — two adjacent half-circles overlapping at the
  // seam formed a lighter DISC SPANNING THE FULL HIGHWAY WIDTH at
  // every chunk boundary along every elevated highway. That was the
  // user-reported "off-color circles the width of entire highways,
  // lighter than the rest of the road." Same class of bug H286
  // fixed for the asphalt stroke; butt also matches the ground-z
  // marking pass set up in strokeRoad L2292.
  ctx.lineCap = 'butt';
  ctx.lineJoin = 'round';
  for (const entry of RENDER_ENTRIES) {
    const z = entry.row[3] as number;
    if (z < 2) continue;
    if (canCull && entry.bbox) {
      if (entry.bbox.maxX < focusX - m || entry.bbox.minX > focusX + m
       || entry.bbox.maxY < focusY - m || entry.bbox.minY > focusY + m) continue;
    }
    // H662: same per-chunk visibility filter as drawBaselineRoads so
    // elevated highways (I-77 / I-85 / I-485 / I-277) chunk-cull their
    // marking strokes the same way ground roads do. The viewR + 460
    // px lookahead matches the ground-pass margin.
    let visibleChunks: RoadChunk[] | null = null;
    if (entry.chunks) {
      if (!canCull) {
        visibleChunks = entry.chunks;
      } else {
        const cm = cullR + 460;
        const list: RoadChunk[] = [];
        for (const ck of entry.chunks) {
          const cb = ck.bbox;
          if (cb.maxX < focusX - cm || cb.minX > focusX + cm
           || cb.maxY < focusY - cm || cb.minY > focusY + cm) continue;
          list.push(ck);
        }
        if (list.length === 0) continue;
        visibleChunks = list;
      }
    }
    strokeRoadMarkings(ctx, entry, visibleChunks);
  }
}

/** H166: mph → world-pixels-per-second. SCALE_MS = 4.864 wpx/(m/s),
 *  1 mph = 0.447 m/s, so mph × 2.174 ≈ wpx/s. Exact: 4.864 * 0.447 =
 *  2.17421. Used by gameLoop + tickTraffic to compare player.pSpeed
 *  (already in wpx/s) against the per-road mph cap. */
export const MPH_TO_WPX = 4.864 * 0.447;

/** H166: per-road-name speed limit table. 1:1 port of monolith
 *  L33866-33876 from the minimap overlay's "current road limit"
 *  panel. Returns mph; caller converts to wpx/s via MPH_TO_WPX
 *  when comparing against player.pSpeed. */
function speedLimitMphFromName(name: string, isMajor: boolean): number {
  if (name === 'I-85')   return 70;
  if (name === 'I-77 N') return 65;
  if (name === 'I-77 S') return 65;
  if (name === 'I-485')  return 70;
  if (name === 'I-277')  return 55;
  if (name.startsWith('I-')) return 65;
  if (name.startsWith('US-')) return 55;
  if (name.startsWith('Brookshire')) return 45;
  if (name.startsWith('Independence')) return 45;
  if (name.startsWith('Ramp') || name.startsWith('Exit')) return 35;
  if (isMajor) return 45;
  // default city street
  return 35;
}

/** H651: result shape of the shared nearest-road scan. `name` is empty
 *  when the player is off all roads (no entry's perpendicular distance
 *  within its w/2 + 1 tile band). */
interface NearestRoadResult {
  name: string;
  isMajor: boolean;
}

/** H651: per-frame memo for the nearest-road scan. playerSpeedLimitWpx +
 *  playerRoadInfoAt are both called per frame with the same (px, py);
 *  before this hop each ran an independent O(roads × segments) scan
 *  with allocating polylinePoints. Now they share a single scan,
 *  cached by (px, py). Reset in rebuildRenderEntries since the entries
 *  it scans can change at edit time. */
let _scanCache: { px: number; py: number; result: NearestRoadResult } | null = null;

function scanNearestRoad(px: number, py: number): NearestRoadResult {
  if (_scanCache && _scanCache.px === px && _scanCache.py === py) {
    return _scanCache.result;
  }
  const tx = px / TILE;
  const ty = py / TILE;
  let bestDist2 = Infinity;
  let bestName = '';
  let bestMajor = false;
  for (const entry of RENDER_ENTRIES) {
    const w = entry.row[0] as number;
    const halfW = w * 0.5 + 1;
    const halfW2 = halfW * halfW;
    const pts = entry.rawPts ?? polylinePoints(entry.row);
    for (let i = 0; i < pts.length - 1; i++) {
      const ax = pts[i][0];
      const ay = pts[i][1];
      const bx = pts[i + 1][0];
      const by = pts[i + 1][1];
      const vx = bx - ax;
      const vy = by - ay;
      const len2 = vx * vx + vy * vy;
      if (len2 < 0.0001) continue;
      let t = ((tx - ax) * vx + (ty - ay) * vy) / len2;
      if (t < 0) t = 0; else if (t > 1) t = 1;
      const projX = ax + t * vx;
      const projY = ay + t * vy;
      const dd = (projX - tx) * (projX - tx) + (projY - ty) * (projY - ty);
      if (dd < halfW2 && dd < bestDist2) {
        bestDist2 = dd;
        bestName = String(entry.row[2] ?? '');
        bestMajor = entry.row[1] === 1;
      }
    }
  }
  const result: NearestRoadResult = { name: bestName, isMajor: bestMajor };
  _scanCache = { px, py, result };
  return result;
}

/** H166: compute the active speed limit (wpx/s) at the player's
 *  position. H651: now a thin wrapper around scanNearestRoad — the
 *  scan is shared with playerRoadInfoAt and memoized by (px, py) so
 *  same-frame calls from cruise control + cop radar hit the cache. */
export function playerSpeedLimitWpx(px: number, py: number): number {
  const r = scanNearestRoad(px, py);
  const mph = r.name ? speedLimitMphFromName(r.name, r.isMajor) : 35;
  return mph * MPH_TO_WPX;
}

/** H175: shape of the road-info readout — name + isMajor flag for the
 *  road the player is currently on. null when the player is off all
 *  roads. Mirrors monolith _neRoad's { name, maj } fields at L23895. */
export interface PlayerRoadInfo {
  name: string;
  isMajor: boolean;
}

/** H175: find the nearest road within (w/2 + 1) tiles of the player's
 *  position and return its name + isMajor flag. Same scan as
 *  playerSpeedLimitWpx but returns the identity info the HUD needs to
 *  draw the highway shield + name plate. Returns null when off-road.
 *  Mirrors monolith _neRoad / _neDist2 cache at L23792. */
export function playerRoadInfoAt(px: number, py: number): PlayerRoadInfo | null {
  // H651: shared scan with playerSpeedLimitWpx, memoized by (px, py).
  const r = scanNearestRoad(px, py);
  if (!r.name) return null;
  return { name: r.name, isMajor: r.isMajor };
}

/** H142: compute the elevation level at the player's current position.
 *  Iterates only elevated entries (z >= 2 — typically 6 highways in
 *  baseline Charlotte) and returns the z of the first one whose polyline
 *  the player is within (w * 0.5 + 1) tiles of (perpendicular distance,
 *  per-segment). Returns 0 when the player is off all elevated roads
 *  (ground, off-road, or anywhere else).
 *
 *  Mirrors monolith L23938-23942's `_neMajDist2 < _hw*_hw` test, with
 *  _hw = prof.totalW/2 + 1 tile slack to account for shoulder geometry.
 *  Our shoulders aren't separately modeled so we use w/2 directly with
 *  the same +1 tile slack.
 *
 *  Coordinate units: px/py in world pixels (the player.px/py space).
 *  Internally converts to tile coords (÷TILE) to compare against the
 *  polyline points which are stored in tile coords. */
export function playerLayerZAt(px: number, py: number): number {
  const tx = px / TILE;
  const ty = py / TILE;
  for (const entry of RENDER_ENTRIES) {
    const z = entry.row[3] as number;
    if (z < 2) continue;
    const w = entry.row[0] as number;
    const halfW = w * 0.5 + 1;
    const halfW2 = halfW * halfW;
    // H651: rawPts cache eliminates the per-call polylinePoints alloc.
    const pts = entry.rawPts ?? polylinePoints(entry.row);
    for (let i = 0; i < pts.length - 1; i++) {
      const ax = pts[i][0];
      const ay = pts[i][1];
      const bx = pts[i + 1][0];
      const by = pts[i + 1][1];
      const vx = bx - ax;
      const vy = by - ay;
      const len2 = vx * vx + vy * vy;
      if (len2 < 0.0001) continue;
      let t = ((tx - ax) * vx + (ty - ay) * vy) / len2;
      if (t < 0) t = 0; else if (t > 1) t = 1;
      const projX = ax + t * vx;
      const projY = ay + t * vy;
      const dd = (projX - tx) * (projX - tx) + (projY - ty) * (projY - ty);
      if (dd < halfW2) return z;
    }
  }
  return 0;
}

// H559: initial render-entries build. Relocated to end-of-file
// (was L1039 — pre-H559) so all `const` declarations between the
// old call site and end-of-file (LANE_W_STD, CENTERLINE_COLOR,
// LANE_ADD_DASH, etc.) finish initializing before getLaneGeom
// runs. Function hoisting let getLaneGeom be CALLABLE early, but
// its const reads threw TDZ ReferenceError → black screen.
rebuildRenderEntries();
