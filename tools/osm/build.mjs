// OSM-A: build Driver City candidate road rows from cached Overpass data.
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
// Pipeline (each stage prints counts):
//   1. classify + project    equirect lat/lon -> tile grid at 1:6 layout scale
//   2. junction split        ways split at shared nodes (real intersections)
//   3. weld                  degree-2 same-road chains rejoined (per-pt z/lanes)
//   4. dual merge            paired one-way carriageways -> one divided line
//   5. stub weld             median stubs left by consumed carriageways
//   6. ramp snap + split     _link tips onto highways; highways split there so
//                            traffic can hop at gore points (endpoint-only AI)
//   7. z-runs + clip + RDP   per-section bridges from bridge=/layer=; grid clip
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
const SPLIT_MIN_SPACING = 4.0; // tiles between split points on a highway
const STUB_MAX_TILES = 3.0;
const RDP_EPS = 0.4;           // tiles
const MIN_ROW_TILES = 1.2;     // drop crumbs shorter than this
const Z_RUN_MIN_TILES = 1.5;

// ---------------------------------------------------------------- helpers
const d2 = (ax, ay, bx, by) => (ax - bx) ** 2 + (ay - by) ** 2;

function nearestOnSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return { x: ax + dx * t, y: ay + dy * t, t };
}

// nearest point on chain polyline; returns {d2, x, y, segIdx, arc}
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

