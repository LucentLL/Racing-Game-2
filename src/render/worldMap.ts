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
 *  shape so the same strokeRoad pipeline renders them. */
interface RenderEntry {
  row: BaselineRoadRow;
  smoothed: number[];
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
const RENDER_ENTRIES: RenderEntry[] = [];

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
}

// Initial build at module load.
rebuildRenderEntries();

/** Inner band — a 1-tile-inset stroke that paints over the asphalt
 *  edges to expose a hint of contrast at the shoulder line. */
const MAJOR_INNER_BAND = '#363640';
/** Yellow lane-divider centerline color. Dashed. */
const CENTERLINE_COLOR = '#d4b438';
const CENTERLINE_DASH: [number, number] = [14, 10];
const CENTERLINE_WIDTH = 1.5;
/** White dashed lane divider — same color as edge stripes but dashed. */
const LANE_DIVIDER_COLOR = 'rgba(220, 220, 220, 0.85)';
const LANE_DIVIDER_DASH: [number, number] = [12, 12];
const LANE_DIVIDER_WIDTH = 1.2;

function tracePath(ctx: CanvasRenderingContext2D, pts: readonly number[]): void {
  ctx.beginPath();
  ctx.moveTo(pts[0] * TILE, pts[1] * TILE);
  for (let i = 2; i + 1 < pts.length; i += 2) {
    ctx.lineTo(pts[i] * TILE, pts[i + 1] * TILE);
  }
}

/** H52 — Per-segment perpendicular offset trace. Strokes the polyline
 *  shifted perpendicular by `tileOffset` tile-units. Small kinks at
 *  interior vertex joins are invisible at zoom 2.2× — the simpler
 *  math beats bisector geometry for 130 mostly-straight roads. */
function tracePathOffset(
  ctx: CanvasRenderingContext2D,
  pts: readonly number[],
  tileOffset: number,
): void {
  const n = pts.length / 2;
  if (n < 2) return;
  ctx.beginPath();
  let moved = false;
  for (let i = 0; i < n - 1; i++) {
    const ax = pts[i * 2] as number;
    const ay = pts[i * 2 + 1] as number;
    const bx = pts[(i + 1) * 2] as number;
    const by = pts[(i + 1) * 2 + 1] as number;
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 0.01) continue;
    const ox = (-dy / len) * tileOffset;
    const oy = ( dx / len) * tileOffset;
    if (!moved) {
      ctx.moveTo((ax + ox) * TILE, (ay + oy) * TILE);
      moved = true;
    }
    ctx.lineTo((bx + ox) * TILE, (by + oy) * TILE);
  }
}

function strokeRoad(ctx: CanvasRenderingContext2D, entry: RenderEntry): void {
  // entry.row = [w, maj, name, z, x1, y1, x2, y2, ...]
  const { row, smoothed: pts } = entry;
  const w = row[0];
  const maj = row[1];
  if (pts.length < 4) return;

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Pass 1: asphalt band — textured pattern.
  const pattern = getAsphaltPattern(ctx, row);
  ctx.strokeStyle = pattern ?? getRoadBaseColor(row);
  ctx.lineWidth = w * TILE;
  tracePath(ctx, pts);
  ctx.stroke();

  if (maj === 1) {
    // Pass 2: inner band — 1-tile inset, creates shoulder edge stripe.
    const innerWidth = Math.max(2, w * TILE - 2 * TILE);
    ctx.strokeStyle = MAJOR_INNER_BAND;
    ctx.lineWidth = innerWidth;
    tracePath(ctx, pts);
    ctx.stroke();

    // Pass 3: white dashed lane dividers on multi-lane highways.
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

    // Pass 4: dashed yellow centerline.
    ctx.setLineDash(CENTERLINE_DASH);
    ctx.strokeStyle = CENTERLINE_COLOR;
    ctx.lineWidth = CENTERLINE_WIDTH;
    tracePath(ctx, pts);
    ctx.stroke();
    ctx.setLineDash([]);
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
