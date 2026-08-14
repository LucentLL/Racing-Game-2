// OSM-A/H1319: build Driver City candidate road rows from cached Overpass data.
//
//   node tools/osm/build.mjs
//
// Reads  fixtures/osm/raw/charlotte_{ways,nodes}.json  (tools/osm/fetch.mjs)
// Writes fixtures/osm/charlotte_rows.json   — candidate [w,maj,name,z,pts...]
//                                             rows + per-row props (oneway,
//                                             maxspeed, lanes, class) + 'isect'
//                                             intersection rows + stats
//        fixtures/osm/preview/*.svg         — contact sheets (the visual gate)
//
// H1319 DESIGN RULE (user): roads bake as WHOLE single rows — one row per
// real, connected, same-name road, exactly like the hand-built city baseline
// (the editor selects/edits whole roads; sections handle variation). No
// splitting at ramp gores or bridge spans. z follows the CITY convention:
// motorways are z=4 full-length (render-only elevation), surface roads z=0;
// only majority-elevated ramps/flyovers get z=4. The precise per-span bridge
// data stays in the raw fixtures for a future per-section bridge system.
//
// Pipeline:
//   1. classify + project    equirect lat/lon -> tile grid at 1:6 layout scale
//   2. junction split        temporary — clean graph for reassembly
//   3. whole-road weld       same (name/ref, class) chains rejoined THROUGH
//                            junctions (pairs matched per key at each node)
//   4. dual merge            paired one-way carriageways -> one divided line
//   5. stub weld + dual join relaxed micro-weld + same-key geometric joins
//   6. ramp tip snap         _link tips pulled onto their road's centerline
//   6b. grade separation     H1327: same-level crossings with NO shared OSM
//                            node are never real junctions — cut a window on
//                            one chain and raise its bridge level (the
//                            editor's section-cut + Bridge flag, automated)
//   7. clip + simplify       grid clip, RDP
//   8. emit                  rows + isect rows + SVGs + stats
//
// Data © OpenStreetMap contributors (ODbL).

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RAW = join(ROOT, 'fixtures', 'osm', 'raw');
const OUT_DIR = join(ROOT, 'fixtures', 'osm');
const PREV_DIR = join(OUT_DIR, 'preview');
mkdirSync(PREV_DIR, { recursive: true });

// ---------------------------------------------------------------- constants
const METERS_PER_TILE = 3.6576 / 1.275; // game canonical (tiles.ts)
const SCALE_DIV = 6;                    // layout compression (user decision)
const M_PER_TILE = METERS_PER_TILE * SCALE_DIV; // 17.212 real m per tile
const GRID = 2500;
const CENTER = 1250;

const CLASSES = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary'];
const SEP_MAX_M = { motorway: 95, trunk: 60, primary: 45, secondary: 35 }; // dual pairing
const RAMP_SNAP_TILES = 3.0;
const STUB_MAX_TILES = 3.0;
const DUAL_JOIN_TILES = 1.5;   // same-key merged-dual endpoint join
const RDP_EPS = 0.4;           // tiles
const MIN_ROW_TILES = 1.2;     // drop crumbs shorter than this

// ---------------------------------------------------------------- helpers
const d2 = (ax, ay, bx, by) => (ax - bx) ** 2 + (ay - by) ** 2;

function nearestOnSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return { x: ax + dx * t, y: ay + dy * t, t };
}

function nearestOnChain(px, py, chain) {
  const p = chain.pts;
  let best = null;
  for (let i = 0; i < p.length - 1; i++) {
    const n = nearestOnSeg(px, py, p[i][0], p[i][1], p[i + 1][0], p[i + 1][1]);
    const dd = d2(px, py, n.x, n.y);
    if (!best || dd < best.d2) best = { d2: dd, x: n.x, y: n.y, segIdx: i, t: n.t };
  }
  return best;
}

function chainLen(pts) {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return L;
}

