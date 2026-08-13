// OSM-B: emit a game TS module from the built candidate rows (a class-tier slice).
//
//   node tools/osm/emit.mjs [tier]
//
// tier: 'highways' (default — motorway/trunk + their ramps) or 'arterials'
//       (adds primary + primary ramps; requires the spatial index first).
//
// Reads  fixtures/osm/charlotte_rows.json (tools/osm/build.mjs)
// Writes src/config/world/osmCharlotte.ts
//
// Data © OpenStreetMap contributors, ODbL.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const tier = process.argv[2] ?? 'highways';
const KEEP = {
  highways: ['motorway', 'trunk', 'motorway_link', 'trunk_link'],
  arterials: ['motorway', 'trunk', 'primary', 'motorway_link', 'trunk_link', 'primary_link'],
  full: null, // every class the builder kept
}[tier];
if (KEEP === undefined) throw new Error(`unknown tier ${tier}`);

const { meta, rows, props, intersections } = JSON.parse(
  readFileSync(join(ROOT, 'fixtures', 'osm', 'charlotte_rows.json'), 'utf8'));

const keptIdx = [];
for (let i = 0; i < rows.length; i++) if (!KEEP || KEEP.includes(props[i].class)) keptIdx.push(i);
// H1322: ramps split off — they emit as overlay MERGE rows (connector-builder
// contract) so the game renders them as smooth gore-tapered merge lanes with
// dashed channelizing, exactly like hand-drawn ➕ Lane merges.
const keptRows = [];
const keptProps = [];
const rampRows = [];
const rampProps = [];
for (const i of keptIdx) {
  if (props[i].class.endsWith('_link')) { rampRows.push(rows[i]); rampProps.push(props[i]); }
  else { keptRows.push(rows[i]); keptProps.push(props[i]); }
}

// ---- merge-lane conversion helpers (mirror crossingGeom lps ladder) ----
const LANE_W = 1.275;
function lpsFor(name, w) {
  if (name === 'I-485') return 3;
  if (w === 11 || w === 10) return 3;
  if (w >= 12) return 4;
  if (w >= 8) return 3;
  if (w >= 6) return 2;
  return 1;
}
function rowPts(r) {
  const pts = [];
  for (let k = 4; k < r.length; k += 2) pts.push([r[k], r[k + 1]]);
  return pts;
}
function nearestOnRow(px, py, r) {
  const pts = rowPts(r);
  let best = null;
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
    const dx = bx - ax, dy = by - ay;
    const l2 = dx * dx + dy * dy;
    let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    const x = ax + dx * t, y = ay + dy * t;
    const dd = (px - x) ** 2 + (py - y) ** 2;
    if (!best || dd < best.d2) best = { d2: dd, x, y, tx: dx, ty: dy };
  }
  return best;
}
function resample(pts, step) {
  const out = [pts[0].slice()];
  for (let i = 1; i < pts.length; i++) {
    let [ax, ay] = out[out.length - 1];
    const [bx, by] = pts[i];
    let d = Math.hypot(bx - ax, by - ay);
    while (d > step) {
      const t = step / d;
      ax = ax + (bx - ax) * t; ay = ay + (by - ay) * t;
      out.push([ax, ay]);
      d = Math.hypot(bx - ax, by - ay);
    }
    out.push([bx, by]);
  }
  return out;
}

