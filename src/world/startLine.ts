/**
 * H1267: START/FINISH LINE + STARTING-GRID GEOMETRY.
 *
 * Two jobs, both pure (no canvas, no DOM):
 *
 *  1. WHERE THE LINE IS. The painted line (render/startGrid) and the sim that
 *     grids cars up against it (sim/trackRace) have to agree to the pixel, or
 *     the boxes are painted somewhere the cars never park. Both take the answer
 *     from here. "The line" is the race spec's staging tile CENTRE projected
 *     onto the track's arc-length centerline — tile centre because that is the
 *     convention the sim's staging zone already uses (`(startTile + 0.5) *
 *     TILE`), and projected because the authored tile is only approximately on
 *     the road (the OSM-baked circuits put it a few metres off the smoothed
 *     centerline).
 *
 *  2. WHAT GETS PAINTED. buildStartDecals emits the checker band, the yellow
 *     edging and the L-corner grid boxes as plain QUADS. render/startGrid bakes
 *     those into Path2Ds; tools/maplab/startgrid.mjs dumps the identical quads
 *     to SVG. That is the project rule for world geometry — compute the output
 *     polygons, then look at them — and it only works if there is one generator.
 */

import { TILE, WPX_PER_M } from '@/config/world/tiles';
import {
  GRID_SLOTS, GRID_BOX_LEN_T, GRID_BOX_WID_T, GRID_BRACKET_ARM_T,
  GRID_BRACKET_PX, DRAG_BOX_WID_T, DRAG_PRESTAGE_T,
  START_BAND_DEPTH_T, START_LINE_DEPTH_T, gridSlot, dragSlot,
} from '@/config/world/startGrid';
import { RENDER_ENTRIES, type RenderEntry } from '@/render/worldMap';
import { buildTrackPath, nearestS, poseAt, type TrackPath } from '@/sim/trackAI';
import type { MapDef, TrackRaceSpec } from './mapRegistry';

// ---------------------------------------------------------------------------
// 1. Resolving the line
// ---------------------------------------------------------------------------

/**
 * buildTrackPath needs 3+ points, and smoothFlatPolyline returns a 2-point row
 * VERBATIM (pathSmoothing.ts:289) — which is exactly what the drag strip and the
 * car-meet strip are. Subdividing here means one arc-length code path serves
 * every venue instead of the straights needing their own analytic branch.
 */
export function densifyFlat(flat: readonly number[]): number[] {
  if (flat.length >= 6 || flat.length < 4) return flat as number[];
  const [x0, y0, x1, y1] = flat;
  const out: number[] = [];
  const N = 24;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    out.push(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t);
  }
  return out;
}

/**
 * The track road for this map. Prefers an exact name match — which covers the
 * four circuits, the touge passes, 'Drag Strip' and 'Oval Track' — and falls
 * back to the longest polyline, which is what the CAR MEET needs (its MapDef is
 * named 'Car Meet' while its road row is another 'Drag Strip'). The
 * longest-wins fallback is the same rule trackRace.circuitPath used, and on a
 * circuit it is what disambiguates the track from the w=4 pit lane and exit.
 */
export function trackEntryFor(def: MapDef): RenderEntry | null {
  let named: RenderEntry | null = null;
  let longest: RenderEntry | null = null;
  for (const e of RENDER_ENTRIES) {
    if (!e.smoothed || e.smoothed.length < 4) continue;
    if (!named && String(e.row[2] ?? '') === def.name) named = e;
    if (!longest || e.smoothed.length > longest.smoothed.length) longest = e;
  }
  return named ?? longest;
}

/** Arc-length path for this map's track, or null if it has no usable road. */
export function trackPathFor(def: MapDef): TrackPath | null {
  const e = trackEntryFor(def);
  if (!e) return null;
  return buildTrackPath(densifyFlat(e.smoothed), TILE);
}

