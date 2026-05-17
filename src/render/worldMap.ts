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

/** H141: ratio of the bridge deck outer width to the road's nominal w.
 *  Monolith L30546 + L31148: outerRW = prof.totalW * TILE, with
 *  getRoadProfile.totalW = w * 0.85 for both major and minor. The
 *  shadow stroke goes +6 pixels around this outer width; the rim is
 *  +3; the drive surface is the outer minus 2 barriers. */
const BRIDGE_OUTER_RATIO = 0.85;

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

  const outerRW = BRIDGE_OUTER_RATIO * w * TILE;
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
  for (let rIdx = 0; rIdx < BASELINE_ROADS.length; rIdx++) {
    if (deletedSet.has(rIdx)) continue;
    const sourceRow = BASELINE_ROADS[rIdx];
    const edited = baselineEdits.edits[String(rIdx)];
    if (edited && edited.length >= 2) {
      const synth: (number | string)[] = [sourceRow[0], sourceRow[1], sourceRow[2], sourceRow[3]];
      for (const p of edited) synth.push(p[0], p[1]);
      const synthRow = synth as unknown as BaselineRoadRow;
      RENDER_ENTRIES.push({
        row: synthRow,
        smoothed: smoothFlatPolyline(synthRow.slice(4) as readonly number[]),
      });
    } else {
      RENDER_ENTRIES.push({
        row: sourceRow,
        smoothed: smoothFlatPolyline(sourceRow.slice(4) as readonly number[]),
      });
    }
  }
  for (const raw of overlay.roads) {
    const synth = overlayRowToBaseline(raw as readonly (string | number)[]);
    if (!synth) continue;
    const pts = synth.slice(4) as readonly number[];
    if (pts.length < 4) continue;
    RENDER_ENTRIES.push({ row: synth, smoothed: smoothFlatPolyline(pts) });
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
}

// Initial build at module load.
rebuildRenderEntries();

/** Inner band — a 1-tile-inset stroke that paints over the asphalt
 *  edges to expose a hint of contrast at the shoulder line. */
const MAJOR_INNER_BAND = '#363640';
/** Yellow centerline color — solid, matches monolith pass 13 (#f0c83a,
 *  US-DOT bright yellow, 1.4 px). Drawn on any road with w >= 3 so
 *  minor city streets get parity with majors. */
const CENTERLINE_COLOR = '#f0c83a';
const CENTERLINE_WIDTH = 1.4;
/** White dashed lane divider — same color as edge stripes but dashed. */
const LANE_DIVIDER_COLOR = 'rgba(220, 220, 220, 0.85)';
const LANE_DIVIDER_DASH: [number, number] = [12, 12];
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
/** US-DOT standard lane width (12 ft @ ~9.4 ft/tile). Mirrors monolith
 *  L18602 LANE_W_STD. Used by inner-edge stripe geometry to derive
 *  median half-width from lane-count + median-fraction config. */
const LANE_W_STD = 1.275;

/** Returns the median half-width (in tiles) for divided highways +
 *  whether the road is treated as divided at all. Mirrors monolith
 *  L18604-L18621 getRoadProfile's medFrac branches: I-485 = 0.25
 *  grass median over 3 lanes/side; w >= 12 = 0.02 jersey-barrier
 *  painted median over 4 lanes/side. Roads without a real median
 *  return medHalf=0 and isDivided=false. */
function getMedianGeom(name: string, w: number): { medHalf: number; isDivided: boolean } {
  if (name === 'I-485') {
    const carriageW = 6 * LANE_W_STD; // lps=3 × 2 sides
    return { medHalf: carriageW * 0.25 * 0.5, isDivided: true };
  }
  if (w >= 12) {
    const carriageW = 8 * LANE_W_STD; // lps=4 × 2 sides
    return { medHalf: carriageW * 0.02 * 0.5, isDivided: true };
  }
  return { medHalf: 0, isDivided: false };
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
  // H262: divided-highway flag drives both the centerline skip and the
  // inner-edge stripe paint below (monolith L18699 + L31232).
  const { medHalf, isDivided } = getMedianGeom(name, w);

  if (row[1] === 1) {
    // Inner band — 1-tile inset, creates shoulder edge stripe.
    const innerWidth = Math.max(2, w * TILE - 2 * TILE);
    ctx.strokeStyle = MAJOR_INNER_BAND;
    ctx.lineWidth = innerWidth;
    tracePath(ctx, pts);
    ctx.stroke();

    // White dashed lane dividers on multi-lane highways.
    // 6-tile roads: 1 pair (±halfW * 0.5).
    // 10+ tile roads: 2 pairs (±halfW * 0.33 and ±halfW * 0.67).
    if (w >= 6) {
      const halfW = w * 0.5;
      ctx.setLineDash(LANE_DIVIDER_DASH);
      ctx.strokeStyle = LANE_DIVIDER_COLOR;
      ctx.lineWidth = LANE_DIVIDER_WIDTH;
      const offsets = w >= 10
        ? [halfW * 0.33, halfW * 0.67]
        : [halfW * 0.5];
      for (const off of offsets) {
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

  // H261: solid white edge stripes ("fog lines") at both asphalt
  // edges — parity with monolith pass 15 (L31348-L31376). Inset is a
  // fixed 1.7 px regardless of road class so the stripe sits ~1.0 px
  // inside the asphalt boundary at TILE=18; converting to tile units
  // for tracePathOffset divides by TILE. Gate matches the monolith's
  // totalW>=1.5 threshold: at the modular's raw-tile sizing, w>=3 is
  // the equivalent (a w=2 alley has no room for a distinct stripe).
  if (w >= 3) {
    const insetTiles = EDGE_STRIPE_INSET_PX / TILE;
    const edgeOff = w * 0.5 - insetTiles;
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
}

function strokeRoad(ctx: CanvasRenderingContext2D, entry: RenderEntry): void {
  // entry.row = [w, maj, name, z, x1, y1, x2, y2, ...]
  const { row, smoothed: pts } = entry;
  const w = row[0];
  if (pts.length < 4) return;

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Pass 1: asphalt band — textured pattern.
  const pattern = getAsphaltPattern(ctx, row);
  ctx.strokeStyle = pattern ?? getRoadBaseColor(row);
  ctx.lineWidth = w * TILE;
  tracePath(ctx, pts);
  ctx.stroke();

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
export function drawBaselineRoads(ctx: CanvasRenderingContext2D): void {
  for (const entry of RENDER_ENTRIES) {
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
export function drawBridgeOverlays(ctx: CanvasRenderingContext2D): void {
  // Pass 1: concrete deck for every elevated entry with bridgePts.
  for (const entry of RENDER_ENTRIES) {
    const z = entry.row[3] as number;
    if (z < 2) continue;
    if (!entry.bridgePts) continue;
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