// ---- H1322: convert ramps to connector-builder merge rows ----
// Contract (verified against worldMap.ts/taper.ts/merge/index.ts):
//   row  = [2, 0, name, 0, 4, x0,y0, ...]   w=2 (band paints 1.275t), z=0
//          (z>=2 overlay rows are bridge-painter hijacked), mergeFlag=4
//          (Standard + align-4, routes to the builderV band branch).
//   props= { builderV:2, laneCentered:true, bondInnerStart/End:[dx,dy] }
//          inward UNIT vectors tip -> destination centerline; only bonded
//          ends get one (free fork ends render a blunt full-width terminus).
//   tips sit lps_dest*1.275 tiles from the dest centerline on the ramp's
//   side (H987 stripe convention — NOT the centerline, NOT the fog line).
//   Vertices dense (band uses rawPts verbatim, no smoothing).
const RAMP_BOND_R = 3.5;
const RAMP_STEP = 2.5;
const mergeRampRows = [];
const mergeRampProps = {};
let bondedEnds = 0, freeEnds = 0;
for (let ri = 0; ri < rampRows.length; ri++) {
  const r = rampRows[ri];
  let pts = rowPts(r);
  if (pts.length < 2) continue;
  const prop = { builderV: 2, laneCentered: true };
  for (const end of [0, 1]) {
    const tip = end === 0 ? pts[0] : pts[pts.length - 1];
    const nbr = end === 0 ? pts[1] : pts[pts.length - 2];
    let best = null, bestRow = null;
    for (const kr of keptRows) {
      const n = nearestOnRow(tip[0], tip[1], kr);
      if (n && (!best || n.d2 < best.d2)) { best = n; bestRow = kr; }
    }
    if (!best || best.d2 > RAMP_BOND_R * RAMP_BOND_R) { freeEnds++; continue; }
    bondedEnds++;
    const tl = Math.hypot(best.tx, best.ty) || 1;
    let nx = -best.ty / tl, ny = best.tx / tl; // left normal of dest tangent
    const s = ((nbr[0] - best.x) * nx + (nbr[1] - best.y) * ny) >= 0 ? 1 : -1;
    nx *= s; ny *= s; // now points from dest centerline toward the ramp side
    const lps = lpsFor(String(bestRow[2]), bestRow[0]);
    const off = lps * LANE_W;
    const newTip = [best.x + nx * off, best.y + ny * off];
    if (end === 0) pts[0] = newTip; else pts[pts.length - 1] = newTip;
    const inward = [-nx, -ny]; // unit: tip -> dest centerline
    if (end === 0) prop.bondInnerStart = [+inward[0].toFixed(4), +inward[1].toFixed(4)];
    else prop.bondInnerEnd = [+inward[0].toFixed(4), +inward[1].toFixed(4)];
  }
  pts = resample(pts, RAMP_STEP).map(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10]);
  const flat = [];
  for (const p of pts) flat.push(p[0], p[1]);
  mergeRampProps[String(mergeRampRows.length)] = prop;
  mergeRampRows.push([2, 0, String(r[2]), 0, 4, ...flat]);
}
console.log(`merge ramps: ${mergeRampRows.length} rows, ${bondedEnds} bonded ends, ${freeEnds} free ends`);

// Keep only intersections within 6 tiles of a kept row's polyline (others
// would never find a crossing on this tier and are dead weight).
const SNAP = 6;
function nearRow(x, y) {
  for (const r of keptRows) {
    // cheap bbox first
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    for (let k = 4; k < r.length; k += 2) {
      if (r[k] < minx) minx = r[k]; if (r[k] > maxx) maxx = r[k];
      if (r[k + 1] < miny) miny = r[k + 1]; if (r[k + 1] > maxy) maxy = r[k + 1];
    }
    if (x < minx - SNAP || x > maxx + SNAP || y < miny - SNAP || y > maxy + SNAP) continue;
    for (let k = 4; k < r.length - 2; k += 2) {
      const ax = r[k], ay = r[k + 1], bx = r[k + 2], by = r[k + 3];
      const dx = bx - ax, dy = by - ay;
      const l2 = dx * dx + dy * dy;
      let t = l2 ? ((x - ax) * dx + (y - ay) * dy) / l2 : 0;
      t = Math.max(0, Math.min(1, t));
      const d2v = (x - (ax + dx * t)) ** 2 + (y - (ay + dy * t)) ** 2;
      if (d2v <= SNAP * SNAP) return true;
    }
  }
  return false;
}
const keptIsect = intersections.filter((r) => nearRow(r[7], r[8]));