function arcPositions(pts) {
  const a = [0];
  for (let i = 1; i < pts.length; i++) a.push(a[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  return a;
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

// Projection centered on the I-485 centroid so the beltway centers on the grid.
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
  const z = (w.tags.bridge && w.tags.bridge !== 'no') || layer > 0 ? 4 : 0;
  const lanes = parseInt(w.tags.lanes ?? '', 10) || 0;
  const ref = normRef(w.tags.ref);
  const name = w.tags.name ?? null;
  const maxspeed = /(\d+)\s*mph/.exec(w.tags.maxspeed ?? '')?.[1];

  ways.push({
    id: w.id, cls, link, roundabout, oneway, z, lanes,
    ref, name, key: `${cls}|${link ? 'L' : ''}|${ref ?? name ?? ''}`,
    maxspeed: maxspeed ? parseInt(maxspeed, 10) : 0,
    destination: w.tags.destination ?? null,
    turnLanes: w.tags['turn:lanes'] ?? null,
    nodes, pts,
  });
}
console.log(`[1] kept ${ways.length}/${rawWays.length} ways; projection center ${LAT0.toFixed(4)},${LON0.toFixed(4)}`);

// ---------------------------------------------------------------- 2. junction split
const nodeUse = new Map();
for (const w of ways) for (const id of w.nodes) nodeUse.set(id, (nodeUse.get(id) ?? 0) + 1);

let segs = [];
for (const w of ways) {
  let start = 0;
  for (let i = 1; i < w.nodes.length; i++) {
    const isEnd = i === w.nodes.length - 1;
    if (isEnd || nodeUse.get(w.nodes[i]) >= 2) {
      segs.push({
        ...w,
        nodes: w.nodes.slice(start, i + 1),
        pts: w.pts.slice(start, i + 1),
      });
      start = i;
    }
  }
}
console.log(`[2] junction split: ${segs.length} segments`);

// ---------------------------------------------------------------- 3. weld chains
// Per-point z/lanes ride along so bridges + turn pockets don't fragment chains.
function makeChain(seg) {
  return {
    cls: seg.cls, link: seg.link, roundabout: seg.roundabout, oneway: seg.oneway,
    key: seg.key, ref: seg.ref, name: seg.name,
    maxspeed: seg.maxspeed, destination: seg.destination,
    pts: seg.pts.slice(),
    endNodes: [seg.nodes[0], seg.nodes[seg.nodes.length - 1]],
    ptZ: seg.pts.map(() => seg.z),
    ptLanes: seg.pts.map(() => seg.lanes),
    srcIds: [seg.id],
  };
}

function weld(chains, { relaxed = false, maxLen = Infinity } = {}) {
  const endMap = new Map(); // nodeId -> [{chain, end}]
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
  let joined = 0;
  let progress = true;
  while (progress) {
    progress = false;
    for (const [nodeId, list] of endMap) {
      const live = list.filter((e) => !dead.has(e.c));
      if (live.length !== 2) continue;
      const [a, b] = live;
      if (a.c === b.c) continue;
      const compat = relaxed
        ? a.c.cls === b.c.cls && a.c.link === b.c.link && a.c.oneway === b.c.oneway &&
          Math.min(chainLen(a.c.pts), chainLen(b.c.pts)) < maxLen
        : a.c.key === b.c.key && a.c.oneway === b.c.oneway && a.c.roundabout === b.c.roundabout;
      if (!compat) continue;
      // orient: a ends at nodeId, b starts at nodeId
      const A = a.c, B = b.c;
      const flip = (c) => {
        c.pts.reverse(); c.ptZ.reverse(); c.ptLanes.reverse(); c.endNodes.reverse();
      };
      if (a.end === 0) flip(A);
      if (b.end === 1) flip(B);
      A.pts = A.pts.concat(B.pts.slice(1));
      A.ptZ = A.ptZ.concat(B.ptZ.slice(1));
      A.ptLanes = A.ptLanes.concat(B.ptLanes.slice(1));
      A.endNodes = [A.endNodes[0], B.endNodes[1]];
      A.srcIds = A.srcIds.concat(B.srcIds);
      if (!A.name && B.name) { A.name = B.name; }
      if (!A.maxspeed && B.maxspeed) A.maxspeed = B.maxspeed;
      dead.add(B);
      reg(A);
      joined++;
      progress = true;
    }
  }
  return { chains: chains.filter((c) => !dead.has(c)), joined };
}

let { chains } = weld(segs.map(makeChain));
console.log(`[3] welded: ${chains.length} chains`);

// ---------------------------------------------------------------- 4. dual-carriageway merge
// Pair one-way carriageway chains per (ref|name, cls); collapse to midline.
const groups = new Map();
for (const c of chains) {
  if (!c.oneway || c.link || c.roundabout || c.cls === 'tertiary') continue;
  if (!(c.ref ?? c.name)) continue; // unnamed one-ways: leave as-is
  const k = `${c.cls}|${c.ref ?? c.name}`;
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(c);
}

const consumed = new Set();
const mergedChains = [];
let pairStats = [];
for (const [k, group] of groups) {
  if (group.length < 2) continue;
  const sepMax = (SEP_MAX_M[group[0].cls] ?? 40) / M_PER_TILE;
  group.sort((a, b) => chainLen(b.pts) - chainLen(a.pts));
  for (const A of group) {
    if (consumed.has(A)) continue;
    const partners = group.filter((B) => B !== A && !consumed.has(B));
    if (!partners.length) continue;
    const mid = [];
    const midZ = [];
    const midLanes = [];
    const seps = [];
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
        seps.push(Math.sqrt(best.d2));
        mid.push([(px + best.x) / 2, (py + best.y) / 2]);
        const bz = bestChain.ptZ[best.segIdx] || bestChain.ptZ[best.segIdx + 1] || 0;
        midZ.push(Math.max(A.ptZ[i], bz));
        midLanes.push(Math.max(A.ptLanes[i], bestChain.ptLanes[best.segIdx] ?? 0));
      } else {
        mid.push([px, py]);
        midZ.push(A.ptZ[i]);
        midLanes.push(A.ptLanes[i]);
      }
    }
    const frac = matched / A.pts.length;
    if (frac < 0.5) continue; // no real partner along this chain
    consumed.add(A);
    // consume partners substantially covered by A
    for (const B of partners) {
      let hits = 0;
      const step = Math.max(1, Math.floor(B.pts.length / 40));
      let sampled = 0;
      for (let i = 0; i < B.pts.length; i += step) {
        sampled++;
        const n = nearestOnChain(B.pts[i][0], B.pts[i][1], A);
        if (n && n.d2 <= sepMax * sepMax) hits++;
      }
      if (hits / sampled > 0.6) consumed.add(B);
    }
    const m = {
      cls: A.cls, link: false, roundabout: false, oneway: false, divided: true,
      key: k, ref: A.ref, name: A.name, maxspeed: A.maxspeed, destination: null,
      pts: mid, ptZ: midZ, ptLanes: midLanes,
      endNodes: [null, null], srcIds: A.srcIds,
      perDirLanes: midLanes.filter(Boolean).sort((x, y) => x - y)[Math.floor(midLanes.filter(Boolean).length / 2)] ?? 0,
    };
    mergedChains.push(m);
    pairStats.push({ key: k, lenTiles: chainLen(mid), sepMeanM: seps.length ? (seps.reduce((s, v) => s + v, 0) / seps.length) * M_PER_TILE : 0 });
  }
}
chains = chains.filter((c) => !consumed.has(c)).concat(mergedChains);
console.log(`[4] dual merge: ${mergedChains.length} merged carriageway chains (${consumed.size} consumed); ${chains.length} total`);

