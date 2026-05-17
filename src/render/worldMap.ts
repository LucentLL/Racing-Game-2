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
): void {
  const bPts = entry.bridgePts;
  if (!bPts || bPts.length === 0) return;
  const pts = polylinePoints(entry.row);
  if (pts.length < 2) return;

  // H280: bridge concrete width back to 0.85 * w * TILE. The H266
  // switch to lane-standardized totalW made the concrete deck narrower
  // than the H280-restored asphalt stroke (at w * TILE) so the
  // concrete read as a thin strip under the road instead of a deck
  // matching the road width.
  const outerRW = 0.85 * w * TILE;
  const barrierW = BRIDGE_BARRIER_W_TILES * TILE;
  const driveRW = Math.max(0, outerRW - 2 * barrierW);

  const nearBridge = (tx: number, ty: number): boolean => {
    for (const bp of bPts) {
      const dd = (tx - bp.x) * (tx - bp.x) + (ty - bp.y) * (ty - bp.y);
      if (dd < BRIDGE_R_TILES * BRIDGE_R_TILES) return true;
    }
    return false;
  };

  const prevCap = ctx.lineCap;
  ctx.lineCap = 'butt';

  // Shadow under the bridge — widest stroke, semi-transparent black.
  ctx.lineWidth = outerRW + 6;
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  for (let i = 0; i < pts.length - 1; i++) {
    const mx = (pts[i][0] + pts[i + 1][0]) / 2;
    const my = (pts[i][1] + pts[i + 1][1]) / 2;
    if (!nearBridge(mx, my) && !nearBridge(pts[i][0], pts[i][1]) && !nearBridge(pts[i + 1][0], pts[i + 1][1])) continue;
    ctx.beginPath();
    ctx.moveTo(pts[i][0] * TILE + TILE / 2, pts[i][1] * TILE + TILE / 2);
    ctx.lineTo(pts[i + 1][0] * TILE + TILE / 2, pts[i + 1][1] * TILE + TILE / 2);
    ctx.stroke();
  }

  // Concrete rim + barrier zone (parapet color).
  ctx.lineWidth = outerRW + 3;
  ctx.strokeStyle = '#888884';
  for (let i = 0; i < pts.length - 1; i++) {
    const mx = (pts[i][0] + pts[i + 1][0]) / 2;
    const my = (pts[i][1] + pts[i + 1][1]) / 2;
    if (!nearBridge(mx, my) && !nearBridge(pts[i][0], pts[i][1]) && !nearBridge(pts[i + 1][0], pts[i + 1][1])) continue;
    ctx.beginPath();
    ctx.moveTo(pts[i][0] * TILE + TILE / 2, pts[i][1] * TILE + TILE / 2);
    ctx.lineTo(pts[i + 1][0] * TILE + TILE / 2, pts[i + 1][1] * TILE + TILE / 2);
    ctx.stroke();
  }

  // Concrete drive surface (lane area between the parapets).
  ctx.lineWidth = driveRW;
  ctx.strokeStyle = '#6a6a68';
  for (let i = 0; i < pts.length - 1; i++) {
    const mx = (pts[i][0] + pts[i + 1][0]) / 2;
    const my = (pts[i][1] + pts[i + 1][1]) / 2;
    if (!nearBridge(mx, my) && !nearBridge(pts[i][0], pts[i][1]) && !nearBridge(pts[i + 1][0], pts[i + 1][1])) continue;
    ctx.beginPath();
    ctx.moveTo(pts[i][0] * TILE + TILE / 2, pts[i][1] * TILE + TILE / 2);
    ctx.lineTo(pts[i + 1][0] * TILE + TILE / 2, pts[i + 1][1] * TILE + TILE / 2);
    ctx.stroke();
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
    RENDER_ENTRIES.push({
      row: synth,
      smoothed: smoothFlatPolyline(pts),
      ...props,
      ...(materialOverrides ? { materialOverrides } : {}),
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
}

// Initial build at module load.
rebuildRenderEntries();

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
  /** Median half-width in tiles. */
  medHalf: number;
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
  const dividerOffsets: number[] = [];
  for (let i = 1; i < lps; i++) {
    dividerOffsets.push(medHalf + i * LANE_W_STD);
  }
  // H271 + H272 wear / oil offset computation removed in H278 along
  // with the stroke loop. Lane-aware tire wear + oil drips return after
  // chunking; their geometry derivation is preserved in monolith
  // L18623-L18656.
  return { lps, medHalf, totalW, asphaltW, isDivided, dividerOffsets };
}

function tracePath(ctx: CanvasRenderingContext2D, pts: readonly number[]): void {
  ctx.beginPath();
  ctx.moveTo(pts[0] * TILE, pts[1] * TILE);
  for (let i = 2; i + 1 < pts.length; i += 2) {
    ctx.lineTo(pts[i] * TILE, pts[i + 1] * TILE);
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
function strokeRoadMarkings(ctx: CanvasRenderingContext2D, entry: RenderEntry): void {
  const { row, smoothed: pts } = entry;
  const w = row[0];
  if (pts.length < 4) return;
  const name = String(row[2] ?? '');
  // H262/H265: divided-highway flag + lane geometry. medHalf gates the
  // grass / jersey-barrier passes, isDivided gates the centerline skip
  // and inner-edge stripe paint, dividerOffsets places the dashed
  // white lane dividers at the correct laneW-based positions.
  const { medHalf, isDivided, dividerOffsets } = getLaneGeom(name, w);

  if (row[1] === 1) {
    // Major edge band tint — monolith pass 10's translucent darker
    // overlay covering the full asphalt breadth so majors read
    // slightly darker than minors. H280: width tracks w * TILE (the
    // asphalt stroke width) instead of the lane-standardized asphaltW
    // since strokeRoad strokes at w * TILE.
    ctx.strokeStyle = 'rgba(80,80,80,0.4)';
    ctx.lineWidth = w * TILE + 2;
    tracePath(ctx, pts);
    ctx.stroke();

    // H271 + H272 (tire wear bands + oil drip streaks) — reverted in
    // H278 for perf. The triple-dashed-pass-per-wheel-path approach
    // costs ~50 dashed strokes on 2000-segment polylines per visible
    // major per frame. With the modular's lack of per-chunk geometry
    // each dashed stroke makes the GPU walk the full polyline pixel-
    // by-pixel computing dash phase, which collapsed framerate to ~5
    // fps on I-485 / I-77 / I-85. Will return after chunking lands
    // (split the long rings into ~50-tile pieces so each dashed stroke
    // is bounded).

    // H263: I-485 grass median — dark green strip painted between
    // the two carriageways. Parity with monolith pass 11 (L31213-
    // L31216). Width = medHalf*2*TILE in canvas pixels so the green
    // exactly fills the median between the yellow inner-edge stripes
    // drawn later. Skipped for w >= 12 jersey-barrier highways: their
    // painted "median" is symbolic-only (medHalf ≈ 0.1 tile) and
    // shouldn't show grass.
    if (name === 'I-485' && medHalf > 0) {
      const prevCap = ctx.lineCap;
      const prevJoin = ctx.lineJoin;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = GRASS_MEDIAN_COLOR;
      ctx.lineWidth = medHalf * 2 * TILE;
      tracePath(ctx, pts);
      ctx.stroke();
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
      tracePath(ctx, pts);
      ctx.stroke();
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
      for (const off of dividerOffsets) {
        for (const sign of [-1, 1]) {
          tracePathOffset(ctx, pts, off * sign);
          ctx.stroke();
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
    tracePath(ctx, pts);
    ctx.stroke();
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
    tracePathOffset(ctx, pts, innerOff);
    ctx.stroke();
    tracePathOffset(ctx, pts, -innerOff);
    ctx.stroke();
    ctx.lineCap = prevCap;
  }

  // H261: solid white edge stripes ("fog lines"). Position matches
  // monolith pass 15 (L31348-L31376) at ±(halfW - 1.7px). H280:
  // halfW = w*0.5 (the asphalt edge at the stroked width). For
  // divided highways we pull the stripe INWARD by shoulderW so the
  // paved shoulder is visible beyond the white line — divided
  // highways read as wider with a visible breakdown lane past the
  // fog line, matching real US-DOT spec. Non-divided roads have no
  // shoulder so the stripe sits right at the asphalt edge inset.
  let edgeOff = 0;
  if (w >= 3) {
    const insetTiles = EDGE_STRIPE_INSET_PX / TILE;
    const shoulderTiles = isDivided ? 0.5 * 1.275 : 0; // 0.5 * laneW
    edgeOff = w * 0.5 - shoulderTiles - insetTiles;
    if (edgeOff > 0) {
      const prevCap = ctx.lineCap;
      ctx.lineCap = 'square';
      ctx.strokeStyle = EDGE_STRIPE_COLOR;
      ctx.lineWidth = EDGE_STRIPE_WIDTH;
      tracePathOffset(ctx, pts, edgeOff);
      ctx.stroke();
      tracePathOffset(ctx, pts, -edgeOff);
      ctx.stroke();
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

function strokeRoad(ctx: CanvasRenderingContext2D, entry: RenderEntry): void {
  // entry.row = [w, maj, name, z, x1, y1, x2, y2, ...]
  const { row, smoothed: pts } = entry;
  const w = row[0];
  if (pts.length < 4) return;

  // H280: revert to w * TILE for the asphalt stroke. The H274 attempt
  // to use the monolith's lane-standardized asphaltW (= totalW +
  // 2*shoulderW) halved minor roads to 46 px and made w >= 12 highways
  // narrower than their nominal tile width — user reports the
  // monolith map shows roads at their nominal w, not lane-standardized
  // width. Lane-geom math is still used for shoulder-aware edge-stripe
  // positioning on divided highways (see strokeRoadMarkings).
  const rw = w * TILE;

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Pass 1: asphalt band. H268 threads road-level material/age overrides
  // through to the texture lookup. H269: when the entry carries per-
  // segment materialOverrides, switch to a per-segment stroke loop so
  // the user can paint individual sections in different materials. Costs
  // N-1 strokes instead of one Path2D stroke, but only applies on edited
  // roads (most have no overrides → fast path). Round caps keep the seams
  // between same-material adjacent segments visually clean (mirrors
  // monolith L30733).
  if (entry.materialOverrides && entry.materialOverrides.length > 0) {
    const N = pts.length / 2;
    ctx.lineWidth = rw;
    for (let s = 0; s < N - 1; s++) {
      const eff = effectiveMaterialAge(entry, s);
      const pat = getAsphaltPattern(ctx, row, eff);
      ctx.strokeStyle = pat ?? getRoadBaseColor(row, eff);
      ctx.beginPath();
      ctx.moveTo(pts[s * 2]     * TILE, pts[s * 2 + 1] * TILE);
      ctx.lineTo(pts[(s + 1) * 2] * TILE, pts[(s + 1) * 2 + 1] * TILE);
      ctx.stroke();
    }
  } else {
    const overrides = { material: entry.material, age: entry.age };
    const pattern = getAsphaltPattern(ctx, row, overrides);
    ctx.strokeStyle = pattern ?? getRoadBaseColor(row, overrides);
    ctx.lineWidth = rw;
    tracePath(ctx, pts);
    ctx.stroke();
  }

  // H143: bridge concrete deck is a separate late pass
  // (drawBridgeOverlays) so the player can render UNDER overpasses.
  // H144: maj stripes for ELEVATED roads also defer to that late
  // pass — they need to paint ON TOP of the bridge concrete (monolith
  // L31200+), and that only works if they run after drawBridgeOverlays.
  // Ground-z roads still get their stripes inline here so the
  // surface-street look stays unchanged.
  if ((row[3] as number) < 2) {
    strokeRoadMarkings(ctx, entry);
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
    strokeRoad(ctx, entry);
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
  for (const entry of RENDER_ENTRIES) {
    const z = entry.row[3] as number;
    if (z < 2) continue;
    if (!entry.bridgePts) continue;
    if (canCull && entry.bbox) {
      if (entry.bbox.maxX < focusX - m || entry.bbox.minX > focusX + m
       || entry.bbox.maxY < focusY - m || entry.bbox.minY > focusY + m) continue;
    }
    const w = entry.row[0] as number;
    drawBridgeOverlay(ctx, entry, w);
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
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const entry of RENDER_ENTRIES) {
    const z = entry.row[3] as number;
    if (z < 2) continue;
    if (canCull && entry.bbox) {
      if (entry.bbox.maxX < focusX - m || entry.bbox.minX > focusX + m
       || entry.bbox.maxY < focusY - m || entry.bbox.minY > focusY + m) continue;
    }
    strokeRoadMarkings(ctx, entry);
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

/** H166: compute the active speed limit (wpx/s) at the player's
 *  position. Scans every RENDER_ENTRY (not just elevated, unlike
 *  playerLayerZAt) for the nearest road within (w/2 + 1) tiles of
 *  perpendicular distance, then looks up that road's name in the
 *  per-road table. Falls back to 35 mph default when off-road.
 *  Mirrors monolith L33860-33876's _neRoad / _neDist2 cache + the
 *  bestName-based limit assignment. */
export function playerSpeedLimitWpx(px: number, py: number): number {
  const tx = px / TILE;
  const ty = py / TILE;
  let bestDist2 = Infinity;
  let bestName = '';
  let bestMajor = false;
  for (const entry of RENDER_ENTRIES) {
    const w = entry.row[0] as number;
    const halfW = w * 0.5 + 1;
    const halfW2 = halfW * halfW;
    const name = String(entry.row[2] ?? '');
    const isMajor = entry.row[1] === 1;
    const pts = polylinePoints(entry.row);
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
        bestName = name;
        bestMajor = isMajor;
      }
    }
  }
  const mph = bestName ? speedLimitMphFromName(bestName, bestMajor) : 35;
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
  const tx = px / TILE;
  const ty = py / TILE;
  let bestDist2 = Infinity;
  let bestName = '';
  let bestMajor = false;
  for (const entry of RENDER_ENTRIES) {
    const w = entry.row[0] as number;
    const halfW = w * 0.5 + 1;
    const halfW2 = halfW * halfW;
    const name = String(entry.row[2] ?? '');
    const isMajor = entry.row[1] === 1;
    const pts = polylinePoints(entry.row);
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
        bestName = name;
        bestMajor = isMajor;
      }
    }
  }
  if (!bestName) return null;
  return { name: bestName, isMajor: bestMajor };
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
    const pts = polylinePoints(entry.row);
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
