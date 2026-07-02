// mergelab/probe.mjs — probe foundation for the merge-geometry audit.
// Faithful headless replica of the game's commit + render pipeline for
// merge rows, built on esbuild bundles of repo HEAD (696c015 / H979).
//
//   commit path :  _weCommitDraft (draft.mjs) with dDeps.mergeBondEndpoints
//                  -> _weMergeBondEndpoints (merge.mjs), deps identical to
//                  src/gameLoop.ts dDeps/mergeDeps wiring (~L941-1064).
//   render path :  buildPolygon() assembles _weBuildTaperedMergeEdges opts
//                  exactly like src/editor/render.ts _weDrawTaperedMergeRoad
//                  (L1805-1887) / src/render/worldMap.ts (L2659-2673):
//                  z-preferring edge-aware bond re-scan (halfW+1 radius),
//                  _resolveMergeInnerDir(sidecar bondInner*, legacy scan),
//                  cloverleaf align coercion, laneCentered flag.
//
// BondTarget (src/editor/index.ts L59): { roadIdx, segIdx, side: 1|-1, laneIdx }
//   roadIdx/segIdx index getMajorRoads() AT CLICK TIME. In this probe there
//   are no baseline roads, so roadIdx === overlay row index (liveRoads()
//   maps overlay rows in order). Lane-click fills it from a 'lane' snap
//   (input.ts L780-789) and stores it in draft.ptSnaps aligned with pts;
//   commit passes ptSnaps[0] / ptSnaps[last] as startTarget / endTarget.

import { _weCommitDraft, _decodeMergeFlag } from './draft.mjs';
import { _weMergeBondEndpoints } from './merge.mjs';
import {
  _weBuildTaperedMergeEdges,
  _resolveMergeInnerDir,
  _computeMergeInnerDir,
} from './taper.mjs';

export const LANE_W = 1.275;
export const STRIPE_INSET = 1.7 / 18; // matches standard.ts / getRoadProfile

// ---------------------------------------------------------------- profile
// 1:1 copy of src/gameLoop.ts snapDeps.getRoadProfile (L959-992).
export function profileFor(roadOrW, name = '') {
  const road = typeof roadOrW === 'object' && roadOrW !== null
    ? roadOrW
    : { w: roadOrW, name };
  const LANE_W_STD = 1.275;
  const w = road.w;
  const nm = road.name;
  let lps;
  let medFrac;
  if (nm === 'I-485') { lps = 3; medFrac = 0.25; }
  else if (w >= 12) { lps = 4; medFrac = 0.02; }
  else if (w >= 8) { lps = 3; medFrac = 0.02; }
  else if (w >= 6) { lps = 2; medFrac = 0; }
  else { lps = 1; medFrac = 0; }
  const isOneWay = (w === 2);
  const totalLanes = isOneWay ? lps : lps * 2;
  const carriageW = totalLanes * LANE_W_STD;
  const medHalf = medFrac > 0 ? carriageW * medFrac * 0.5 : 0;
  const totalW = carriageW + medHalf * 2;
  const hasRealMedian = nm === 'I-485' || w >= 12;
  const shoulderW = hasRealMedian ? 0.5 * LANE_W_STD : 0;
  const asphaltW = totalW + 2 * shoulderW;
  const centers = [];
  for (let i = 0; i < lps; i++) centers.push(medHalf + (i + 0.5) * LANE_W_STD);
  return { lps, laneW: LANE_W_STD, totalW, asphaltW, centers, laneCount: totalLanes };
}

// destination outer-stripe offset from centerline (task spec).
export function stripeOf(road) {
  const p = profileFor(road);
  return (p.laneCount * p.laneW) / 2;
}