// ---------------------------------------------------------------- 5. stub weld (relaxed)
({ chains } = weld(chains, { relaxed: true, maxLen: STUB_MAX_TILES }));
console.log(`[5] stub weld: ${chains.length} chains`);

// ---------------------------------------------------------------- 6. ramp snap + split
// Snap each _link chain tip onto the nearest highway-ish chain (within 3 tiles),
// and record a split there so traffic can hop ramp<->highway at endpoints.
// Any non-ramp road is a snap target — service-interchange ramps terminate at
// secondary/tertiary arterials as often as at highways.
const snapTargets = chains.filter((c) => !c.link);
for (const t of snapTargets) t.splitArcs = [];
let snapped = 0, unsnapped = 0;
for (const c of chains) {
  if (!c.link) continue;
  for (const end of [0, 1]) {
    const tip = end === 0 ? c.pts[0] : c.pts[c.pts.length - 1];
    let best = null, bestT = null;
    for (const t of snapTargets) {
      const n = nearestOnChain(tip[0], tip[1], t);
      if (n && (!best || n.d2 < best.d2)) { best = n; bestT = t; }
    }
    if (best && best.d2 <= RAMP_SNAP_TILES * RAMP_SNAP_TILES) {
      const p = [best.x, best.y];
      if (end === 0) c.pts[0] = p; else c.pts[c.pts.length - 1] = p;
      const arcs = arcPositions(bestT.pts);
      bestT.splitArcs.push(arcs[best.segIdx] + Math.hypot(best.x - bestT.pts[best.segIdx][0], best.y - bestT.pts[best.segIdx][1]));
      snapped++;
    } else unsnapped++;
  }
}
console.log(`[6] ramp snap: ${snapped} tips snapped, ${unsnapped} free`);

// ---------------------------------------------------------------- 7. z-runs, splits, clip, simplify
function splitChainAtArcs(c, splitArcs) {
  const arcs = arcPositions(c.pts);
  const total = arcs[arcs.length - 1];
  const cuts = [...new Set(splitArcs.map((a) => Math.max(0, Math.min(total, a))))].sort((a, b) => a - b)
    .filter((a, i, all) => a > SPLIT_MIN_SPACING && total - a > SPLIT_MIN_SPACING && (i === 0 || a - all[i - 1] > SPLIT_MIN_SPACING));
  if (!cuts.length) return [c];
  const out = [];
  let cur = [c.pts[0]], curZ = [c.ptZ[0]], curLanes = [c.ptLanes[0]];
  let ci = 0;
  for (let i = 1; i < c.pts.length; i++) {
    let segStart = arcs[i - 1], segEnd = arcs[i];
    while (ci < cuts.length && cuts[ci] <= segEnd) {
      const t = (cuts[ci] - segStart) / Math.max(1e-9, segEnd - segStart);
      const px = c.pts[i - 1][0] + (c.pts[i][0] - c.pts[i - 1][0]) * t;
      const py = c.pts[i - 1][1] + (c.pts[i][1] - c.pts[i - 1][1]) * t;
      cur.push([px, py]); curZ.push(c.ptZ[i]); curLanes.push(c.ptLanes[i]);
      out.push({ ...c, pts: cur, ptZ: curZ, ptLanes: curLanes });
      cur = [[px, py]]; curZ = [c.ptZ[i]]; curLanes = [c.ptLanes[i]];
      ci++;
    }
    cur.push(c.pts[i]); curZ.push(c.ptZ[i]); curLanes.push(c.ptLanes[i]);
  }
  out.push({ ...c, pts: cur, ptZ: curZ, ptLanes: curLanes });
  return out;
}

