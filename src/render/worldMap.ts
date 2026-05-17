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

  // H266: deck outer width = totalW * TILE (carriageway + median),
  // mirroring monolith L31148 `bridgeOuterRW = prof.totalW * TILE`.
  // The prior 0.85 * w * TILE under-painted I-485's deck by ~19 px
  // (153 vs 172 monolith) so the asphalt edge poked out as shoulder
  // farther than monolith intended.
  const name = String(entry.row[2] ?? '');
  const { totalW } = getLaneGeom(name, w);
  const outerRW = totalW * TILE;
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

/** H271: tire-wear band parameters — three painted passes per wheel
 *  path producing the "lived-in highway" tire-track darkening.
 *  Mirrors monolith pass 7 (L31197-L31265). The three passes use
 *  co-prime dash periods (sum 460 + sum 397 prime) so the visible
 *  pattern doesn't repeat within a practical drive. */
/** Wear-band base width factor in tile units (= LANE_W_STD * 0.18,
 *  but inlined here because LANE_W_STD is declared further down the
 *  module). Multiplied by TILE at use to convert to canvas pixels. */
const WEAR_BAND_BASE_WIDTH_FACTOR = 1.275 * 0.18;
const WEAR_BAND_MIN_WIDTH = 2;
const WEAR_PASS1_ALPHA = 0.07;
const WEAR_PASS1_WIDTH_K = 0.65;
const WEAR_PASS2_ALPHA = 0.13;
const WEAR_PASS2_WIDTH_K = 1.15;
const WEAR_PASS2_DASH: number[] = [70, 35, 45, 60, 90, 30, 50, 80];
const WEAR_PASS3_ALPHA = 0.10;
const WEAR_PASS3_WIDTH_K = 0.85;
const WEAR_PASS3_DASH: number[] = [55, 25, 70, 40, 65, 35, 50, 57];

/** H272: oil-drip streak parameters — three painted passes per lane
 *  center producing the brownish engine-drip streak monolith pass 8
 *  paints down the middle of each lane. Mirrors L31267-L31332. */