// ------------------------------------------------------------------ state
export function mkWorld() {
  return {
    overlay: [],
    surfaces: [], buildings: [], rivers: [], lakes: [], parkingLots: [],
    overlayRoadProps: {}, overlayMaterialOverrides: {},
    baselineEdits: {}, baselineDeletes: [], baselineRoadProps: {},
    baselineMaterialOverrides: {},
    selected: -1, selectedSurface: -1, selectedBuilding: -1, selectedRiver: -1,
    selectedLake: -1, selectedParkingLot: -1, selectedBaselineRoad: -1,
    selectedSegmentIdx: -1, selectedKind: null, activeVertex: -1,
    needsRedraw: false,
    mergeLaneOverride: null, mergeSideOverride: null,
    draftProps: {
      w: 2, maj: 1, name: 'Lane', z: 0, arc: false, curve: 0,
      merge: false, mergeAlign: 4, mergeType: 0, loopDiameter: 0,
      material: 'asphalt', age: 'new', oneway: false,
    },
    draft: null,
  };
}

// merge row = ODD length, FLAG at [4], pts from 5; plain = EVEN, pts from 4.
export function overlayRowPts(row) {
  const start = row.length % 2 === 1 ? 5 : 4;
  const pts = [];
  for (let i = start; i + 1 < row.length; i += 2) pts.push([row[i], row[i + 1]]);
  return pts;
}

// light live-roads getter — the probe analogue of gameLoop
// getLiveRoadsLight (no baseline roads here, so index === overlay index).
export function liveRoads(state) {
  return state.overlay.map((row) => ({
    pts: overlayRowPts(row), w: row[0], name: String(row[2]), z: row[3],
  }));
}

// commit deps — identical wiring to gameLoop dDeps / mergeDeps.
export function mkDeps(state) {
  const mergeDeps = {
    getMajorRoads: () => liveRoads(state),
    getRoadProfile: (road) => profileFor(road),
  };
  return {
    mergeBondEndpoints: (
      pts, dW, mergeAlign, mergeType, loopDiameter, sideOut, rampZ,
      startTarget, endTarget,
    ) => _weMergeBondEndpoints(
      { pts, dW, mergeAlign, mergeType, loopDiameter, sideOut, rampZ, startTarget, endTarget },
      mergeDeps,
    ),
    makeDriveway: () => null,
    rebuildWorld: () => {},
    getMajorRoads: () => liveRoads(state),
    getRoadProfile: (road) => profileFor(road),
  };
}

// --------------------------------------------------------------- commits
export function commitPlainRoad(state, pts, w, name = 'Road', z = 0) {
  state.draftProps = { ...state.draftProps, w, name, z, merge: false };
  state.draft = {
    kind: 'road', pts: pts.map((p) => [p[0], p[1]]), ptSnaps: [],
    w, maj: 1, name, z, arc: false, curve: 0,
    merge: false, mergeAlign: 4, mergeType: 0, loopDiameter: 0,
    material: 'asphalt', age: 'new',
  };
  _weCommitDraft(state, mkDeps(state));
  const idx = state.overlay.length - 1;
  return { row: state.overlay[idx], idx };
}

export function commitMergeDraft(state, opts) {
  const {
    pts, mergeAlign = 4, mergeType = 0,
    startTarget = null, endTarget = null,
    w = 2, z = 0, name = 'Lane', loopDiameter = 0,
  } = opts;
  const ptSnaps = pts.map(() => null);
  ptSnaps[0] = startTarget;
  ptSnaps[ptSnaps.length - 1] = endTarget;
  state.draftProps = { ...state.draftProps, w, name, z, merge: true, mergeAlign, mergeType };
  state.draft = {
    kind: 'road', pts: pts.map((p) => [p[0], p[1]]), ptSnaps,
    w, maj: 1, name, z, arc: false, curve: 0,
    merge: true, mergeAlign, mergeType, loopDiameter,
    material: 'asphalt', age: 'new',
  };
  _weCommitDraft(state, mkDeps(state));
  const idx = state.overlay.length - 1;
  const props = (state.overlayRoadProps ?? {})[String(idx)] ?? {};
  return { row: state.overlay[idx], props, idx };
}

// inject an already-exported row verbatim (no commit pipeline).
export function injectRow(state, row, props = null) {
  state.overlay.push(row.slice());
  const idx = state.overlay.length - 1;
  if (props) {
    state.overlayRoadProps = state.overlayRoadProps ?? {};
    state.overlayRoadProps[String(idx)] = { ...props };
  }
  return idx;
}

