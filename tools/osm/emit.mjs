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
// H1322: ramps split off — GROUND ramp pieces emit as overlay MERGE rows
// (connector-builder contract: gore-tapered lanes with dashed channelizing);
// H1323: BRIDGED ramp pieces (z>=2 flyover spans) stay baseline rows and
// render as real decks whose 1.275t width matches the merge band.
const keptRows = [];
const keptProps = [];
const rampRows = [];
const rampProps = [];
for (const i of keptIdx) {
  if (props[i].class.endsWith('_link') && rows[i][3] < 2) {
    rampRows.push(rows[i]); rampProps.push(props[i]);
  } else { keptRows.push(rows[i]); keptProps.push(props[i]); }
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
/** Perpendicular distance centerline -> outer DRIVE edge on one side —
 *  lps*1.275 plus the median HALF-width on divided rows (getLaneGeom
 *  medFrac ladder). Omitting medHalf put tips ~1 tile inside the
 *  carriageway on divided highways (user: ramps don't connect). */
function edgeOffFor(name, w) {
  const lps = lpsFor(name, w);
  const carriageW = lps * 2 * LANE_W;
  const medFrac = (name === 'I-485' || w === 10) ? 0.25 : w === 11 ? 0.22 : w >= 12 ? 0.02 : 0;
  return lps * LANE_W + carriageW * medFrac * 0.5;
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
let bondedEnds = 0, freeEnds = 0, droppedInside = 0;
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
      // never gore-bond onto a ramp DECK SPAN — a ground ramp piece butts
      // into its own flyover deck at full width (same 1.275t), no taper.
      if (String(kr[2]).startsWith('Ramp')) continue;
      const n = nearestOnRow(tip[0], tip[1], kr);
      if (n && (!best || n.d2 < best.d2)) { best = n; bestRow = kr; }
    }
    if (!best || best.d2 > RAMP_BOND_R * RAMP_BOND_R) {
      // FORK BOND (H1323): a free end near ANOTHER ramp's path bonds into
      // it — the fork gores instead of two bands stopping near each other
      // (user: "washed legos, not connected").
      let fb = null, fbRow = null;
      for (const orr of rampRows) {
        if (orr === r) continue;
        const n = nearestOnRow(tip[0], tip[1], rowPts(orr));
        if (n && (!fb || n.d2 < fb.d2)) { fb = n; fbRow = orr; }
      }
      if (fb && fb.d2 <= 2.5 * 2.5) {
        const tlF = Math.hypot(fb.tx, fb.ty) || 1;
        let fnx = -fb.ty / tlF, fny = fb.tx / tlF;
        const fs = ((nbr[0] - fb.x) * fnx + (nbr[1] - fb.y) * fny) >= 0 ? 1 : -1;
        fnx *= fs; fny *= fs;
        const halfBand = (fbRow[0] >= 4 ? 2.55 : 1.275) / 2;
        const ft = [fb.x + fnx * halfBand, fb.y + fny * halfBand];
        if (end === 0) pts[0] = ft; else pts[pts.length - 1] = ft;
        const finw = [+(-fnx).toFixed(4), +(-fny).toFixed(4)];
        if (end === 0) prop.bondInnerStart = finw; else prop.bondInnerEnd = finw;
        bondedEnds++;
        continue;
      }
      freeEnds++;
      continue;
    }
    bondedEnds++;
    const tl = Math.hypot(best.tx, best.ty) || 1;
    let nx = -best.ty / tl, ny = best.tx / tl; // left normal of dest tangent
    const s = ((nbr[0] - best.x) * nx + (nbr[1] - best.y) * ny) >= 0 ? 1 : -1;
    nx *= s; ny *= s; // now points from dest centerline toward the ramp side
    const off = edgeOffFor(String(bestRow[2]), bestRow[0]);
    const newTip = [best.x + nx * off, best.y + ny * off];
    if (end === 0) pts[0] = newTip; else pts[pts.length - 1] = newTip;
    const inward = [-nx, -ny]; // unit: tip -> dest centerline
    if (end === 0) prop.bondInnerStart = [+inward[0].toFixed(4), +inward[1].toFixed(4)];
    else prop.bondInnerEnd = [+inward[0].toFixed(4), +inward[1].toFixed(4)];
    // (Approach-run clearance is handled by the general GRAZE CLEARANCE
    // pass below — it covers the bonded destination like any other row.)
  }
  pts = resample(pts, RAMP_STEP);
  // ramps living almost entirely INSIDE merged pavement (carriageway
  // connector stubs) are meaningless after the dual merge — drop BEFORE
  // clearance would smear them along the edge stripe.
  let insideRaw = 0;
  for (const p of pts) {
    for (const kr of keptRows) {
      if (String(kr[2]).startsWith('Ramp')) continue;
      const off = edgeOffFor(String(kr[2]), kr[0]);
      const n = nearestOnRow(p[0], p[1], kr);
      if (n && n.d2 < off * off * 0.9) { insideRaw++; break; }
    }
  }
  if (insideRaw / pts.length > 0.8) { droppedInside++; continue; }
  let pushedAny = false;
  // GRAZE CLEARANCE (H1323): a band must never run ALONG any highway's
  // pavement (its edges read as stray lines crossing the road — the X at
  // deck joints). Points inside a kept row's drive surface get pushed to
  // its edge stripe UNLESS the band genuinely CROSSES that row there
  // (neighbors on opposite sides = flyover/underpass, leave it).
  for (let k = 0; k < pts.length; k++) {
    for (const kr of keptRows) {
      if (String(kr[2]).startsWith('Ramp')) continue;
      const off = edgeOffFor(String(kr[2]), kr[0]);
      const n = nearestOnRow(pts[k][0], pts[k][1], kr);
      if (!n || n.d2 >= (off - 0.05) * (off - 0.05)) continue;
      const tl3 = Math.hypot(n.tx, n.ty) || 1;
      const px = -n.ty / tl3, py = n.tx / tl3;
      const side = (q) => {
        const m = nearestOnRow(q[0], q[1], kr);
        if (!m) return 0;
        const l = Math.hypot(m.tx, m.ty) || 1;
        return ((q[0] - m.x) * (-m.ty / l) + (q[1] - m.y) * (m.tx / l)) >= 0 ? 1 : -1;
      };
      const sPrev = k > 0 ? side(pts[k - 1]) : 0;
      const sNext = k + 1 < pts.length ? side(pts[k + 1]) : 0;
      if (sPrev !== 0 && sNext !== 0 && sPrev !== sNext) continue; // crossing
      const s = sPrev !== 0 ? sPrev : (sNext !== 0 ? sNext : 1);
      pts[k] = [n.x + px * s * off, n.y + py * s * off];
      pushedAny = true;
    }
  }
  // Point pushes create KINKS; a kinked centerline flips the band's normal
  // into a self-crossing bowtie (white X across the road — verified via
  // zoom render). Smooth the interior after any push, tips pinned.
  if (pushedAny && pts.length >= 3) {
    for (let pass = 0; pass < 3; pass++) {
      for (let k = 1; k < pts.length - 1; k++) {
        pts[k] = [
          pts[k][0] * 0.5 + (pts[k - 1][0] + pts[k + 1][0]) * 0.25,
          pts[k][1] * 0.5 + (pts[k - 1][1] + pts[k + 1][1]) * 0.25,
        ];
      }
    }
  }
  pts = pts.map(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10]);
  const flat = [];
  for (const p of pts) flat.push(p[0], p[1]);
  mergeRampProps[String(mergeRampRows.length)] = prop;
  // w from build's lane data (2 = single lane, 4 = 2-lane directional) —
  // the band renderer now honors it (taper.ts bandW).
  mergeRampRows.push([r[0] >= 4 ? 4 : 2, 0, String(r[2]), 0, 4, ...flat]);
}
// H1323 DEAD-END PRUNE (user: circled a merge lane connected to nothing) —
// a ramp end is ALIVE if it bonded, or touches another kept ramp, or sits
// within reach of any emitted road/deck row. Iteratively drop ramps with a
// dead end: stub chains (ramps to streets absent from this tier) collapse
// instead of dangling into grass.
{
  const oddPts = (r) => { const p = []; for (let k = 5; k < r.length; k += 2) p.push([r[k], r[k + 1]]); return p; };
  let live = mergeRampRows.map((row, i) => ({ row, prop: mergeRampProps[String(i)], pts: oddPts(row) }));
  const nearPolyline = (x, y, pts, rr) => {
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
      const dx = bx - ax, dy = by - ay;
      const l2 = dx * dx + dy * dy;
      let t = l2 ? ((x - ax) * dx + (y - ay) * dy) / l2 : 0;
      t = Math.max(0, Math.min(1, t));
      if ((x - (ax + dx * t)) ** 2 + (y - (ay + dy * t)) ** 2 <= rr * rr) return true;
    }
    return false;
  };
  const keptPts = keptRows.map((r) => { const p = []; for (let k = 4; k < r.length; k += 2) p.push([r[k], r[k + 1]]); return p; });
  let pruned = 0, changed = true;
  while (changed) {
    changed = false;
    const next = [];
    for (const rp of live) {
      let dead = false;
      for (const end of [0, 1]) {
        const bonded = end === 0 ? !!rp.prop.bondInnerStart : !!rp.prop.bondInnerEnd;
        if (bonded) continue;
        const tip = end === 0 ? rp.pts[0] : rp.pts[rp.pts.length - 1];
        let alive = false;
        for (const kp of keptPts) { if (nearPolyline(tip[0], tip[1], kp, 4.0)) { alive = true; break; } }
        if (!alive) for (const other of live) {
          if (other === rp) continue;
          if (nearPolyline(tip[0], tip[1], other.pts, 1.5)) { alive = true; break; }
        }
        if (!alive) { dead = true; break; }
      }
      if (dead) { pruned++; changed = true; } else next.push(rp);
    }
    live = next;
  }
  mergeRampRows.length = 0;
  for (const k of Object.keys(mergeRampProps)) delete mergeRampProps[k];
  live.forEach((rp, i) => { mergeRampRows.push(rp.row); mergeRampProps[String(i)] = rp.prop; });
  // Ramp DECK SPANS (baseline 'Ramp' rows) whose ground pieces died are
  // floating rectangles — drop any that no live merge ramp or road touches.
  let deckPruned = 0;
  for (let i = keptRows.length - 1; i >= 0; i--) {
    const r = keptRows[i];
    if (!String(r[2]).startsWith('Ramp')) continue;
    const p = []; for (let k = 4; k < r.length; k += 2) p.push([r[k], r[k + 1]]);
    let touched = false;
    for (const end of [p[0], p[p.length - 1]]) {
      for (const rp of live) { if (nearPolyline(end[0], end[1], rp.pts, 2.0)) { touched = true; break; } }
      if (!touched) for (let j = 0; j < keptRows.length && !touched; j++) {
        if (j === i || String(keptRows[j][2]).startsWith('Ramp')) continue;
        const q = []; for (let k = 4; k < keptRows[j].length; k += 2) q.push([keptRows[j][k], keptRows[j][k + 1]]);
        if (nearPolyline(end[0], end[1], q, 4.0)) touched = true;
      }
      if (touched) break;
    }
    if (!touched) { keptRows.splice(i, 1); keptProps.splice(i, 1); deckPruned++; }
  }
  console.log(`dead-end prune: ${pruned} dangling ramps + ${deckPruned} orphan ramp decks removed`);
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
// OSM-C: per-row sidecar props, keyed by OSM_CLT_ROWS index. Emitted SPARSELY
// (only rows that carry a flag) so the generated module stays small — today
// that is oneway only; maxspeed/lanes join in OSM-E/F with their own plumbing.
// Unpaired one-way carriageways + one-way ramp deck spans get oneway:true;
// merged dual carriageways are two-way divided (build.mjs sets oneway:false).
const baselineProps = {};
let owN = 0, deckN = 0;
for (let i = 0; i < keptRows.length; i++) {
  const src = keptProps[i];
  const p = {};
  if (src.oneway) { p.oneway = true; owN++; }
  // H1329: deck = a REAL bridge span (renders as a full editor deck). Whole
  // elevated freeways carry z>=4 WITHOUT this flag and take the city
  // treatment instead — see build.mjs pass 6b.
  if (src.deck) { p.deck = true; deckN++; }
  if (p.oneway || p.deck) baselineProps[String(i)] = p;
}
console.log(`baseline props: ${owN} oneway, ${deckN} deck rows of ${keptRows.length}`);
lines.push('// OSM-C/H1329: sparse per-row props keyed by OSM_CLT_ROWS index');
lines.push('// (oneway + deck today; maxspeed/lanes land with OSM-E/F).');
lines.push('// Flows via MapSource.baselineRoadProps.');
lines.push('export const OSM_CLT_PROPS: Record<string, {');
lines.push('  oneway?: boolean; deck?: boolean; maxspeed?: number; lanes?: number; class?: string;');
lines.push(`}> = ${JSON.stringify(baselineProps)};`);
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