function splitByZ(c) {
  // segment z = max of endpoint z; split into constant runs, absorbing tiny ones
  const segZ = [];
  for (let i = 1; i < c.pts.length; i++) segZ.push(Math.max(c.ptZ[i - 1], c.ptZ[i]));
  const runs = [];
  let start = 0;
  for (let i = 1; i <= segZ.length; i++) {
    if (i === segZ.length || segZ[i] !== segZ[start]) { runs.push({ a: start, b: i, z: segZ[start] }); start = i; }
  }
  // absorb short runs into the previous
  const arcs = arcPositions(c.pts);
  const merged = [];
  for (const r of runs) {
    const len = arcs[r.b] - arcs[r.a];
    if (merged.length && len < Z_RUN_MIN_TILES) { merged[merged.length - 1].b = r.b; continue; }
    if (merged.length && merged[merged.length - 1].z === r.z) { merged[merged.length - 1].b = r.b; continue; }
    merged.push({ ...r });
  }
  return merged.map((r) => ({ ...c, pts: c.pts.slice(r.a, r.b + 1), ptZ: c.ptZ.slice(r.a, r.b + 1), ptLanes: c.ptLanes.slice(r.a, r.b + 1), z: r.z }));
}

function clipToGrid(c) {
  const inb = (p) => p[0] >= 0.5 && p[0] <= GRID - 0.5 && p[1] >= 0.5 && p[1] <= GRID - 0.5;
  const out = [];
  let cur = null;
  const push = () => { if (cur && cur.pts.length >= 2) out.push(cur); cur = null; };
  for (let i = 0; i < c.pts.length; i++) {
    if (inb(c.pts[i])) {
      if (!cur) cur = { ...c, pts: [], ptZ: [], ptLanes: [] };
      cur.pts.push(c.pts[i]); cur.ptZ.push(c.ptZ[i]); cur.ptLanes.push(c.ptLanes[i]);
    } else push();
  }
  push();
  return out;
}

let finalChains = [];
for (const c of chains) {
  const pieces = c.splitArcs?.length ? splitChainAtArcs(c, c.splitArcs) : [c];
  for (const p of pieces) for (const zp of splitByZ(p)) for (const cp of clipToGrid(zp)) finalChains.push(cp);
}
finalChains = finalChains.filter((c) => chainLen(c.pts) >= MIN_ROW_TILES);
for (const c of finalChains) {
  const keptLanes = [];
  // simplify but keep modal lanes computed BEFORE point reduction
  const lanesVals = c.ptLanes.filter(Boolean);
  c.modalLanes = lanesVals.length ? lanesVals.sort((a, b) => a - b)[Math.floor(lanesVals.length / 2)] : 0;
  c.pts = rdp(c.pts, RDP_EPS).map(([x, y]) => [round1(x), round1(y)]);
}
console.log(`[7] final: ${finalChains.length} chains after split/z/clip/simplify`);

// ---------------------------------------------------------------- 8. emit
function widthFor(c) {
  if (c.link) return (c.modalLanes >= 2) ? 4 : 2;
  if (c.divided) {
    if (c.cls === 'motorway') return (c.perDirLanes >= 4) ? 12 : 10;
    return 11; // divided arterial: asphalt median
  }
  const total = c.modalLanes;
  if (c.cls === 'motorway') return 10; // unpaired motorway remnant
  if (total >= 5) return 8;
  if (total >= 3) return 6;
  if (total === 2) return c.cls === 'tertiary' ? 4 : 5;
  // untagged defaults by class
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
  rows.push([w, maj, name, c.z ?? 0, ...flat]);
  const p = { class: c.cls + (c.link ? '_link' : '') };
  if (c.oneway) p.oneway = true;
  if (c.maxspeed) p.maxspeed = c.maxspeed;
  if (c.modalLanes) p.lanes = c.modalLanes;
  if (c.divided) p.divided = true;
  props.push(p);
}

// intersections: cluster control nodes within 8 tiles; signal beats stop beats yield
const ctlNodes = rawNodes
  .filter((n) => n.type === 'node')
  .map((n) => {
    const [x, y] = proj(n.lat, n.lon);
    const kind = n.tags.highway;
    return { x, y, kind };
  })
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

// stats
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
    stats, pairStats: pairStats.slice(0, 50),
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
        if ((c.link ? c.cls : c.cls) !== cls) continue;
        const z = rows[i][3];
        if ((pass === 'bridge') !== (z >= 2)) continue;
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
// uptown crop (downtown = projection of 35.2271,-80.8431)
const [ux, uy] = proj(35.2271, -80.8431);
writeFileSync(join(PREV_DIR, 'uptown.svg'), svgFor([ux - 150, uy - 150, 300, 300], 0.35));
// I-485 / W.T. Harris interchange (the user's screenshot)
const [hx, hy] = proj(35.3345, -80.7355);
writeFileSync(join(PREV_DIR, 'harris485.svg'), svgFor([hx - 60, hy - 60, 120, 120], 0.18));
console.log('wrote preview SVGs (full, uptown, harris485)');