// ------------------------------------------------------- render polygon
// port of render.ts findClosestOtherRoadAtEndpoint (L1696-1760), z-prefer.
function findClosestOtherRoad(ex, ey, allRoads, selfRoad, rOf, preferZ) {
  let best = null; let bestD2 = Infinity;
  let bestSame = null; let bestSameD2 = Infinity;
  const wantZ = preferZ === undefined ? null : (preferZ | 0);
  for (const r of allRoads) {
    if (r === selfRoad) continue;
    if (!r.pts || r.pts.length < 2) continue;
    const rr = rOf(r);
    const rr2 = rr * rr;
    const isSameZ = wantZ !== null && ((Number(r.z) | 0) === wantZ);
    for (let i = 0; i < r.pts.length - 1; i++) {
      const ax = r.pts[i][0]; const ay = r.pts[i][1];
      const dx = r.pts[i + 1][0] - ax; const dy = r.pts[i + 1][1] - ay;
      const lenSq = dx * dx + dy * dy;
      if (lenSq < 0.0001) continue;
      let t = ((ex - ax) * dx + (ey - ay) * dy) / lenSq;
      if (t < 0) t = 0; else if (t > 1) t = 1;
      const px = ax + dx * t; const py = ay + dy * t;
      const d2 = (ex - px) * (ex - px) + (ey - py) * (ey - py);
      if (isSameZ && d2 <= rr2 && d2 < bestSameD2) { bestSameD2 = d2; bestSame = r; }
      if (d2 <= rr2 && d2 < bestD2) { bestD2 = d2; best = r; }
    }
  }
  return bestSame ?? best;
}

// assembles _weBuildTaperedMergeEdges opts exactly like the real render
// callers (editor render.ts L1805-1887 / game worldMap.ts L2659-2673).
export function buildPolygon(state, idx) {
  const row = state.overlay[idx];
  if (!row) return null;
  const isMergeRow = row.length % 2 === 1;
  const { mergeType, mergeAlign } = _decodeMergeFlag(isMergeRow ? row[4] : 0);
  const pts = overlayRowPts(row);
  if (pts.length < 2) return null;
  const props = (state.overlayRoadProps ?? {})[String(idx)] ?? {};
  const roads = liveRoads(state);
  const self = roads[idx]; // identity for the self-skip
  const bondR = (r) => profileFor(r).totalW * 0.5 + 1.0;
  const mergeZ = Number(row[3]) | 0;
  const bondedS = findClosestOtherRoad(pts[0][0], pts[0][1], roads, self, bondR, mergeZ);
  const bondedE = findClosestOtherRoad(
    pts[pts.length - 1][0], pts[pts.length - 1][1], roads, self, bondR, mergeZ);
  const ma = mergeType === 1 ? 4 : (mergeAlign || 1);
  const innerDirStart = _resolveMergeInnerDir(
    props.bondInnerStart, mergeType,
    () => (ma !== 1 && bondedS
      ? _computeMergeInnerDir(pts, 0, [bondedS], self, bondR(bondedS))
      : null),
  );
  const innerDirEnd = _resolveMergeInnerDir(
    props.bondInnerEnd, mergeType,
    () => (ma !== 1 && bondedE
      ? _computeMergeInnerDir(pts, pts.length - 1, [bondedE], self, bondR(bondedE))
      : null),
  );
  const edges = _weBuildTaperedMergeEdges({
    tilePts: pts,
    prof: profileFor(self),
    bondedStart: bondedS !== null,
    bondedEnd: bondedE !== null,
    innerDirStart,
    innerDirEnd,
    mergeAlign: ma,
    mergeType,
    bondedRoadStartPts: bondedS ? bondedS.pts : null,
    bondedRoadEndPts: bondedE ? bondedE.pts : null,
    laneCentered: props.laneCentered === true,
  });
  if (!edges) return null;
  return {
    inner: edges.inner,
    outer: edges.outer,
    meta: { pts, ma, mt: mergeType, bondedS, bondedE, innerDirStart, innerDirEnd, props },
  };
}

