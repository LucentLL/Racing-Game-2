// OSM-A: mine the raw Charlotte data for real-road engineering numbers that
// should inform editor presets (ramp radii/lengths, accel-lane lengths, median
// widths, signal spacing, lane counts, turn-lane patterns, bridge spans).
//
//   node tools/osm/analyze.mjs
//
// All stats are computed in REAL meters (no layout compression), then reported
// alongside their game conversions: true-scale tiles (/2.8687) and 1:6 layout
// tiles (/17.212). Writes fixtures/osm/findings.json and prints a summary.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RAW = join(ROOT, 'fixtures', 'osm', 'raw');
const METERS_PER_TILE = 3.6576 / 1.275;

const els = JSON.parse(readFileSync(join(RAW, 'charlotte_ways.json'), 'utf8')).elements;
const ctl = JSON.parse(readFileSync(join(RAW, 'charlotte_nodes.json'), 'utf8')).elements;

const LAT0 = 35.2271, LON0 = -80.8431;
const M_LAT = 111132, M_LON = 111320 * Math.cos((LAT0 * Math.PI) / 180);
const pm = (lat, lon) => [(lon - LON0) * M_LON, -(lat - LAT0) * M_LAT]; // meters

const CLASSES = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary'];
const ways = [];
for (const w of els) {
  if (w.type !== 'way' || !w.tags?.highway || !w.geometry) continue;
  const hw = w.tags.highway;
  const link = hw.endsWith('_link');
  const cls = link ? hw.slice(0, -5) : hw;
  if (!CLASSES.includes(cls)) continue;
  ways.push({
    id: w.id, cls, link, tags: w.tags, nodes: w.nodes,
    pts: w.geometry.map((g) => pm(g.lat, g.lon)),
  });
}

const len = (pts) => { let L = 0; for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); return L; };
const pct = (arr, p) => { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };
const stats5 = (arr) => ({ n: arr.length, p10: Math.round(pct(arr, 10)), p50: Math.round(pct(arr, 50)), p90: Math.round(pct(arr, 90)) });

// ------------------------------------------------ ramp chains (weld links)
const nodeUse = new Map();
for (const w of ways) for (const id of w.nodes) nodeUse.set(id, (nodeUse.get(id) ?? 0) + 1);
const linkWays = ways.filter((w) => w.link);
const endMap = new Map();
for (const w of linkWays) {
  for (const end of [0, 1]) {
    const id = w.nodes[end === 0 ? 0 : w.nodes.length - 1];
    if (!endMap.has(id)) endMap.set(id, []);
    endMap.get(id).push({ w, end });
  }
}
const usedIn = new Map();
const rampChains = [];
for (const seed of linkWays) {
  if (usedIn.has(seed.id)) continue;
  let chainPts = seed.pts.slice();
  let chain = [seed.id];
  usedIn.set(seed.id, true);
  // extend forward/backward through degree-2 link joins
  for (const dir of [1, 0]) {
    let guard = 0;
    while (guard++ < 100) {
      const endNode = dir === 1 ? seed.nodes[seed.nodes.length - 1] : seed.nodes[0];
      const hereId = dir === 1
        ? (chainPts.length ? null : null)
        : null;
      // find continuation at current chain tip
      const tipNodeId = dir === 1 ? chainTipNode(chain, 1) : chainTipNode(chain, 0);
      const conts = (endMap.get(tipNodeId) ?? []).filter((e) => !usedIn.has(e.w.id));
      if (conts.length !== 1) break;
      const nx = conts[0].w;
      usedIn.set(nx.id, true);
      let np = nx.pts.slice();
      const nStart = nx.nodes[0], nEnd = nx.nodes[nx.nodes.length - 1];
      if (dir === 1) {
        if (nEnd === tipNodeId) np.reverse();
        chainPts = chainPts.concat(np.slice(1));
        chain.push(nx.id);
      } else {
        if (nStart === tipNodeId) np.reverse();
        chainPts = np.concat(chainPts.slice(1));
        chain.unshift(nx.id);
      }
    }
  }
  function chainTipNode(chainIds, end) {
    const wy = ways.find((x) => x.id === chainIds[end === 1 ? chainIds.length - 1 : 0]);
    // orientation is approximate; use geometric tip matching against node map
    return end === 1 ? wy.nodes[wy.nodes.length - 1] : wy.nodes[0];
  }
  rampChains.push({ pts: chainPts, ids: chain });
}