/**
 * Arc length of the point on `path` nearest (x, y), projected onto the nearest
 * SEGMENT.
 *
 * trackAI.nearestS snaps to the nearest VERTEX and returns `path.cum[best]`,
 * which quantises to buildTrackPath's 1.5-tile resample step — 27 world px, or
 * 4.3 m. That is fine for ranking cars against each other (it is the same bias
 * for everyone) but not for deciding where to paint a line: it would put the
 * start/finish stripe up to 2.2 m off the staging tile it is supposed to mark.
 */
export function projectS(path: TrackPath, x: number, y: number): number {
  const m = path.cum.length;
  let bestS = 0;
  let bestD = Infinity;
  const last = path.closed ? m : m - 1;
  for (let i = 0; i < last; i++) {
    const j = (i + 1) % m;
    const ax = path.pts[i * 2], ay = path.pts[i * 2 + 1];
    const dx = path.pts[j * 2] - ax, dy = path.pts[j * 2 + 1] - ay;
    const len2 = dx * dx + dy * dy;
    if (len2 < 1e-9) continue;
    let t = ((x - ax) * dx + (y - ay) * dy) / len2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const d = (ax + dx * t - x) ** 2 + (ay + dy * t - y) ** 2;
    if (d < bestD) {
      bestD = d;
      bestS = path.cum[i] + Math.sqrt(len2) * t;
    }
  }
  return bestS;
}

/** Arc length of a tile CENTRE projected onto the centerline. */
export function arcOfTile(path: TrackPath, tile: readonly [number, number]): number {
  return projectS(path, (tile[0] + 0.5) * TILE, (tile[1] + 0.5) * TILE);
}

/**
 * +1 when the path's own vertex order runs the way cars drive, −1 when it runs
 * backwards. Without it a grid paints (and spawns) in FRONT of the line on any
 * track whose baked geometry happens to wind the other way.
 *
 * Each venue has a different ground truth for "forwards":
 *   - drag  : always +y — trackRace.advanceOpp pins the rival to `angle = π/2`
 *             and integrates `o.y += speed·dt`
 *   - sprint: summit → base, i.e. increasing arc length toward finishTile
 *   - lap   : the map's own spawn heading, sampled at the spawn point
 */
export function forwardSign(path: TrackPath, def: MapDef, spec: TrackRaceSpec): number {
  if (spec.kind === 'drag') {
    const p = poseAt(path, arcOfTile(path, spec.startTile), 0);
    return Math.sin(p.angle) >= 0 ? 1 : -1;
  }
  if (spec.kind === 'sprint' && spec.finishTile) {
    return arcOfTile(path, spec.finishTile) >= arcOfTile(path, spec.startTile) ? 1 : -1;
  }
  const sSpawn = nearestS(path, (def.spawnTile[0] + 0.5) * TILE, (def.spawnTile[1] + 0.5) * TILE);
  const p = poseAt(path, sSpawn, 0);
  const dot = Math.cos(p.angle) * Math.cos(def.spawnAngle)
    + Math.sin(p.angle) * Math.sin(def.spawnAngle);
  return dot >= 0 ? 1 : -1;
}

/** The line's arc length plus the driving direction along the path. */
export function startLineOn(
  path: TrackPath, def: MapDef, spec: TrackRaceSpec,
): { s: number; fwd: number } {
  return { s: arcOfTile(path, spec.startTile), fwd: forwardSign(path, def, spec) };
}

// ---------------------------------------------------------------------------
// 2. Generating the paint
// ---------------------------------------------------------------------------

export type DecalInk = 'white' | 'dark' | 'yellow';

/** One painted quad: four world-px corners, flat [x0,y0,x1,y1,x2,y2,x3,y3]. */
export interface DecalQuad {
  ink: DecalInk;
  pts: number[];
}

/** A cullable cluster of paint — a start/finish band, or a band plus its grid. */
export interface DecalGroup {
  /** Cull anchor (world px) + a radius covering every quad in the group. */
  cx: number;
  cy: number;
  r: number;
  quads: DecalQuad[];
}

/** Target checker square size in world px (~1.5 m). The real count is rounded
 *  from the pavement width so the band always divides evenly. */
const SQ_TARGET = 0.52 * TILE;
/** Rows of squares in a checkered band. */
const BAND_ROWS = 2;
/** Yellow edging: gap from the band, then line thickness (world px). */
const YEL_GAP = 1.6;
const YEL_TH = 1.8;