// ---------------------------------------------------------------- geometry
export function distToPolyline(p, poly) {
  let best = Infinity; let btx = 1; let bty = 0;
  for (let i = 0; i < poly.length - 1; i++) {
    const ax = poly[i][0]; const ay = poly[i][1];
    const dx = poly[i + 1][0] - ax; const dy = poly[i + 1][1] - ay;
    const L2 = dx * dx + dy * dy;
    if (L2 < 1e-9) continue;
    let t = ((p[0] - ax) * dx + (p[1] - ay) * dy) / L2;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    const qx = ax + dx * t; const qy = ay + dy * t;
    const d = Math.hypot(p[0] - qx, p[1] - qy);
    if (d < best) { best = d; const L = Math.sqrt(L2); btx = dx / L; bty = dy / L; }
  }
  return { d: best, tx: btx, ty: bty };
}

function arcLengths(pts) {
  const arc = [0];
  for (let i = 1; i < pts.length; i++) {
    arc.push(arc[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  }
  return arc;
}

function tangentAt(pts, i) {
  const a = Math.max(0, i - 1); const b = Math.min(pts.length - 1, i + 1);
  const dx = pts[b][0] - pts[a][0]; const dy = pts[b][1] - pts[a][1];
  const L = Math.hypot(dx, dy) || 1;
  return [dx / L, dy / L];
}

// proper (interior-interior) crossing of two segments; touching = false.
function properIntersect(a, b, c, d) {
  const o = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const EPS = 1e-9;
  const o1 = o(a, b, c); const o2 = o(a, b, d);
  const o3 = o(c, d, a); const o4 = o(c, d, b);
  return ((o1 > EPS && o2 < -EPS) || (o1 < -EPS && o2 > EPS))
      && ((o3 > EPS && o4 < -EPS) || (o3 < -EPS && o4 > EPS));
}

// ------------------------------------------------------------- invariants
// checkInvariants(polygon, row, props, world, opts)
//   opts: { startTarget, endTarget,   — explicit BondTargets (I2' mode per end)
//           i2ExemptArc (default 16 = MERGE_TAPER_TILES, the pipeline's own
//             ease/accel scale) — arc tiles near an EXPLICIT-target end exempt
//             from I2 (lane legitimately runs inside the carriageway there
//             while easing out; I2' + I3/I4/I5 still cover that region)
//           only: ['I1','I2',...] }   — optional invariant subset gate
// returns { pass, failures: [{inv, deviation, detail}], stats }
export function checkInvariants(polygon, row, props, world, opts = {}) {
  const failures = [];
  const stats = {};
  if (!polygon) {
    return { pass: false, failures: [{ inv: 'I4', deviation: NaN, detail: 'polygon is null' }], stats };
  }
  const { inner, outer, meta } = polygon;
  const pts = meta?.pts ?? overlayRowPts(row);
  const ma = meta?.ma ?? 4;
  const mt = meta?.mt ?? 0;
  const bondedS = meta?.bondedS ?? null;
  const bondedE = meta?.bondedE ?? null;
  const startTarget = opts.startTarget ?? null;
  const endTarget = opts.endTarget ?? null;
  const roads = liveRoads(world);
  const arc = arcLengths(pts);
  const total = arc[arc.length - 1] || 1;
  const gate = opts.only ? new Set(opts.only) : null;
  const active = (inv) => !gate || gate.has(inv) || (inv === 'I2p' && gate.has('I2'));

  // expected lateral attach offset from the destination CENTERLINE.
  const expectedOffset = (dest, target) => {
    const p = profileFor(dest);
    if (target) return Math.max(0, ((target.laneIdx > 0 ? target.laneIdx : 1) - 0.5) * p.laneW);
    if (ma === 4 || ma === 3) return Math.max(0, p.totalW * 0.5 - STRIPE_INSET);
    if (ma === 2) return Math.max(0, p.totalW * 0.5 - p.laneW * 0.5);
    return null; // ma === 1: nearest lane center, resolved below
  };

  // ---- I1 / I2' tips-on-bond
  for (const [label, tip, dest, target] of [
    ['start', pts[0], bondedS, startTarget],
    ['end', pts[pts.length - 1], bondedE, endTarget],
  ]) {
    if (!dest) continue;
    const targetRoad = target ? (roads[target.roadIdx] ?? dest) : dest;
    const { d } = distToPolyline(tip, targetRoad.pts);
    let exp = expectedOffset(targetRoad, target);
    if (exp === null) {
      // ma 1 = nearest lane center on either side
      const p = profileFor(targetRoad);
      exp = p.centers.reduce((b, c) => (Math.abs(d - c) < Math.abs(d - b) ? c : b), p.centers[0]);
    }
    const dev = Math.abs(d - exp);
    const inv = target ? 'I2p' : 'I1';
    stats[`${inv}_${label}`] = { distToCenterline: +d.toFixed(4), expected: +exp.toFixed(4), deviation: +dev.toFixed(4) };
    if (active(inv) && dev > 0.35) {
      failures.push({ inv, deviation: +dev.toFixed(4), detail: `${label} tip ${d.toFixed(3)} from centerline, expected ${exp.toFixed(3)}` });
    }
  }

  // ---- I2 parallel-run attachment (align 3/4 stripe bonds, non-explicit)
  if ((ma === 4 || ma === 3) && (bondedS || bondedE)) {
    const dests = [bondedS, bondedE].filter(Boolean);
    const exemptArc = opts.i2ExemptArc ?? 16;
    const COS7 = Math.cos((7 * Math.PI) / 180);
    let worst = 0; let worstDetail = null; let nChecked = 0;
    for (let i = 0; i < inner.length; i++) {
      const a = arc[Math.min(i, arc.length - 1)];
      if (startTarget && a < exemptArc) continue;
      if (endTarget && a > total - exemptArc) continue;
      const tan = tangentAt(inner, i);
      for (const dest of dests) {
        const f = distToPolyline(inner[i], dest.pts);
        if (f.d > 5) continue;
        if (Math.abs(tan[0] * f.tx + tan[1] * f.ty) < COS7) continue;
        nChecked++;
        const p = profileFor(dest);
        const stripe = (p.laneCount * p.laneW) / 2;
        const lo = stripe - 0.25; const hi = stripe + 0.35;
        const out = f.d < lo ? lo - f.d : f.d > hi ? f.d - hi : 0;
        if (out > worst) {
          worst = out;
          worstDetail = `inner[${i}] d=${f.d.toFixed(3)} from ${dest.name} centerline, band [${lo.toFixed(3)}, ${hi.toFixed(3)}]`;
        }
      }
    }
    stats.I2 = { verticesChecked: nChecked, worstBandExcess: +worst.toFixed(4) };
    if (active('I2') && worst > 0) {
      failures.push({ inv: 'I2', deviation: +worst.toFixed(4), detail: worstDetail });
    }
  }

  // ---- I3 no-self-intersection (closed loop: outer fwd + inner bwd)
  {
    const loop = [...outer, ...[...inner].reverse()];
    const M = loop.length;
    const segs = [];
    for (let i = 0; i < M; i++) {
      const a = loop[i]; const b = loop[(i + 1) % M];
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) > 1e-9) segs.push([a, b, i]);
    }
    let hits = 0; let firstHit = null;
    for (let i = 0; i < segs.length; i++) {
      for (let j = i + 2; j < segs.length; j++) {
        if (i === 0 && j === segs.length - 1) continue; // closing adjacency
        const [a, b] = segs[i]; const [c, d] = segs[j];
        // skip pairs sharing a coordinate (tip pinches are legal)
        const share = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 1e-6;
        if (share(a, c) || share(a, d) || share(b, c) || share(b, d)) continue;
        if (properIntersect(a, b, c, d)) {
          hits++;
          if (!firstHit) firstHit = `loopSeg[${segs[i][2]}] x loopSeg[${segs[j][2]}]`;
        }
      }
    }
    stats.I3 = { properIntersections: hits };
    if (active('I3') && hits > 0) {
      failures.push({ inv: 'I3', deviation: hits, detail: `self-intersections: ${hits}, first at ${firstHit}` });
    }
  }

  // ---- I4 sanity: NaN + max vertex distance from stored polyline
  {
    let nan = 0; let maxD = 0; let maxAt = '';
    for (const [nm, poly] of [['outer', outer], ['inner', inner]]) {
      for (let i = 0; i < poly.length; i++) {
        if (!Number.isFinite(poly[i][0]) || !Number.isFinite(poly[i][1])) { nan++; continue; }
        const { d } = distToPolyline(poly[i], pts);
        if (d > maxD) { maxD = d; maxAt = `${nm}[${i}]`; }
      }
    }
    stats.I4 = { nanCount: nan, maxVertexDistFromPolyline: +maxD.toFixed(4), at: maxAt };
    if (active('I4') && nan > 0) failures.push({ inv: 'I4', deviation: nan, detail: `${nan} NaN vertices` });
    if (active('I4') && maxD > 2.5) failures.push({ inv: 'I4', deviation: +(maxD - 2.5).toFixed(4), detail: `${maxAt} sits ${maxD.toFixed(3)} tiles from stored polyline (max 2.5)` });
  }

  // ---- I5 lane width in middle 40% of arc length
  {
    const N = Math.min(inner.length, outer.length, pts.length);
    const lo = 0.3 * total; const hi = 0.7 * total;
    let minW = Infinity; let maxW = 0; let n = 0;
    for (let i = 0; i < N; i++) {
      if (arc[i] < lo || arc[i] > hi) continue;
      const w = Math.hypot(inner[i][0] - outer[i][0], inner[i][1] - outer[i][1]);
      n++;
      if (w < minW) minW = w;
      if (w > maxW) maxW = w;
    }
    if (n === 0) {
      // short polyline: fall back to the vertex nearest mid-arc
      let bi = 0; let bd = Infinity;
      for (let i = 0; i < N; i++) {
        const d = Math.abs(arc[i] - total / 2);
        if (d < bd) { bd = d; bi = i; }
      }
      const w = Math.hypot(inner[bi][0] - outer[bi][0], inner[bi][1] - outer[bi][1]);
      minW = maxW = w; n = 1;
    }
    stats.I5 = { verticesInWindow: n, minWidth: +minW.toFixed(4), maxWidth: +maxW.toFixed(4) };
    if (active('I5') && (minW < 1.0 || maxW > 1.45)) {
      const dev = minW < 1.0 ? +(1.0 - minW).toFixed(4) : +(maxW - 1.45).toFixed(4);
      failures.push({ inv: 'I5', deviation: dev, detail: `width range [${minW.toFixed(3)}, ${maxW.toFixed(3)}] outside [1.0, 1.45]` });
    }
  }

  return { pass: failures.length === 0, failures, stats };
}