function rdp(pts, eps) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let maxD = -1, maxI = -1;
    for (let i = a + 1; i < b; i++) {
      const n = nearestOnSeg(pts[i][0], pts[i][1], pts[a][0], pts[a][1], pts[b][0], pts[b][1]);
      const dd = Math.sqrt(d2(pts[i][0], pts[i][1], n.x, n.y));
      if (dd > maxD) { maxD = dd; maxI = i; }
    }
    if (maxD > eps) { keep[maxI] = 1; stack.push([a, maxI], [maxI, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

const round1 = (v) => Math.round(v * 10) / 10;

// ---------------------------------------------------------------- 1. load + project
const rawWays = JSON.parse(readFileSync(join(RAW, 'charlotte_ways.json'), 'utf8')).elements;
const rawNodes = JSON.parse(readFileSync(join(RAW, 'charlotte_nodes.json'), 'utf8')).elements;

let cLat = 0, cLon = 0, cN = 0;
for (const w of rawWays) {
  if (w.type !== 'way' || w.tags?.highway !== 'motorway') continue;
  if (!(w.tags.ref ?? '').replace(/\s/g, '').includes('I485')) continue;
  for (const g of w.geometry) { cLat += g.lat; cLon += g.lon; cN++; }
}
const LAT0 = cN ? cLat / cN : 35.2271;
const LON0 = cN ? cLon / cN : -80.8431;
const M_PER_LAT = 111132;
const M_PER_LON = 111320 * Math.cos((LAT0 * Math.PI) / 180);
const proj = (lat, lon) => [
  CENTER + ((lon - LON0) * M_PER_LON) / M_PER_TILE,
  CENTER - ((lat - LAT0) * M_PER_LAT) / M_PER_TILE,
];

function normRef(ref) {
  if (!ref) return null;
  const first = ref.split(';')[0].trim();
  return first.replace(/^I (\d)/, 'I-$1').replace(/^US (\d)/, 'US-$1').replace(/^NC (\d)/, 'NC-$1');
}

const ways = [];
for (const w of rawWays) {
  if (w.type !== 'way' || !w.tags || !w.geometry) continue;
  const hw = w.tags.highway ?? '';
  const link = hw.endsWith('_link');
  const cls = link ? hw.slice(0, -5) : hw;
  if (!CLASSES.includes(cls)) continue;
  if (w.tags.area === 'yes') continue;

  let nodes = w.nodes.slice();
  let pts = w.geometry.map((g) => proj(g.lat, g.lon));
  const roundabout = w.tags.junction === 'roundabout' || w.tags.junction === 'circular';
  let oneway = w.tags.oneway === 'yes' || w.tags.oneway === '-1' ||
    (w.tags.oneway === undefined && (cls === 'motorway' || roundabout));
  if (w.tags.oneway === '-1') { nodes.reverse(); pts.reverse(); }
  if (w.tags.oneway === 'no') oneway = false;

  const layer = parseInt(w.tags.layer ?? '0', 10) || 0;
  // Bridge LEVEL: 0 = ground, 1 = bridge (bridge=yes / layer=1),
  // 2 = stacked span (layer>=2 — the upper deck at system interchanges).
  const bridged = (w.tags.bridge && w.tags.bridge !== 'no') || layer > 0
    ? Math.max(1, Math.min(2, layer)) : 0;
  const lanes = parseInt(w.tags.lanes ?? '', 10) || 0;
  const ref = normRef(w.tags.ref);
  const name = w.tags.name ?? null;
  const maxspeed = /(\d+)\s*mph/.exec(w.tags.maxspeed ?? '')?.[1];

  ways.push({
    id: w.id, cls, link, roundabout, oneway, bridged, lanes,
    ref, name, key: `${cls}|${link ? 'L' : ''}|${ref ?? name ?? ''}`,
    maxspeed: maxspeed ? parseInt(maxspeed, 10) : 0,
    destination: w.tags.destination ?? null,
    nodes, pts,
  });
}
console.log(`[1] kept ${ways.length}/${rawWays.length} ways; projection center ${LAT0.toFixed(4)},${LON0.toFixed(4)}`);

// H1327: node id -> projected tile position, for the grade-separation pass.
// nodes[i] pairs with pts[i] (Overpass `out geom` parallel arrays; the
// oneway=-1 reversal above flipped both together).
const nodePos = new Map();
for (const w of ways) for (let i = 0; i < w.nodes.length; i++) nodePos.set(w.nodes[i], w.pts[i]);

// ---------------------------------------------------------------- 2. junction split
const nodeUse = new Map();
for (const w of ways) for (const id of w.nodes) nodeUse.set(id, (nodeUse.get(id) ?? 0) + 1);

let segs = [];
for (const w of ways) {
  let start = 0;
  for (let i = 1; i < w.nodes.length; i++) {
    const isEnd = i === w.nodes.length - 1;
    if (isEnd || nodeUse.get(w.nodes[i]) >= 2) {
      segs.push({ ...w, nodes: w.nodes.slice(start, i + 1), pts: w.pts.slice(start, i + 1) });
      start = i;
    }
  }
}
console.log(`[2] junction split: ${segs.length} segments`);

// ---------------------------------------------------------------- 3. whole-road weld
// Rejoin same-road chains THROUGH junctions: at each shared node, ends are
// grouped by compat key; a key-group with exactly two ends welds, no matter
// how many OTHER roads meet there. A street therefore stays one row across
// every crossing, exactly like the hand-drawn city baseline.
function makeChain(seg) {
  return {
    cls: seg.cls, link: seg.link, roundabout: seg.roundabout, oneway: seg.oneway,
    key: seg.key, ref: seg.ref, name: seg.name,
    maxspeed: seg.maxspeed, destination: seg.destination,
    pts: seg.pts.slice(),
    endNodes: [seg.nodes[0], seg.nodes[seg.nodes.length - 1]],
    // H1327: every OSM node this chain passes through — the authority on
    // which geometric crossings are REAL at-grade junctions (see pass 6b).
    // Unioned at every combine site (weld, dual merge, gap weld).
    nodeIds: new Set(seg.nodes),
    ptBr: seg.pts.map(() => seg.bridged),
    ptLanes: seg.pts.map(() => seg.lanes),
  };
}

function weldKey(c, relaxed) {
  return relaxed
    ? `${c.cls}|${c.link ? 'L' : ''}|${c.oneway ? '1' : '0'}`
    : `${c.key}|${c.oneway ? '1' : '0'}|${c.roundabout ? 'R' : ''}`;
}

function weld(chains, { relaxed = false, maxLen = Infinity } = {}) {
  const endMap = new Map(); // nodeId -> [{c, end}]
  const reg = (c) => {
    for (const end of [0, 1]) {
      const id = c.endNodes[end];
      if (id == null) continue;
      if (!endMap.has(id)) endMap.set(id, []);
      endMap.get(id).push({ c, end });
    }
  };
  chains.forEach(reg);
  const dead = new Set();
  let progress = true;
  while (progress) {
    progress = false;
    for (const [, list] of endMap) {
      const live = list.filter((e) => !dead.has(e.c));
      if (live.length < 2) continue;
      // group by weld key; weld any key-group of EXACTLY two ends
      const byKey = new Map();
      for (const e of live) {
        const k = weldKey(e.c, relaxed);
        if (!byKey.has(k)) byKey.set(k, []);
        byKey.get(k).push(e);
      }
      for (const group of byKey.values()) {
        if (group.length !== 2) continue;
        const [a, b] = group;
        if (a.c === b.c) continue; // ring closes implicitly
        if (relaxed && Math.min(chainLen(a.c.pts), chainLen(b.c.pts)) >= maxLen) continue;
        const A = a.c, B = b.c;
        const flip = (c) => { c.pts.reverse(); c.ptBr.reverse(); c.ptLanes.reverse(); c.endNodes.reverse(); };
        if (a.end === 0) flip(A);
        if (b.end === 1) flip(B);
        // HAIRPIN GATE: a continuation must keep heading roughly forward.
        // At divided->undivided transitions BOTH one-way carriageway ends
        // share the node and the same key (the two-way piece keys
        // differently), and welding them folds the road back on itself —
        // downstream the dual-merge walker then emits midlines with
        // 50-110-tile vertex jumps (probed). Reject joins turning >120°.
        const ta = A.pts[A.pts.length - 1], tb = A.pts[Math.max(0, A.pts.length - 2)];
        const sa = B.pts[0], sb = B.pts[Math.min(B.pts.length - 1, 1)];
        const dax = ta[0] - tb[0], day = ta[1] - tb[1];
        const dbx = sb[0] - sa[0], dby = sb[1] - sa[1];
        const la = Math.hypot(dax, day) || 1, lb = Math.hypot(dbx, dby) || 1;
        if ((dax * dbx + day * dby) / (la * lb) < -0.5) continue;
        A.pts = A.pts.concat(B.pts.slice(1));
        A.ptBr = A.ptBr.concat(B.ptBr.slice(1));
        A.ptLanes = A.ptLanes.concat(B.ptLanes.slice(1));
        A.endNodes = [A.endNodes[0], B.endNodes[1]];
        if (B.nodeIds) { A.nodeIds = A.nodeIds ?? new Set(); for (const n of B.nodeIds) A.nodeIds.add(n); }
        if (!A.name && B.name) A.name = B.name;
        if (!A.maxspeed && B.maxspeed) A.maxspeed = B.maxspeed;
        dead.add(B);
        reg(A);
        progress = true;
        break; // endMap entries changed; rescan
      }
    }
  }
  return { chains: chains.filter((c) => !dead.has(c)) };
}

let { chains } = weld(segs.map(makeChain));
console.log(`[3] whole-road weld: ${chains.length} chains`);

// ---------------------------------------------------------------- 4. dual-carriageway merge
const groups = new Map();
for (const c of chains) {
  if (!c.oneway || c.link || c.roundabout || c.cls === 'tertiary') continue;
  if (!(c.ref ?? c.name)) continue;
  const k = `${c.cls}|${c.ref ?? c.name}`;
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(c);
}

const consumed = new Set();
const mergedChains = [];
for (const [k, group] of groups) {
  if (group.length < 2) continue;
  const sepMax = (SEP_MAX_M[group[0].cls] ?? 40) / M_PER_TILE;
  group.sort((a, b) => chainLen(b.pts) - chainLen(a.pts));
  for (const A of group) {
    if (consumed.has(A)) continue;
    const partners = group.filter((B) => B !== A && !consumed.has(B));
    if (!partners.length) continue;
    const mid = [], midBr = [], midLanes = [];
    let matched = 0;
    for (let i = 0; i < A.pts.length; i++) {
      const [px, py] = A.pts[i];
      let best = null, bestChain = null;
      for (const B of partners) {
        const n = nearestOnChain(px, py, B);
        if (n && (!best || n.d2 < best.d2)) { best = n; bestChain = B; }
      }
      if (best && best.d2 <= sepMax * sepMax) {
        matched++;
        mid.push([(px + best.x) / 2, (py + best.y) / 2]);
        midBr.push(Math.max(A.ptBr[i], bestChain.ptBr[best.segIdx] ?? 0));
        midLanes.push(Math.max(A.ptLanes[i], bestChain.ptLanes[best.segIdx] ?? 0));
      } else {
        mid.push([px, py]);
        midBr.push(A.ptBr[i]);
        midLanes.push(A.ptLanes[i]);
      }
    }
    if (matched / A.pts.length < 0.5) continue;
    consumed.add(A);
    // Consume partners substantially covered by A so they can't run their own
    // walk and emit a DUPLICATE midline over the same corridor (removing this
    // measured I-485 at 9,718 tiles of divided rows vs ~6,700 real). Partial
    // leftovers (<60% covered) fall through to the [4b] span cleanup below.
    for (const B of partners) {
      let hits = 0, sampled = 0;
      const step = Math.max(1, Math.floor(B.pts.length / 40));
      for (let i = 0; i < B.pts.length; i += step) {
        sampled++;
        const n = nearestOnChain(B.pts[i][0], B.pts[i][1], A);
        if (n && n.d2 <= sepMax * sepMax) hits++;
      }
      if (hits / sampled > 0.6) consumed.add(B);
    }
    const lanesVals = midLanes.filter(Boolean).sort((x, y) => x - y);
    // H1327: the merged midline inherits BOTH carriageways' node sets — its
    // at-grade junctions are wherever either carriageway had one.
    const mergedIds = new Set(A.nodeIds ?? []);
    for (const B of partners) if (B.nodeIds) for (const n of B.nodeIds) mergedIds.add(n);
    mergedChains.push({
      cls: A.cls, link: false, roundabout: false, oneway: false, divided: true,
      key: k, ref: A.ref, name: A.name, maxspeed: A.maxspeed, destination: null,
      pts: mid, ptBr: midBr, ptLanes: midLanes,
      endNodes: [null, null],
      nodeIds: mergedIds,
      perDirLanes: lanesVals[Math.floor(lanesVals.length / 2)] ?? 0,
    });
  }
}
// Span-level partner cleanup: every one-way group member that was NOT the
// merge walker gets its points tested against the group's merged midlines;
// covered spans are REMOVED (they're already represented by the merged row)
// and only genuinely-unpaired tails >= 6 tiles survive as separate one-way
// carriageway rows. The old all-or-nothing consumption (>60% covered = drop
// whole chain) left ~a dozen short covered scraps at interchanges that then
// rendered as full divided highways doubled over the merged line (user's
// screenshot: twin yellow centerlines weaving along I-85/I-77).
const REMNANT_MIN_TILES = 6;
{
  const mergedByKey = new Map();
  for (const m of mergedChains) {
    if (!mergedByKey.has(m.key)) mergedByKey.set(m.key, []);
    mergedByKey.get(m.key).push(m);
  }
  const survivors = [];
  let trimmed = 0, dropped = 0;
  for (const c of chains) {
    if (consumed.has(c)) continue;
    const k = c.oneway && !c.link && !c.roundabout && (c.ref ?? c.name) ? `${c.cls}|${c.ref ?? c.name}` : null;
    const merged = k ? mergedByKey.get(k) : null;
    if (!merged || !merged.length) { survivors.push(c); continue; }
    const sepMax = (SEP_MAX_M[c.cls] ?? 40) / M_PER_TILE;
    const covered = c.pts.map((p) => {
      for (const m of merged) {
        const n = nearestOnChain(p[0], p[1], m);
        if (n && n.d2 <= sepMax * sepMax) return true;
      }
      return false;
    });
    if (!covered.some(Boolean)) { survivors.push(c); continue; }
    // keep maximal uncovered runs (with one covered point of overlap at each
    // end so the tail still touches the merged road)
    let run = null;
    const runs = [];
    for (let i = 0; i < c.pts.length; i++) {
      if (!covered[i]) {
        if (!run) { run = { a: Math.max(0, i - 1), b: i }; }
        run.b = i;
      } else if (run) { run.b = Math.min(c.pts.length - 1, run.b + 1); runs.push(run); run = null; }
    }
    if (run) runs.push(run);
    let kept = 0;
    for (const r of runs) {
      const pts = c.pts.slice(r.a, r.b + 1);
      if (pts.length < 2 || chainLen(pts) < REMNANT_MIN_TILES) continue;
      survivors.push({
        ...c,
        pts,
        ptBr: c.ptBr.slice(r.a, r.b + 1),
        ptLanes: c.ptLanes.slice(r.a, r.b + 1),
        endNodes: [null, null],
      });
      kept++;
    }
    if (kept > 0) trimmed++; else dropped++;
  }
  console.log(`[4b] remnant cleanup: ${dropped} covered scraps dropped, ${trimmed} chains trimmed to uncovered tails`);
  chains = survivors.concat(mergedChains);
}
console.log(`[4] dual merge: ${mergedChains.length} merged chains; ${chains.length} total`);

// ---------------------------------------------------------------- 5. stub weld + dual join
({ chains } = weld(chains, { relaxed: true, maxLen: STUB_MAX_TILES }));

// Same-key geometric GAP WELD. Merged duals lose node ids, and carriageway
// chains break where 3+ same-key ends meet at interchange nodes — the
// Pineville probe showed two South-Tryon midline pieces ending 5-8 tiles
// apart with nothing between (the user's visible road gap). Bridge free
// endpoints of the SAME key within GAP_WELD_TILES when both tangents agree
// the road continues forward (dot > 0.2 — this can never re-create the
// hairpin welds the [3] gate rejects).
const GAP_WELD_TILES = 8;
let gapJoins = 0;
{
  const byKey = new Map();
  for (const c of chains) {
    if (c.link || c.roundabout) continue;
    if (!byKey.has(c.key)) byKey.set(c.key, []);
    byKey.get(c.key).push(c);
  }
  const dead = new Set();
  for (const group of byKey.values()) {
    if (group.length < 2) continue;
    let progress = true;
    while (progress) {
      progress = false;
      const live = group.filter((c) => !dead.has(c));
      outer: for (const A of live) {
        for (const B of live) {
          if (A === B) continue;
          for (const ea of [0, 1]) {
            for (const eb of [0, 1]) {
              const pa = ea === 0 ? A.pts[0] : A.pts[A.pts.length - 1];
              const pb = eb === 0 ? B.pts[0] : B.pts[B.pts.length - 1];
              if (d2(pa[0], pa[1], pb[0], pb[1]) > GAP_WELD_TILES * GAP_WELD_TILES) continue;
              const flip = (c) => { c.pts.reverse(); c.ptBr.reverse(); c.ptLanes.reverse(); };
              if (ea === 0) flip(A);
              if (eb === 1) flip(B);
              // forward-continuation tangent gate at the bridged joint
              const t1 = A.pts[A.pts.length - 1], t0 = A.pts[Math.max(0, A.pts.length - 2)];
              const s0 = B.pts[0], s1 = B.pts[Math.min(B.pts.length - 1, 1)];
              const dax = t1[0] - t0[0], day = t1[1] - t0[1];
              const dbx = s1[0] - s0[0], dby = s1[1] - s0[1];
              const la = Math.hypot(dax, day) || 1, lb = Math.hypot(dbx, dby) || 1;
              if ((dax * dbx + day * dby) / (la * lb) < 0.2) continue;
              const jointIdx = A.pts.length - 1;
              A.pts = A.pts.concat(B.pts);
              A.ptBr = A.ptBr.concat(B.ptBr);
              A.ptLanes = A.ptLanes.concat(B.ptLanes);
              A.perDirLanes = Math.max(A.perDirLanes ?? 0, B.perDirLanes ?? 0);
              A.divided = A.divided || B.divided;
              if (B.nodeIds) { A.nodeIds = A.nodeIds ?? new Set(); for (const n of B.nodeIds) A.nodeIds.add(n); }
              // H1323: EASE the joint — a bridged lateral offset (midline
              // vs carriageway alignment) rendered as a hard dogleg whose
              // markings fanned across the seam. Local Laplacian over ±5
              // points, window ends pinned, spreads the offset over ~10
              // tiles. Open-polyline window; no shrink risk.
              const w0 = Math.max(1, jointIdx - 5);
              const w1 = Math.min(A.pts.length - 2, jointIdx + 6);
              for (let pass = 0; pass < 3; pass++) {
                for (let k = w0 + 1; k < w1; k++) {
                  A.pts[k] = [
                    A.pts[k][0] * 0.5 + (A.pts[k - 1][0] + A.pts[k + 1][0]) * 0.25,
                    A.pts[k][1] * 0.5 + (A.pts[k - 1][1] + A.pts[k + 1][1]) * 0.25,
                  ];
                }
              }
              dead.add(B);
              gapJoins++;
              progress = true;
              break outer;
            }
          }
        }
      }
    }
  }
  chains = chains.filter((c) => !dead.has(c));
}
console.log(`[5] stub weld + ${gapJoins} same-key gap welds: ${chains.length} chains`);

// ---------------------------------------------------------------- 6. ramp tip snap
const snapTargets = chains.filter((c) => !c.link);
let snapped = 0, unsnapped = 0;
for (const c of chains) {
  if (!c.link) continue;
  for (const end of [0, 1]) {
    const tip = end === 0 ? c.pts[0] : c.pts[c.pts.length - 1];
    let best = null;
    for (const t of snapTargets) {
      const n = nearestOnChain(tip[0], tip[1], t);
      if (n && (!best || n.d2 < best.d2)) best = n;
    }
    if (best && best.d2 <= RAMP_SNAP_TILES * RAMP_SNAP_TILES) {
      const p = [best.x, best.y];
      if (end === 0) c.pts[0] = p; else c.pts[c.pts.length - 1] = p;
      snapped++;
    } else unsnapped++;
  }
}
console.log(`[6] ramp snap: ${snapped} tips snapped, ${unsnapped} free`);

// ---------------------------------------------------------------- 6a. junction end snap
// H1328 (user: "gaps where roads meet"). A chain END that shared an OSM node
// with another chain used to TOUCH it — but the dual-carriageway merge moved
// that road onto a midline 2-5 tiles away (and remnant trims cut tails), so
// hundreds of side-road ends now hang short of the highway they junction
// with (206 ends measured 1.5-6t off). Snap such an end ONTO the road it
// shares the node with: topology-gated (a cul-de-sac genuinely NEAR a
// freeway shares no node and never snaps).
const END_SNAP_TILES = 8;
{
  let endSnaps = 0;
  for (const c of chains) {
    if (c.link) continue; // ramp tips handled by [6]
    for (const end of [0, 1]) {
      const tip = end === 0 ? c.pts[0] : c.pts[c.pts.length - 1];
      let best = null;
      for (const t of chains) {
        if (t === c || !t.nodeIds || !c.nodeIds) continue;
        // shared-node gate near this end
        let sharedNear = false;
        const [small, big] = c.nodeIds.size <= t.nodeIds.size ? [c.nodeIds, t.nodeIds] : [t.nodeIds, c.nodeIds];
        for (const n of small) {
          if (!big.has(n)) continue;
          const p = nodePos.get(n);
          if (p && d2(p[0], p[1], tip[0], tip[1]) <= END_SNAP_TILES * END_SNAP_TILES) { sharedNear = true; break; }
        }
        if (!sharedNear) continue;
        const n = nearestOnChain(tip[0], tip[1], t);
        if (n && (!best || n.d2 < best.d2)) best = n;
      }
      // Only heal genuine shortfalls: already-touching ends (< 1t) stay, and
      // anything past the shared-node radius is a different feature.
      if (best && best.d2 > 1 * 1 && best.d2 <= END_SNAP_TILES * END_SNAP_TILES) {
        const p = [best.x, best.y];
        if (end === 0) c.pts.unshift(p); else c.pts.push(p);
        if (end === 0) { c.ptBr.unshift(c.ptBr[0]); c.ptLanes.unshift(c.ptLanes[0]); }
        else { c.ptBr.push(c.ptBr[c.ptBr.length - 1]); c.ptLanes.push(c.ptLanes[c.ptLanes.length - 1]); }
        endSnaps++;
      }
    }
  }
  console.log(`[6a] junction end snap: ${endSnaps} hanging ends extended onto their junction road`);
}

// ---------------------------------------------------------------- 6b. grade separation
// H1327 (user rule): two roads may only cross AT THE SAME LEVEL where OSM
// says they actually meet — a node shared by both chains at the crossing.
// Every other same-level geometric crossing is a grade separation in the
// real city (OSM ways that cross without a shared node NEVER meet), and
// rendering both at z=0 made interchanges collide into scribble (crossing
// decals, junction boxes, band X-marks across freeways). Fix = exactly the
// editor's section-cut + Bridge-flag feature, automated: raise a short
// window of ONE chain's per-point bridge level over the crossing, and
// splitByLevel below turns it into a proper deck span with approaches.
//
// Which chain lifts: existing bridge evidence nearby wins (the OSM bridge
// tag ended a hair short of the crossing — extend it); else the ramp lifts
// over the mainline; else the shorter chain lifts. Runs to a fixpoint so
// stacked crossings resolve (lvl1 over lvl1 -> one goes to lvl2 = z5).
const LIFT_HALF_TILES = 4.0;     // half-window along the lifted chain
const JUNCTION_TOL_TILES = 6.0;  // shared node within this = real junction
const END_SKIP_TILES = 2.5;      // crossings at chain ends are joins/tips
{
  const segCross = (a, b, c, d) => {
    const rx = b[0] - a[0], ry = b[1] - a[1], sx = d[0] - c[0], sy = d[1] - c[1];
    const det = rx * sy - ry * sx;
    if (Math.abs(det) < 1e-9) return null;
    const qx = c[0] - a[0], qy = c[1] - a[1];
    const u = (qx * sy - qy * sx) / det, v = (qx * ry - qy * rx) / det;
    if (u < 0 || u > 1 || v < 0 || v > 1) return null;
    return [a[0] + rx * u, a[1] + ry * u];
  };
  const arcOfIdx = (c) => {
    const arc = [0];
    for (let i = 1; i < c.pts.length; i++) {
      arc.push(arc[i - 1] + Math.hypot(c.pts[i][0] - c.pts[i - 1][0], c.pts[i][1] - c.pts[i - 1][1]));
    }
    return arc;
  };
  // Link crossings use a TIGHT tolerance: interchange ramps share their fork
  // node, and at 1:6 compression a braided re-cross lands only a few tiles
  // from it — 6t legitimized those braids (they stayed flat and collided).
  // Real braided ramps always bridge; a genuine at-grade slip-ramp crossing
  // has its shared node essentially AT the crossing point. Row-row keeps the
  // wide tolerance because merged dual midlines shift junctions laterally.
  const sharedJunctionNear = (A, B, x, y) => {
    if (!A.nodeIds || !B.nodeIds) return false;
    const tol = (A.link || B.link) ? 2.5 : JUNCTION_TOL_TILES;
    const [small, big] = A.nodeIds.size <= B.nodeIds.size ? [A.nodeIds, B.nodeIds] : [B.nodeIds, A.nodeIds];
    for (const n of small) {
      if (!big.has(n)) continue;
      const p = nodePos.get(n);
      if (p && d2(p[0], p[1], x, y) <= tol * tol) return true;
    }
    return false;
  };
  const bridgedNear = (c, segIdx, radiusTiles) => {
    const arc = arcOfIdx(c);
    const at = arc[segIdx];
    for (let i = 0; i < c.ptBr.length; i++) {
      if (c.ptBr[i] > 0 && Math.abs(arc[i] - at) <= radiusTiles) return true;
    }
    return false;
  };
  // Raise ptBr to `lvl` for every vertex within LIFT_HALF_TILES (arc) of the
  // crossing, inserting window-boundary vertices so a long straight segment
  // still grows a run splitByLevel can cut (its cuts land mid-segment, so
  // the injected collinear points cost nothing visually; RDP runs later).
  // Position-based (re-projects x,y fresh): a prior lift on the SAME chain
  // splices vertices, so any segIdx captured during the scan goes stale.
  const liftWindow = (c, x, y, lvl) => {
    const n = nearestOnChain(x, y, c);
    if (!n) return;
    const arc = arcOfIdx(c);
    const segA = c.pts[n.segIdx];
    const atArc = arc[n.segIdx] + Math.hypot(n.x - segA[0], n.y - segA[1]);
    const s0 = Math.max(0, atArc - LIFT_HALF_TILES);
    const s1 = Math.min(arc[arc.length - 1], atArc + LIFT_HALF_TILES);
    const insertAt = (s) => {
      for (let i = 0; i < arc.length; i++) if (Math.abs(arc[i] - s) < 0.75) return; // vertex exists
      for (let i = 0; i + 1 < arc.length; i++) {
        if (arc[i] < s && s < arc[i + 1]) {
          const t = (s - arc[i]) / (arc[i + 1] - arc[i]);
          const px = c.pts[i][0] + (c.pts[i + 1][0] - c.pts[i][0]) * t;
          const py = c.pts[i][1] + (c.pts[i + 1][1] - c.pts[i][1]) * t;
          c.pts.splice(i + 1, 0, [px, py]);
          c.ptBr.splice(i + 1, 0, c.ptBr[i]);
          c.ptLanes.splice(i + 1, 0, c.ptLanes[i]);
          arc.splice(i + 1, 0, s);
          return;
        }
      }
    };
    insertAt(s0);
    insertAt(s1);
    const arc2 = arcOfIdx(c);
    for (let i = 0; i < c.pts.length; i++) {
      if (arc2[i] >= s0 - 1e-6 && arc2[i] <= s1 + 1e-6) c.ptBr[i] = Math.max(c.ptBr[i], lvl);
    }
  };
  let lifts = 0, stuck = 0, legit = 0;
  const dbgDecisions = process.env.DEBUG_6B ? [] : null;
  const CELL = 8; // tiles — spatial hash so corridor pairs stay near-linear
  for (let round = 0; round < 3; round++) {
    // Global segment grid: cell -> [{ci, si}]. Crossing candidates are only
    // ever segments sharing a cell (segment bboxes rasterized into cells).
    const grid = new Map();
    for (let ci = 0; ci < chains.length; ci++) {
      const pts = chains[ci].pts;
      for (let si = 0; si + 1 < pts.length; si++) {
        const x0 = Math.floor(Math.min(pts[si][0], pts[si + 1][0]) / CELL);
        const x1 = Math.floor(Math.max(pts[si][0], pts[si + 1][0]) / CELL);
        const y0 = Math.floor(Math.min(pts[si][1], pts[si + 1][1]) / CELL);
        const y1 = Math.floor(Math.max(pts[si][1], pts[si + 1][1]) / CELL);
        for (let gx = x0; gx <= x1; gx++) for (let gy = y0; gy <= y1; gy++) {
          const key = gx * 100000 + gy;
          if (!grid.has(key)) grid.set(key, []);
          grid.get(key).push(ci * 1e6 + si);
        }
      }
    }
    // {c, x, y, lvl} — collected per round, applied after the scan so vertex
    // insertion can't shift the walk mid-flight.
    const found = [];
    const foundKeys = new Set();
    const seenSegPair = new Set();
    for (const list of grid.values()) {
      if (list.length < 2) continue;
      for (let a = 0; a < list.length; a++) for (let b = a + 1; b < list.length; b++) {
        const ci = Math.floor(list[a] / 1e6), si = list[a] % 1e6;
        const cj = Math.floor(list[b] / 1e6), sj = list[b] % 1e6;
        if (ci === cj) continue; // self-crossings out of scope
        const pairKey = list[a] < list[b] ? `${list[a]}|${list[b]}` : `${list[b]}|${list[a]}`;
        if (seenSegPair.has(pairKey)) continue;
        seenSegPair.add(pairKey);
        const A = chains[ci], B = chains[cj];
        const X = segCross(A.pts[si], A.pts[si + 1], B.pts[sj], B.pts[sj + 1]);
        if (!X) continue;
        const nearOwnEnd = [
          A.pts[0], A.pts[A.pts.length - 1], B.pts[0], B.pts[B.pts.length - 1],
        ].some((e) => d2(e[0], e[1], X[0], X[1]) <= END_SKIP_TILES * END_SKIP_TILES);
        if (nearOwnEnd) continue;
        const lvlA = Math.max(A.ptBr[si], A.ptBr[si + 1]);
        const lvlB = Math.max(B.ptBr[sj], B.ptBr[sj + 1]);
        if (lvlA !== lvlB) continue;                    // already separated
        if (sharedJunctionNear(A, B, X[0], X[1])) {
          legit++;
          dbgDecisions?.push({ d: 'legit', x: round1(X[0]), y: round1(X[1]), a: String(A.name ?? A.key), b: String(B.name ?? B.key) });
          continue;
        }
        if (lvlA >= 2) {
          stuck++;
          dbgDecisions?.push({ d: 'stuck', x: round1(X[0]), y: round1(X[1]), a: String(A.name ?? A.key), b: String(B.name ?? B.key) });
          continue;
        }
        const brA = bridgedNear(A, si, 10), brB = bridgedNear(B, sj, 10);
        let pick;
        if (brA !== brB) pick = brA ? A : B;
        else if (A.link !== B.link) pick = A.link ? A : B;
        else pick = chainLen(A.pts) <= chainLen(B.pts) ? A : B;
        // one lift per chain-vicinity per round: key on rounded position
        const fk = `${pick === A ? ci : cj}:${Math.round(X[0] / 4)},${Math.round(X[1] / 4)}`;
        if (foundKeys.has(fk)) continue;
        foundKeys.add(fk);
        found.push({ c: pick, x: X[0], y: X[1], lvl: lvlA + 1 });
      }
    }
    if (!found.length) break;
    for (const f of found) liftWindow(f.c, f.x, f.y, f.lvl);
    lifts += found.length;
    if (process.env.DEBUG_6B) {
      writeFileSync(join(OUT_DIR, `debug_6b_round${round}.json`), JSON.stringify(found.map((f) => ({
        x: round1(f.x), y: round1(f.y), lvl: f.lvl, name: f.c.name ?? f.c.ref ?? f.c.key, link: !!f.c.link,
      })), null, 1));
    }
  }
  if (dbgDecisions) writeFileSync(join(OUT_DIR, 'debug_6b_decisions.json'), JSON.stringify(dbgDecisions, null, 1));
  console.log(`[6b] grade separation: ${lifts} windows lifted (${legit} shared-node junctions kept at grade, ${stuck} already-stacked left)`);
}

// ---------------------------------------------------------------- 7. clip + simplify
function clipToGrid(c) {
  const inb = (p) => p[0] >= 0.5 && p[0] <= GRID - 0.5 && p[1] >= 0.5 && p[1] <= GRID - 0.5;
  const out = [];
  let cur = null;
  const push = () => { if (cur && cur.pts.length >= 2) out.push(cur); cur = null; };
  for (let i = 0; i < c.pts.length; i++) {
    if (inb(c.pts[i])) {
      if (!cur) cur = { ...c, pts: [], ptBr: [], ptLanes: [] };
      cur.pts.push(c.pts[i]); cur.ptBr.push(c.ptBr[i]); cur.ptLanes.push(c.ptLanes[i]);
    } else push();
  }
  push();
  return out;
}

// H1321 (user rule): whole roads EXCEPT at real bridge boundaries — bridges
// are separate rows in the editor's own design (per-row Bridge flag), and
// full-length z=4 freeways made same-level deck bakes fight at interchanges
// (the I-485/I-77 scribble mess) and painted grass medians across decks.
// Split each chain into constant bridge-LEVEL runs; spans under
// BRIDGE_RUN_MIN_TILES are absorbed into the previous run (culvert noise).
const BRIDGE_RUN_MIN_TILES = 2.0;
// Ramps: longer threshold — a flyover span becomes its own BASELINE deck row
// (H1323: ground ramp pieces emit as merge rows; bridged pieces as z>=4 rows
// whose 1.275t deck width matches the merge band, so the joints line up).
const RAMP_BRIDGE_RUN_MIN_TILES = 5.0;
function splitByLevel(c) {
  if (c.link && !c.ptBr.some((v) => v > 0)) return [{ ...c, lvl: 0 }];
  const segLvl = [];
  for (let i = 1; i < c.pts.length; i++) segLvl.push(Math.max(c.ptBr[i - 1], c.ptBr[i]));
  const runs = [];
  let start = 0;
  for (let i = 1; i <= segLvl.length; i++) {
    if (i === segLvl.length || segLvl[i] !== segLvl[start]) { runs.push({ a: start, b: i, lvl: segLvl[start] }); start = i; }
  }
  const minRun = c.link ? RAMP_BRIDGE_RUN_MIN_TILES : BRIDGE_RUN_MIN_TILES;
  const merged = [];
  for (const r of runs) {
    const len = chainLen(c.pts.slice(r.a, r.b + 1));
    if (merged.length && (len < minRun || merged[merged.length - 1].lvl === r.lvl)) {
      merged[merged.length - 1].b = r.b;
      continue;
    }
    merged.push({ ...r });
  }
  if (merged.length === 1) return [{ ...c, lvl: merged[0].lvl }];
  // H1323 SEAMLESS JOINTS: cut MID-SEGMENT, not at a vertex. Both pieces
  // then share a collinear end segment (A ends along the same line B
  // starts on) so their independently-smoothed render curves meet with
  // matching tangents — vertex cuts at bends left an angular notch (user
  // screenshot: divided-highway span offset from its own road at a curve).
  const pieces = [];
  // carried into the next piece: the shared cut point + whether the next
  // piece must skip its own first vertex (when the cut landed PAST it).
  let carry = null; // { pt: [x,y], dropFirst: boolean }
  for (let m = 0; m < merged.length; m++) {
    const r = merged[m];
    let a = r.a;
    if (carry?.dropFirst) a = Math.min(a + 1, r.b);
    let pts = c.pts.slice(a, r.b + 1);
    let br = c.ptBr.slice(a, r.b + 1);
    let ln = c.ptLanes.slice(a, r.b + 1);
    if (carry) {
      pts = [carry.pt, ...pts];
      br = [br[0] ?? 0, ...br];
      ln = [ln[0] ?? 0, ...ln];
      carry = null;
    }
    if (m < merged.length - 1) {
      // Cut at the midpoint of the LONGER segment flanking the boundary
      // vertex v. Both pieces then end/start along that same segment —
      // collinear end tangents on each side of the joint.
      const v = r.b;
      const segBefore = v > 0 ? Math.hypot(c.pts[v][0] - c.pts[v - 1][0], c.pts[v][1] - c.pts[v - 1][1]) : 0;
      const segAfter = v + 1 < c.pts.length ? Math.hypot(c.pts[v + 1][0] - c.pts[v][0], c.pts[v + 1][1] - c.pts[v][1]) : 0;
      if (segAfter >= segBefore && v + 1 < c.pts.length) {
        // midpoint of (v, v+1): this piece keeps v and gains the midpoint;
        // the next piece starts [mid, v+1, ...] — v must NOT repeat there.
        const mid = [(c.pts[v][0] + c.pts[v + 1][0]) / 2, (c.pts[v][1] + c.pts[v + 1][1]) / 2];
        pts = [...pts, mid];
        br = [...br, br[br.length - 1]];
        ln = [...ln, ln[ln.length - 1]];
        carry = { pt: mid, dropFirst: true };
      } else if (v - 1 >= r.a) {
        // midpoint of (v-1, v): this piece ends at the midpoint (v dropped
        // from it); the next piece starts [mid, v, ...] as its run already
        // begins at v.
        const mid = [(c.pts[v - 1][0] + c.pts[v][0]) / 2, (c.pts[v - 1][1] + c.pts[v][1]) / 2];
        pts = [...pts.slice(0, -1), mid];
        br = br.slice(0, pts.length);
        ln = ln.slice(0, pts.length);
        carry = { pt: mid, dropFirst: false };
      } else {
        carry = { pt: pts[pts.length - 1].slice(), dropFirst: false };
      }
    }
    if (pts.length >= 2) pieces.push({ ...c, pts, ptBr: br, ptLanes: ln, lvl: r.lvl });
  }
  return pieces;
}

let finalChains = [];
for (const c of chains) {
  for (const cc of clipToGrid(c)) {
    // H1323: lane stats are computed per WHOLE road and inherited by its
    // bridge-span pieces — per-piece modal lanes let a deck come out w=12
    // beside its own w=10 road (user screenshot: 3-lane highway failing to
    // meet 3-lane highway because the median width jumped at the joint).
    const lanesVals = cc.ptLanes.filter(Boolean);
    cc.modalLanes = lanesVals.length ? lanesVals.sort((a, b) => a - b)[Math.floor(lanesVals.length / 2)] : 0;
    for (const zp of splitByLevel(cc)) finalChains.push(zp);
  }
}
finalChains = finalChains.filter((c) => chainLen(c.pts) >= MIN_ROW_TILES);
for (const c of finalChains) {
  c.bridgedFrac = c.ptBr.length ? c.ptBr.filter((v) => v > 0).length / c.ptBr.length : 0;
  c.pts = rdp(c.pts, RDP_EPS).map(([x, y]) => [round1(x), round1(y)]);
}
// H1323: same-key WIDTH RECONCILIATION across touching chains — where two
// pieces of the same corridor meet (couldn't gap-weld through a junction),
// a real lane-count change mid-corridor must not land exactly at the seam.
// The shorter chain adopts the longer one's width so the joint lines up;
// genuine lane drops persist where corridors DON'T touch end-to-end.
{
  const byKey = new Map();
  for (const c of finalChains) {
    if (c.link || c.roundabout) continue;
    if (!byKey.has(c.key)) byKey.set(c.key, []);
    byKey.get(c.key).push(c);
  }
  // Rule: a DECK never hosts a width change — its width comes from the
  // LONGEST touching same-key GROUND piece. Real lane drops then land at
  // ground-to-ground joints where the game's endpoint lane-transition
  // tapers (H283/H1207) apply, never at a bridge joint (user screenshot:
  // stripes of a w10 deck crossing a w12 ground row in an X + green wedge).
  let reconciled = 0;
  const ends = (c) => [c.pts[0], c.pts[c.pts.length - 1]];
  for (const group of byKey.values()) {
    if (group.length < 2) continue;
    for (const B of group) {
      if (!((B.lvl ?? 0) > 0)) continue; // decks only
      let donor = null;
      for (const A of group) {
        if (A === B || (A.lvl ?? 0) > 0) continue;
        let touch = false;
        for (const pa of ends(A)) for (const pb of ends(B)) {
          if (d2(pa[0], pa[1], pb[0], pb[1]) <= 2 * 2) touch = true;
        }
        if (!touch) continue;
        if (!donor || chainLen(A.pts) > chainLen(donor.pts)) donor = A;
      }
      if (donor && widthFor(donor) !== widthFor(B)) {
        B.modalLanes = donor.modalLanes;
        B.perDirLanes = donor.perDirLanes;
        B.divided = donor.divided;
        B.oneway = donor.oneway;
        reconciled++;
      }
    }
  }
  console.log(`[7b] width reconciliation: ${reconciled} deck spans adopted their ground neighbor's width`);
}
console.log(`[7] final: ${finalChains.length} chains after clip/bridge-span split (${finalChains.filter((c) => (c.lvl ?? 0) > 0).length} bridge spans)`);

// ---------------------------------------------------------------- 8. emit
// H1321: z from the row's REAL bridge level (splitByLevel) — bridges exist
// only where OSM says a bridge exists; stacked spans (layer>=2) get z=5 so
// interchange decks layer instead of fighting at the same level.
function zFor(c) {
  // (Ramps: ground pieces become overlay merge rows at emit — z here only
  // matters for their bridged deck pieces, same mapping as roads.)
  const lvl = c.lvl ?? 0;
  return lvl === 0 ? 0 : lvl >= 2 ? 5 : 4;
}

function widthFor(c) {
  if (c.link) return (c.modalLanes >= 2) ? 4 : 2;
  if (c.divided) {
    if (c.cls === 'motorway') return (c.perDirLanes >= 4) ? 12 : 10;
    return 11;
  }
  // Unpaired ONE-WAY carriageway (dual-merge tail / C-D road): its lanes=
  // value is per-direction. Style as a plain road of that many lanes total —
  // NEVER w=10/12, which would draw a phantom divided highway with median
  // over what is physically a single carriageway.
  if (c.oneway && !c.roundabout) {
    const l = c.modalLanes || 2;
    return l >= 4 ? 8 : l === 3 ? 6 : l === 2 ? 5 : 4;
  }
  const total = c.modalLanes;
  if (c.cls === 'motorway') return 10;
  if (total >= 5) return 8;
  if (total >= 3) return 6;
  if (total === 2) return c.cls === 'tertiary' ? 4 : 5;
  return { trunk: 8, primary: 6, secondary: 5, tertiary: 4 }[c.cls] ?? 5;
}

let rampIdx = 0;
function nameFor(c) {
  if (c.link) {
    rampIdx++;
    const dest = c.destination ? ` to ${c.destination.split(';')[0]}` : (c.ref ? ` ${c.ref}` : '');
    return `Ramp ${rampIdx}${dest}`.slice(0, 40);
  }
  return c.ref && c.cls === 'motorway' ? c.ref : (c.name ?? c.ref ?? `${c.cls} road`);
}

const rows = [];
const props = [];
const nameSeen = new Map();
for (const c of finalChains) {
  const w = widthFor(c);
  const maj = c.cls === 'motorway' || c.cls === 'trunk' ? 1 : 0;
  let name = nameFor(c);
  const n = nameSeen.get(name) ?? 0;
  nameSeen.set(name, n + 1);
  if (n > 0) name = `${name} (${n + 1})`;
  const flat = [];
  for (const [x, y] of c.pts) flat.push(x, y);
  rows.push([w, maj, name, zFor(c), ...flat]);
  const p = { class: c.cls + (c.link ? '_link' : '') };
  if (c.oneway) p.oneway = true;
  if (c.maxspeed) p.maxspeed = c.maxspeed;
  if (c.modalLanes) p.lanes = c.modalLanes;
  if (c.divided) p.divided = true;
  if (c.bridgedFrac > 0.02) p.bridgedFrac = +c.bridgedFrac.toFixed(2);
  props.push(p);
}

// intersections: cluster control nodes within 8 tiles; signal beats stop beats yield
const ctlNodes = rawNodes
  .filter((n) => n.type === 'node')
  .map((n) => { const [x, y] = proj(n.lat, n.lon); return { x, y, kind: n.tags.highway }; })
  .filter((n) => n.x > 0 && n.x < GRID && n.y > 0 && n.y < GRID);

const CLUSTER_R = 8;
const cells = new Map();
const cellKey = (x, y) => `${Math.round(x / CLUSTER_R)},${Math.round(y / CLUSTER_R)}`;
const clusters = [];
for (const n of ctlNodes) {
  let placed = false;
  const cx = Math.round(n.x / CLUSTER_R), cy = Math.round(n.y / CLUSTER_R);
  outer: for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
    const list = cells.get(`${cx + dx},${cy + dy}`);
    if (!list) continue;
    for (const cl of list) {
      if (d2(n.x, n.y, cl.x, cl.y) <= CLUSTER_R * CLUSTER_R) {
        cl.sx += n.x; cl.sy += n.y; cl.n++;
        cl.x = cl.sx / cl.n; cl.y = cl.sy / cl.n;
        cl.kinds.add(n.kind);
        placed = true;
        break outer;
      }
    }
  }
  if (!placed) {
    const cl = { x: n.x, y: n.y, sx: n.x, sy: n.y, n: 1, kinds: new Set([n.kind]) };
    clusters.push(cl);
    const k = cellKey(n.x, n.y);
    if (!cells.has(k)) cells.set(k, []);
    cells.get(k).push(cl);
  }
}
const isectRows = clusters.map((cl) => {
  const control = cl.kinds.has('traffic_signals') ? 4 : cl.kinds.has('stop') ? 2 : 1;
  return ['isect', control, 1, 1, 1, 1, 0, round1(cl.x), round1(cl.y)];
});

const stat = (label, pred) => {
  const rs = finalChains.filter(pred);
  return { label, rows: rs.length, verts: rs.reduce((s, c) => s + c.pts.length, 0) };
};
const stats = [
  stat('motorway', (c) => c.cls === 'motorway' && !c.link),
  stat('trunk', (c) => c.cls === 'trunk' && !c.link),
  stat('primary', (c) => c.cls === 'primary' && !c.link),
  stat('secondary', (c) => c.cls === 'secondary' && !c.link),
  stat('tertiary', (c) => c.cls === 'tertiary' && !c.link),
  stat('ramps (_link)', (c) => c.link),
];
console.table(stats);
console.log(`rows total: ${rows.length}, verts total: ${rows.reduce((s, r) => s + (r.length - 4) / 2, 0)}`);
console.log(`isect rows: ${isectRows.length} (signals ${isectRows.filter((r) => r[1] === 4).length}, stops ${isectRows.filter((r) => r[1] === 2).length}, yields ${isectRows.filter((r) => r[1] === 1).length})`);

writeFileSync(join(OUT_DIR, 'charlotte_rows.json'), JSON.stringify({
  meta: {
    attribution: 'Road network data © OpenStreetMap contributors, ODbL 1.0',
    generated: 'tools/osm/build.mjs',
    scaleDiv: SCALE_DIV, mPerTile: M_PER_TILE, center: [LAT0, LON0], grid: GRID,
    stats,
  },
  rows, props, intersections: isectRows,
}));
console.log('wrote fixtures/osm/charlotte_rows.json');

// ---------------------------------------------------------------- SVG contact sheets
const CLS_STYLE = {
  motorway: { color: '#c46030', w: 5 },
  trunk: { color: '#c88a2e', w: 4 },
  primary: { color: '#b0a032', w: 3 },
  secondary: { color: '#7a8a4a', w: 2.2 },
  tertiary: { color: '#8a97a5', w: 1.4 },
};
function svgFor(viewBox, scale = 1) {
  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox.join(' ')}" width="1600" height="1600">`);
  parts.push(`<rect x="${viewBox[0]}" y="${viewBox[1]}" width="${viewBox[2]}" height="${viewBox[3]}" fill="#10130f"/>`);
  const order = ['tertiary', 'secondary', 'primary', 'trunk', 'motorway'];
  for (const pass of ['ground', 'bridge']) {
    for (const cls of order) {
      for (let i = 0; i < finalChains.length; i++) {
        const c = finalChains[i];
        if (c.cls !== cls) continue;
        if ((pass === 'bridge') !== (rows[i][3] >= 2)) continue;
        const st = CLS_STYLE[cls];
        const d = 'M' + c.pts.map(([x, y]) => `${x} ${y}`).join('L');
        const sw = (c.link ? st.w * 0.5 : st.w) * scale;
        const col = pass === 'bridge' ? '#e0e6ee' : st.color;
        parts.push(`<path d="${d}" fill="none" stroke="${col}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" opacity="${c.link ? 0.8 : 0.95}"/>`);
      }
    }
  }
  for (const r of isectRows) {
    const col = r[1] === 4 ? '#4fd070' : r[1] === 2 ? '#e05050' : '#e0c050';
    parts.push(`<circle cx="${r[7]}" cy="${r[8]}" r="${1.2 * scale}" fill="${col}"/>`);
  }
  parts.push('</svg>');
  return parts.join('\n');
}
writeFileSync(join(PREV_DIR, 'full.svg'), svgFor([0, 0, GRID, GRID], 1));
const [ux, uy] = proj(35.2271, -80.8431);
writeFileSync(join(PREV_DIR, 'uptown.svg'), svgFor([ux - 70, uy - 70, 140, 140], 0.35));
const [hx, hy] = proj(35.3345, -80.7355);
writeFileSync(join(PREV_DIR, 'harris485.svg'), svgFor([hx - 106, hy - 43, 90, 90], 0.18));
console.log('wrote preview SVGs (full, uptown, harris485)');