/** Emit one quad, expressed in track-local space at (ox,oy): (tx,ty) is the
 *  unit tangent, v runs ALONG the track in the driving direction, and u runs
 *  ACROSS it on the left normal. */
function quad(
  out: DecalQuad[], ink: DecalInk, ox: number, oy: number, tx: number, ty: number,
  v0: number, v1: number, u0: number, u1: number,
): void {
  const nx = -ty, ny = tx;
  out.push({
    ink,
    pts: [
      ox + tx * v0 + nx * u0, oy + ty * v0 + ny * u0,
      ox + tx * v1 + nx * u0, oy + ty * v1 + ny * u0,
      ox + tx * v1 + nx * u1, oy + ty * v1 + ny * u1,
      ox + tx * v0 + nx * u1, oy + ty * v0 + ny * u1,
    ],
  });
}

/** Unit tangent at arc length `s`, already flipped into the driving direction. */
function tangentAt(
  path: TrackPath, s: number, fwd: number,
): { x: number; y: number; tx: number; ty: number } {
  const p = poseAt(path, s, 0);
  return { x: p.x, y: p.y, tx: Math.cos(p.angle) * fwd, ty: Math.sin(p.angle) * fwd };
}

/** Two-row checkered band across the pavement, optionally with yellow edging.
 *  Each ROW is re-posed at its own arc length so the band follows a start/finish
 *  that curves — Laguna Seca bends straight through its own. */
function checkerBand(
  out: DecalQuad[], path: TrackPath, sLine: number, hw: number, fwd: number, edged: boolean,
): void {
  const nCols = Math.max(4, Math.round((hw * 2) / SQ_TARGET));
  const sq = (hw * 2) / nCols;
  const depth = START_BAND_DEPTH_T * TILE;
  const rowD = depth / BAND_ROWS;
  for (let j = 0; j < BAND_ROWS; j++) {
    const t = tangentAt(path, sLine + fwd * (-depth / 2 + (j + 0.5) * rowD), fwd);
    for (let i = 0; i < nCols; i++) {
      const u0 = -hw + i * sq;
      quad(out, (i + j) % 2 === 1 ? 'dark' : 'white',
        t.x, t.y, t.tx, t.ty, -rowD / 2, rowD / 2, u0, u0 + sq);
    }
  }
  if (!edged) return;
  for (const side of [-1, 1] as const) {
    const t = tangentAt(path, sLine + fwd * side * (depth / 2 + YEL_GAP + YEL_TH / 2), fwd);
    quad(out, 'yellow', t.x, t.y, t.tx, t.ty, -YEL_TH / 2, YEL_TH / 2, -hw, hw);
  }
}

/** A single solid painted line across the pavement (the drag strip's start). */
function solidLine(
  out: DecalQuad[], path: TrackPath, s: number, hw: number, fwd: number,
): void {
  const d = START_LINE_DEPTH_T * TILE;
  const t = tangentAt(path, s, fwd);
  quad(out, 'white', t.x, t.y, t.tx, t.ty, -d / 2, d / 2, -hw, hw);
}

/** One starting box: four white L-corner brackets, open-sided, as in the user's
 *  reference photos. Posed from its OWN arc length + lane offset so the whole
 *  grid tracks the curvature of the road it is painted on. */
function gridBox(
  out: DecalQuad[], path: TrackPath, sCentre: number, laneT: number, widT: number, fwd: number,
): void {
  const p = poseAt(path, sCentre, fwd * laneT * TILE);
  const tx = Math.cos(p.angle) * fwd, ty = Math.sin(p.angle) * fwd;
  const hl = (GRID_BOX_LEN_T * TILE) / 2;
  const hwd = (widT * TILE) / 2;
  const arm = GRID_BRACKET_ARM_T * TILE;
  const th = GRID_BRACKET_PX;
  for (const sv of [-1, 1] as const) {
    for (const su of [-1, 1] as const) {
      const v = sv * hl, u = su * hwd;
      // Transverse arm (across the track, at the box end).
      quad(out, 'white', p.x, p.y, tx, ty, v - sv * th, v, u - su * arm, u);
      // Longitudinal arm (along the track, down the box side).
      quad(out, 'white', p.x, p.y, tx, ty, v - sv * arm, v, u - su * th, u);
    }
  }
}