const OIL_BAND_BASE_WIDTH_FACTOR = 1.275 * 0.025; // tile units → ×TILE
const OIL_BAND_MIN_WIDTH = 0.5;
const OIL_COLOR = '8,5,2'; // dark brown-black tar
const OIL_PASS1_ALPHA = 0.20;
const OIL_PASS1_WIDTH_K = 0.55;
const OIL_PASS2_ALPHA = 0.42;
const OIL_PASS2_WIDTH_K = 1.10;
const OIL_PASS2_DASH: number[] = [55, 70, 30, 90, 40, 50, 80, 35];
const OIL_PASS3_ALPHA = 0.30;
const OIL_PASS3_WIDTH_K = 0.85;
const OIL_PASS3_DASH: number[] = [45, 60, 35, 80, 25, 55, 70, 31];
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
  /** H271: signed wear-band offsets in tile units (positive AND
   *  negative — one entry per wheel path). Mirrors monolith L18647-
   *  L18656 — each lane center contributes its left + right wheel
   *  path (±0.25*laneW), and both sides of the road are populated.
   *  Length === lps * 4 (2 wheels × 2 road sides × lps lanes). */
  wearOffsets: number[];
  /** H272: signed oil-drip offsets in tile units. Mirrors monolith
   *  L18654-L18655 — one streak per lane center, mirrored across the
   *  median. Length === lps * 2. */
  oilOffsets: number[];
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
  // H271: wear paths — 2 per lane center (left + right wheel at
  // ±0.25*laneW), mirrored across the median for both road sides.
  // H272: oil drips — 1 per lane center, mirrored across the median.
  // Mirrors monolith L18623-L18656.
  const wearOffsets: number[] = [];
  const oilOffsets: number[] = [];
  const wheelInset = LANE_W_STD * 0.25;
  for (let i = 0; i < lps; i++) {
    const c = medHalf + (i + 0.5) * LANE_W_STD;
    wearOffsets.push(c - wheelInset);
    wearOffsets.push(c + wheelInset);
    wearOffsets.push(-(c - wheelInset));
    wearOffsets.push(-(c + wheelInset));
    oilOffsets.push(c);
    oilOffsets.push(-c);
  }
  return { lps, medHalf, totalW, asphaltW, isDivided, dividerOffsets, wearOffsets, oilOffsets };
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
  // H262/H265/H271: divided-highway flag + lane geometry. medHalf gates
  // the grass / jersey-barrier passes, isDivided gates the centerline
  // skip and inner-edge stripe paint, dividerOffsets places the dashed
  // white lane dividers at the correct laneW-based positions,
  // wearOffsets places the tire-track shadow bands.
  const { lps, medHalf, asphaltW, isDivided, dividerOffsets, wearOffsets, oilOffsets } = getLaneGeom(name, w);

  if (row[1] === 1) {
    // H274: major edge band tint — replaces the prior dark MAJOR_INNER_BAND
    // inset stripe (a cosmetic invention that didn't exist in monolith)
    // with monolith pass 10's L31200-L31202 darker-overall translucent
    // overlay at asphaltW + 2 px. Subtle dim covering the full asphalt
    // breadth (including shoulders) so majors read slightly darker than
    // minors without the harsh dual-color "shoulder edge" the inset
    // produced.
    ctx.strokeStyle = 'rgba(80,80,80,0.4)';
    ctx.lineWidth = asphaltW * TILE + 2;
    tracePath(ctx, pts);
    ctx.stroke();

    // H271: tire-wear bands — 3 painted passes per wheel path, gated to
    // multi-lane majors (mirrors monolith pass 7 at L31197-L31265 with
    // its `road.maj && prof.lps >= 2` guard). Pass 1 is a solid faint
    // baseline; passes 2 + 3 are dashed at co-prime periods so the
    // visible darkening doesn't repeat within a practical drive. Drawn
    // here — after the inner band, before grass / barrier / lane
    // markings — so the lane stripes paint on top of the wear shadow.
    if (lps >= 2 && wearOffsets.length > 0) {
      const prevCap = ctx.lineCap;
      const prevDash = ctx.getLineDash();
      const prevOff = ctx.lineDashOffset;
      ctx.lineCap = 'butt';
      const baseW = Math.max(WEAR_BAND_MIN_WIDTH, WEAR_BAND_BASE_WIDTH_FACTOR * TILE);

      // Pass 1 — solid baseline.
      ctx.setLineDash([]);
      ctx.lineDashOffset = 0;
      ctx.lineWidth = baseW * WEAR_PASS1_WIDTH_K;
      ctx.strokeStyle = `rgba(0,0,0,${WEAR_PASS1_ALPHA})`;
      for (const off of wearOffsets) {
        tracePathOffset(ctx, pts, off);
        ctx.stroke();
      }

      // Pass 2 — primary dashed emphasis. lineDashOffset is staggered
      // per-path by 37 so adjacent wheel paths don't paint synchronized
      // dashes (visible repeat artifact).
      ctx.setLineDash(WEAR_PASS2_DASH);
      ctx.lineWidth = baseW * WEAR_PASS2_WIDTH_K;
      ctx.strokeStyle = `rgba(0,0,0,${WEAR_PASS2_ALPHA})`;
      for (let pi = 0; pi < wearOffsets.length; pi++) {
        ctx.lineDashOffset = pi * 37;
        tracePathOffset(ctx, pts, wearOffsets[pi]);
        ctx.stroke();
      }

      // Pass 3 — secondary dashed emphasis at co-prime period.
      ctx.setLineDash(WEAR_PASS3_DASH);
      ctx.lineWidth = baseW * WEAR_PASS3_WIDTH_K;
      ctx.strokeStyle = `rgba(0,0,0,${WEAR_PASS3_ALPHA})`;
      for (let pi = 0; pi < wearOffsets.length; pi++) {
        ctx.lineDashOffset = pi * 31 + 100;
        tracePathOffset(ctx, pts, wearOffsets[pi]);
        ctx.stroke();
      }

      // H272: oil-drip streaks — same 3-pass structure as wear, but
      // narrower (~0.025 laneW vs 0.18), centered on lane midline
      // instead of wheel positions, and tinted brownish (8,5,2). Sum
      // 450 + sum 401 prime so the dashes co-prime with each other and
      // with the wear-band periods, producing a non-repeating "lived
      // in" highway look across all six lane markings. Mirrors monolith
      // pass 8 at L31267-L31332.
      const baseOilW = Math.max(OIL_BAND_MIN_WIDTH, OIL_BAND_BASE_WIDTH_FACTOR * TILE);

      ctx.setLineDash([]);
      ctx.lineDashOffset = 0;
      ctx.lineWidth = baseOilW * OIL_PASS1_WIDTH_K;
      ctx.strokeStyle = `rgba(${OIL_COLOR},${OIL_PASS1_ALPHA})`;
      for (const off of oilOffsets) {
        tracePathOffset(ctx, pts, off);
        ctx.stroke();
      }

      ctx.setLineDash(OIL_PASS2_DASH);
      ctx.lineWidth = baseOilW * OIL_PASS2_WIDTH_K;
      ctx.strokeStyle = `rgba(${OIL_COLOR},${OIL_PASS2_ALPHA})`;
      for (let pi = 0; pi < oilOffsets.length; pi++) {
        ctx.lineDashOffset = pi * 73 + 200;
        tracePathOffset(ctx, pts, oilOffsets[pi]);
        ctx.stroke();
      }

      ctx.setLineDash(OIL_PASS3_DASH);
      ctx.lineWidth = baseOilW * OIL_PASS3_WIDTH_K;
      ctx.strokeStyle = `rgba(${OIL_COLOR},${OIL_PASS3_ALPHA})`;
      for (let pi = 0; pi < oilOffsets.length; pi++) {
        ctx.lineDashOffset = pi * 67 + 50;
        tracePathOffset(ctx, pts, oilOffsets[pi]);
        ctx.stroke();
      }

      ctx.setLineDash(prevDash);
      ctx.lineDashOffset = prevOff;
      ctx.lineCap = prevCap;
    }

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

  // H261: solid white edge stripes ("fog lines") at both asphalt
  // edges — parity with monolith pass 15 (L31348-L31376). H274:
  // position changed from ±(w/2 - inset) to ±(asphaltW/2 - inset) so
  // the stripe sits at the carriageway-shoulder boundary the way
  // monolith does. For non-divided roads asphaltW=totalW, so the
  // stripe lands at the lane edge with no shoulder past it; for
  // divided highways asphaltW=totalW+laneW, so the stripe sits ONE
  // LANE WIDTH inside the asphalt edge — exposing the paved
  // shoulder. Gate >= 1.5 mirrors monolith's totalW>=1.5 threshold.
  if (asphaltW >= 1.5) {
    const insetTiles = EDGE_STRIPE_INSET_PX / TILE;
    const edgeOff = asphaltW * 0.5 - insetTiles;
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

  // H274: visible asphalt width = asphaltW * TILE (carriageway +
  // shoulders), matching monolith L30546 `rw = prof.asphaltW * TILE`.
  // Was w * TILE which used the road's nominal-tile width — wider than
  // the monolith's lane-standardized asphalt for most minors and
  // marginally narrower for w >= 12 jersey-barrier interstates.
  const { asphaltW } = getLaneGeom(String(row[2] ?? ''), w);
  const rw = asphaltW * TILE;

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