// resample + curvature
function resample(pts, step) {
  const out = [pts[0]];
  let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    let [ax, ay] = out[out.length - 1].slice ? out[out.length - 1] : pts[i - 1];
    let bx = pts[i][0], by = pts[i][1];
    let d = Math.hypot(bx - ax, by - ay);
    while (d >= step) {
      const t = step / d;
      const nx = ax + (bx - ax) * t, ny = ay + (by - ay) * t;
      out.push([nx, ny]);
      ax = nx; ay = ny;
      d = Math.hypot(bx - ax, by - ay);
    }
  }
  return out;
}
function circumradius(a, b, c) {
  const A = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const B = Math.hypot(c[0] - b[0], c[1] - b[1]);
  const C = Math.hypot(c[0] - a[0], c[1] - a[1]);
  const s = (A + B + C) / 2;
  const area = Math.sqrt(Math.max(0, s * (s - A) * (s - B) * (s - C)));
  return area < 1e-6 ? 1e9 : (A * B * C) / (4 * area);
}
function headingChange(pts) {
  let total = 0;
  for (let i = 2; i < pts.length; i++) {
    const h1 = Math.atan2(pts[i - 1][1] - pts[i - 2][1], pts[i - 1][0] - pts[i - 2][0]);
    const h2 = Math.atan2(pts[i][1] - pts[i - 1][1], pts[i][0] - pts[i - 1][0]);
    let d = h2 - h1;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    total += d;
  }
  return (total * 180) / Math.PI;
}

const rampLens = [], loopRadii = [], dirRadii = [], loopLens = [];
let loops = 0;
for (const rc of rampChains) {
  const L = len(rc.pts);
  if (L < 30) continue;
  rampLens.push(L);
  const rs = resample(rc.pts, 12);
  if (rs.length < 5) continue;
  const radii = [];
  for (let i = 2; i < rs.length; i++) radii.push(circumradius(rs[i - 2], rs[i - 1], rs[i]));
  const minR = pct(radii, 5);
  const dh = Math.abs(headingChange(rs));
  if (dh > 200) { loops++; loopRadii.push(minR); loopLens.push(L); }
  else dirRadii.push(minR);
}

// ------------------------------------------------ aux (accel/decel) lane spans
// motorway ways whose lanes exceed both same-ref neighbors' lanes = auxiliary span
const mw = ways.filter((w) => w.cls === 'motorway' && !w.link && w.tags.lanes);
const byNode = new Map();
for (const w of mw) {
  for (const id of [w.nodes[0], w.nodes[w.nodes.length - 1]]) {
    if (!byNode.has(id)) byNode.set(id, []);
    byNode.get(id).push(w);
  }
}
const auxLens = [];
for (const w of mw) {
  const lanes = parseInt(w.tags.lanes, 10);
  const nbrLanes = [];
  for (const id of [w.nodes[0], w.nodes[w.nodes.length - 1]]) {
    for (const o of byNode.get(id) ?? []) {
      if (o !== w && (o.tags.ref ?? '') === (w.tags.ref ?? '')) nbrLanes.push(parseInt(o.tags.lanes, 10));
    }
  }
  if (nbrLanes.length >= 2 && nbrLanes.every((n) => n < lanes)) {
    const L = len(w.pts);
    if (L > 80 && L < 1500) auxLens.push(L);
  }
}

// ------------------------------------------------ dual-carriageway separation
const sepByCls = { motorway: [], trunk: [], primary: [], secondary: [] };
const oneways = ways.filter((w) => !w.link && (w.tags.oneway === 'yes' || w.cls === 'motorway') && (w.tags.ref || w.tags.name) && sepByCls[w.cls]);
const groupsD = new Map();
for (const w of oneways) {
  const k = `${w.cls}|${w.tags.ref ?? w.tags.name}`;
  if (!groupsD.has(k)) groupsD.set(k, []);
  groupsD.get(k).push(w);
}
for (const [k, g] of groupsD) {
  if (g.length < 2) continue;
  const cls = g[0].cls;
  const cap = cls === 'motorway' ? 95 : 45;
  for (const A of g) {
    const rs = resample(A.pts, 60);
    for (const p of rs) {
      let best = Infinity;
      for (const B of g) {
        if (B === A) continue;
        for (let i = 1; i < B.pts.length; i++) {
          const [ax, ay] = B.pts[i - 1], [bx, by] = B.pts[i];
          const dx = bx - ax, dy = by - ay;
          const l2 = dx * dx + dy * dy;
          let t = l2 ? ((p[0] - ax) * dx + (p[1] - ay) * dy) / l2 : 0;
          t = Math.max(0, Math.min(1, t));
          const d = Math.hypot(p[0] - (ax + dx * t), p[1] - (ay + dy * t));
          if (d < best) best = d;
        }
      }
      if (best < cap) sepByCls[cls].push(best);
    }
  }
}