/** On an OPEN path (a drag strip or a touge pass) a box whose footprint runs
 *  off the end of the road would be painted on grass: poseAt clamps `s` to the
 *  path extent, so the box silently piles up at the terminus instead of
 *  disappearing. Skip it. A closed ring always fits. */
function fitsOn(path: TrackPath, s: number, halfLen: number): boolean {
  if (path.closed) return true;
  return s - halfLen >= 0 && s + halfLen <= path.total;
}

function group(path: TrackPath, s: number, r: number, quads: DecalQuad[]): DecalGroup {
  const p = poseAt(path, s, 0);
  return { cx: p.x, cy: p.y, r, quads };
}

/**
 * Every painted marking for one race venue.
 *
 * `hwPx` is HALF THE PAINTED ASPHALT in world px — the caller passes
 * `asphaltHalfPx(rowName, rowW)` minus an edge margin, so a band ends at the
 * curb line rather than overhanging onto grass.
 */
export function buildStartDecals(
  def: MapDef, path: TrackPath, hwPx: number,
): DecalGroup[] {
  const spec = def.race;
  if (!spec || !(hwPx > 0)) return [];
  const { s: sLine, fwd } = startLineOn(path, def, spec);
  const groups: DecalGroup[] = [];

  if (spec.kind === 'drag') {
    // START: a solid line, two staging boxes, and a pre-stage pair behind them.
    const start: DecalQuad[] = [];
    solidLine(start, path, sLine, hwPx, fwd);
    const halfLen = (GRID_BOX_LEN_T * TILE) / 2;
    for (let k = 0; k < 2; k++) {
      const slot = dragSlot(k);
      for (const backT of [slot.backT, DRAG_PRESTAGE_T]) {
        const s = sLine - fwd * backT * TILE;
        if (!fitsOn(path, s, halfLen)) continue;
        gridBox(start, path, s, slot.laneT, DRAG_BOX_WID_T, fwd);
      }
    }
    groups.push(group(path, sLine, hwPx + (DRAG_PRESTAGE_T + 3) * TILE, start));
    // FINISH: the checker, a true quarter mile (or spec.meters) down the strip.
    const sFin = sLine + fwd * (spec.meters ?? 402) * WPX_PER_M;
    const fin: DecalQuad[] = [];
    checkerBand(fin, path, sFin, hwPx, fwd, false);
    groups.push(group(path, sFin, hwPx + 4 * TILE, fin));
    return groups;
  }

  if (spec.kind === 'sprint') {
    const start: DecalQuad[] = [];
    checkerBand(start, path, sLine, hwPx, fwd, true);
    groups.push(group(path, sLine, hwPx + 4 * TILE, start));
    if (spec.finishTile) {
      const sFin = arcOfTile(path, spec.finishTile);
      const fin: DecalQuad[] = [];
      checkerBand(fin, path, sFin, hwPx, fwd, true);
      groups.push(group(path, sFin, hwPx + 4 * TILE, fin));
    }
    return groups;
  }

  // 'lap' — the four real circuits and the oval. One group: the checkered
  // start/finish band plus the staggered grid boxes behind it.
  const quads: DecalQuad[] = [];
  checkerBand(quads, path, sLine, hwPx, fwd, true);
  // The oval only ever fields one rival, so it gets two boxes, not eight.
  const slots = spec.ovalCenter ? 2 : GRID_SLOTS;
  for (let k = 0; k < slots; k++) {
    const slot = gridSlot(k);
    gridBox(quads, path, sLine - fwd * slot.backT * TILE, slot.laneT, GRID_BOX_WID_T, fwd);
  }
  const back = gridSlot(GRID_SLOTS - 1).backT + GRID_BOX_LEN_T;
  groups.push(group(path, sLine, hwPx + back * TILE, quads));
  return groups;
}