// Spawn: on the longest I-485 row, at its midpoint vertex, heading along the row.
let spawnRow = null, spawnLen = -1;
for (const r of keptRows) {
  if (!String(r[2]).startsWith('I-485')) continue;
  let L = 0;
  for (let k = 4; k < r.length - 2; k += 2) L += Math.hypot(r[k + 2] - r[k], r[k + 3] - r[k + 1]);
  if (L > spawnLen) { spawnLen = L; spawnRow = r; }
}
if (!spawnRow) spawnRow = keptRows[0];
const nPts = (spawnRow.length - 4) / 2;
const mi = 4 + 2 * Math.floor(nPts / 2);
const sx = spawnRow[mi], sy = spawnRow[mi + 1];
const hx = spawnRow[mi + 2] - spawnRow[mi], hy = spawnRow[mi + 3] - spawnRow[mi + 1];
const spawnAngle = Math.atan2(hy, hx);

const verts = keptRows.reduce((s, r) => s + (r.length - 4) / 2, 0);
const byClass = {};
for (const p of keptProps) byClass[p.class] = (byClass[p.class] ?? 0) + 1;
console.log(`tier=${tier}: ${keptRows.length} rows, ${verts} verts, ${keptIsect.length} intersections`);
console.log(byClass);
console.log(`spawn on "${spawnRow[2]}" @ ${sx},${sy} angle ${spawnAngle.toFixed(3)}`);

const lines = [];
lines.push('// GENERATED by tools/osm/emit.mjs — do not hand-edit (re-run the tool).');
lines.push('// Charlotte, NC road network derived from OpenStreetMap.');
lines.push('// Data © OpenStreetMap contributors, licensed under ODbL 1.0.');
lines.push('// User-visible attribution is REQUIRED before store ship.');
lines.push(`// tier=${tier}: ${keptRows.length} rows / ${verts} verts / ${keptIsect.length} authored intersections.`);
lines.push(`// Projection: 1:${meta.scaleDiv} layout, center ${meta.center.map((v) => v.toFixed(4)).join(',')}, ${meta.mPerTile.toFixed(3)} m/tile.`);
lines.push('');
lines.push("import type { BaselineRoadRow } from './baselineRoads';");
lines.push('');
lines.push('export const OSM_CLT_ROWS: BaselineRoadRow[] = [');
for (const r of keptRows) lines.push(JSON.stringify(r) + ',');
lines.push('];');
lines.push('');
lines.push('// H1322: ramps as connector-builder MERGE rows for the base overlay —');
lines.push('// odd length = [w, maj, name, z, mergeFlag, x1,y1,...]; sidecars below.');
lines.push('export const OSM_CLT_RAMP_ROWS: (string | number)[][] = [');
for (const r of mergeRampRows) lines.push(JSON.stringify(r) + ',');
lines.push('];');
lines.push('');
lines.push('export const OSM_CLT_RAMP_PROPS: Record<string, {');
lines.push('  builderV: number; laneCentered: boolean;');
lines.push('  bondInnerStart?: number[]; bondInnerEnd?: number[];');
lines.push(`}> = ${JSON.stringify(mergeRampProps)};`);
lines.push('');
lines.push('// [\'isect\', control(0-4), la0,la1,la2,la3, turnMask, x, y] — see intersectionSchema.ts');
lines.push('export const OSM_CLT_INTERSECTIONS: (string | number)[][] = [');
for (const r of keptIsect) lines.push(JSON.stringify(r) + ',');
lines.push('];');
lines.push('');
lines.push(`export const OSM_CLT_SPAWN_TILE: [number, number] = [${sx}, ${sy}];`);
lines.push(`export const OSM_CLT_SPAWN_ANGLE = ${spawnAngle.toFixed(4)};`);
lines.push('');

const out = lines.join('\n');
writeFileSync(join(ROOT, 'src', 'config', 'world', 'osmCharlotte.ts'), out);
console.log(`wrote src/config/world/osmCharlotte.ts (${(out.length / 1024).toFixed(0)} KB)`);