// --------------------------------------------------------------- I6 helper
// resample the committed row to 4 knots (ends + 2 uniform interior by arc
// length) and re-commit as a fresh merge draft — what Rebuild Roads does.
// Removes the OLD row first (so the bond scan can't bond the lane to its
// own stale copy), re-keys later sidecars, returns the new {row,props,idx}.
export function rebuildOnce(state, idx) {
  const row = state.overlay[idx];
  const isMergeRow = row.length % 2 === 1;
  const { mergeType, mergeAlign } = _decodeMergeFlag(isMergeRow ? row[4] : 0);
  const pts = overlayRowPts(row);
  const arc = arcLengths(pts);
  const total = arc[arc.length - 1];
  const sample = (target) => {
    for (let i = 1; i < pts.length; i++) {
      if (arc[i] >= target) {
        const t = (target - arc[i - 1]) / ((arc[i] - arc[i - 1]) || 1);
        return [
          pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t,
          pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t,
        ];
      }
    }
    return [pts[pts.length - 1][0], pts[pts.length - 1][1]];
  };
  const knots = [
    [pts[0][0], pts[0][1]],
    sample(total / 3),
    sample((2 * total) / 3),
    [pts[pts.length - 1][0], pts[pts.length - 1][1]],
  ];
  // remove old row + its sidecar; re-key sidecars above idx.
  state.overlay.splice(idx, 1);
  const oldProps = state.overlayRoadProps ?? {};
  const next = {};
  for (const k of Object.keys(oldProps)) {
    const ki = Number(k);
    if (ki === idx) continue;
    next[String(ki > idx ? ki - 1 : ki)] = oldProps[k];
  }
  state.overlayRoadProps = next;
  return commitMergeDraft(state, {
    pts: knots, mergeAlign, mergeType,
    w: row[0], z: row[3], name: String(row[2]),
  });
}