// ------------------------------------------------ signal spacing (nearest-neighbor)
const signals = ctl.filter((n) => n.tags?.highway === 'traffic_signals').map((n) => pm(n.lat, n.lon));
// cluster first (dual-carriageway signal groups), 140 m
const clusters = [];
for (const s of signals) {
  let hit = null;
  for (const c of clusters) if (Math.hypot(c.x - s[0], c.y - s[1]) < 140) { hit = c; break; }
  if (hit) { hit.sx += s[0]; hit.sy += s[1]; hit.n++; hit.x = hit.sx / hit.n; hit.y = hit.sy / hit.n; }
  else clusters.push({ x: s[0], y: s[1], sx: s[0], sy: s[1], n: 1 });
}
const nnDist = [];
for (const c of clusters) {
  let best = Infinity;
  for (const o of clusters) if (o !== c) best = Math.min(best, Math.hypot(c.x - o.x, c.y - o.y));
  if (best < 5000) nnDist.push(best);
}
const downtown = clusters.filter((c) => Math.hypot(c.x, c.y) < 1600);
const nnDowntown = [];
for (const c of downtown) {
  let best = Infinity;
  for (const o of downtown) if (o !== c) best = Math.min(best, Math.hypot(c.x - o.x, c.y - o.y));
  if (best < 3000) nnDowntown.push(best);
}

// ------------------------------------------------ lanes / maxspeed / turn:lanes coverage
const laneDist = {};
const spdDist = {};
let turnPatterns = new Map();
const coverage = {};
for (const cls of CLASSES) {
  const group = ways.filter((w) => w.cls === cls && !w.link);
  const withLanes = group.filter((w) => w.tags.lanes);
  const withSpd = group.filter((w) => /mph/.test(w.tags.maxspeed ?? ''));
  coverage[cls] = {
    ways: group.length,
    lanesTagged: Math.round((100 * withLanes.length) / Math.max(1, group.length)),
    maxspeedTagged: Math.round((100 * withSpd.length) / Math.max(1, group.length)),
  };
  const ld = {};
  for (const w of withLanes) { const l = w.tags.lanes; ld[l] = (ld[l] ?? 0) + 1; }
  laneDist[cls] = ld;
  const sd = {};
  for (const w of withSpd) { const s = /(\d+)\s*mph/.exec(w.tags.maxspeed)[1]; sd[s] = (sd[s] ?? 0) + 1; }
  spdDist[cls] = sd;
}
for (const w of ways) {
  const t = w.tags['turn:lanes'];
  if (t) turnPatterns.set(t, (turnPatterns.get(t) ?? 0) + 1);
}
const topTurns = [...turnPatterns.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);

// ------------------------------------------------ bridge spans
const bridgeLens = {};
for (const cls of CLASSES) {
  const arr = ways.filter((w) => w.cls === cls && w.tags.bridge && w.tags.bridge !== 'no').map((w) => len(w.pts));
  if (arr.length) bridgeLens[cls] = stats5(arr);
}

// ------------------------------------------------ report
const conv = (m) => ({ m: Math.round(m), tilesTrue: +(m / METERS_PER_TILE).toFixed(1), tiles1to6: +(m / (METERS_PER_TILE * 6)).toFixed(1) });
const findings = {
  attribution: 'Derived from OpenStreetMap data © OpenStreetMap contributors (ODbL)',
  ramps: {
    count: rampLens.length,
    loops,
    lengthM: stats5(rampLens),
    loopLengthM: stats5(loopLens),
    loopMinRadiusM: stats5(loopRadii),
    directionalMinRadiusM: stats5(dirRadii),
    loopRadiusP50: conv(pct(loopRadii, 50)),
    rampLenP50: conv(pct(rampLens, 50)),
  },
  auxLanes: { count: auxLens.length, lengthM: stats5(auxLens), p50: conv(pct(auxLens, 50)) },
  dualSeparationM: Object.fromEntries(Object.entries(sepByCls).filter(([, v]) => v.length).map(([k, v]) => [k, stats5(v)])),
  signalSpacing: {
    clusters: clusters.length,
    nnAllM: stats5(nnDist),
    nnDowntownM: stats5(nnDowntown),
    downtownP50: conv(pct(nnDowntown, 50)),
    cityP50: conv(pct(nnDist, 50)),
  },
  coverage, laneDist, spdDist,
  topTurnLanePatterns: topTurns,
  bridgeSpanM: bridgeLens,
};
writeFileSync(join(ROOT, 'fixtures', 'osm', 'findings.json'), JSON.stringify(findings, null, 2));
console.log(JSON.stringify(findings, null, 1).slice(0, 6000));
console.log('\nwrote fixtures/osm/findings.json');
