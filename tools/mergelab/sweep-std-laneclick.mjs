// sweep-std-laneclick.mjs — audit slice: mergeType 0, mergeAlign 4 WITH
// explicit BondTargets (lane-click). Targets: OUTERMOST lane, INNER lane
// (laneIdx 1), FAR-side lane (side flipped, laneIdx 1). Classes A (both
// ends targeted) and D (end targeted only), both approach sides, w=6 & w=8.
//
// Faithful lane-click synthesis (src/editor/snap.ts L327-338 +
// input.ts L775-789): the placed draft pt IS the snapped lane-center
// position (proj + side*(-tdy,tdx)*(laneIdx-0.5)*laneW), and the
// BondTarget {roadIdx, segIdx, side, laneIdx} rides in ptSnaps.
// Far-side / specific-lane picks are legitimately producible via the
// H904 ◀ Lane ▶ / Flip-Side overrides.
//
// Gates per task NOTE: I2' (tip within 0.35 of TARGET lane center; run
// both unsigned |dist-expected| via probe checkInvariants and a stricter
// SIGNED variant: dist to the actual side-offset lane-center polyline),
// plus I3 / I4 / I5. I2 stripe-band does NOT apply to explicit-target
// cells. No I6 in this slice (rebuild drift is another slice's known
// H967 defect and rebuild drops lane-click targets anyway).
import {
  mkWorld, commitPlainRoad, commitMergeDraft, buildPolygon,
  checkInvariants, liveRoads, profileFor, distToPolyline, overlayRowPts,
} from './probe.mjs';

const R = (x) => +(+x).toFixed(4);

// ---- nearest segment on a polyline (mirrors snap.ts segment pick)
function nearestSeg(pts, p) {
  let best = { d: Infinity, segIdx: 0, foot: pts[0], tan: [0, 1] };
  for (let i = 0; i < pts.length - 1; i++) {
    const ax = pts[i][0]; const ay = pts[i][1];
    const dx = pts[i + 1][0] - ax; const dy = pts[i + 1][1] - ay;
    const L2 = dx * dx + dy * dy;
    if (L2 < 1e-9) continue;
    let t = ((p[0] - ax) * dx + (p[1] - ay) * dy) / L2;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    const qx = ax + dx * t; const qy = ay + dy * t;
    const d = Math.hypot(p[0] - qx, p[1] - qy);
    if (d < best.d) {
      const L = Math.sqrt(L2);
      best = { d, segIdx: i, foot: [qx, qy], tan: [dx / L, dy / L] };
    }
  }
  return best;
}

// synthesize a lane-click on road roadIdx near approxPt: returns the
// snapped draft point (lane center) + the BondTarget.
function laneClick(state, roadIdx, approxPt, side, laneIdx) {
  const road = liveRoads(state)[roadIdx];
  const prof = profileFor(road);
  const { segIdx, foot, tan } = nearestSeg(road.pts, approxPt);
  const off = (laneIdx - 0.5) * prof.laneW;
  // side +1 dir = (-tdy, tdx)  [standard.ts L366 / snap.ts L328]
  const pt = [foot[0] + side * -tan[1] * off, foot[1] + side * tan[0] * off];
  return { pt, target: { roadIdx, segIdx, side, laneIdx } };
}

// per-vertex normal offset of a polyline (dest roads here are straight,
// so this is exact) — the TARGET lane-center polyline for the signed I2'.
function offsetPolyline(pts, off, side) {
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const a = Math.max(0, i - 1); const b = Math.min(pts.length - 1, i + 1);
    const dx = pts[b][0] - pts[a][0]; const dy = pts[b][1] - pts[a][1];
    const L = Math.hypot(dx, dy) || 1;
    out.push([pts[i][0] + side * (-dy / L) * off, pts[i][1] + side * (dx / L) * off]);
  }
  return out;
}

// ---------------------------------------------------------------- cells
// dest: vertical road x=600, y 560..640, tangent (0,+1) => side +1 = WEST.
// approach W => s=+1 (lane body west of road), E => s=-1.
// lateral position at offset `off` on side `s`:  x = 600 - s*off ... NO:
// side+1 dir is (-1,0) => x = 600 + s*(-1)*off = 600 - s*off. W(+1): 600-off. ok
const DEST = { pts: [[600, 560], [600, 640]] };

function targetSpec(kind, approach, w) {
  const lps = profileFor(w).lps; // 2 for w6, 3 for w8
  if (kind === 'outer') return { side: approach, laneIdx: lps };
  if (kind === 'inner') return { side: approach, laneIdx: 1 };
  return { side: -approach, laneIdx: 1 }; // far
}

function buildCell(cls, approach, w, kind) {
  const state = mkWorld();
  commitPlainRoad(state, DEST.pts.map((p) => [p[0], p[1]]), w, 'DestV');
  const stripe = profileFor(w).totalW / 2;
  const spec = targetSpec(kind, approach, w);
  const s = approach;
  let pts; let startTarget = null; let endTarget = null;
  if (cls === 'A') {
    const c0 = laneClick(state, 0, [600, 580], spec.side, spec.laneIdx);
    const c1 = laneClick(state, 0, [600, 620], spec.side, spec.laneIdx);
    const mid = [600 - s * (stripe + 1.6), 600];
    pts = [c0.pt, mid, c1.pt];
    startTarget = c0.target; endTarget = c1.target;
  } else { // D: start 8-10 tiles out in open ground, only END targeted
    const cE = laneClick(state, 0, [600, 610], spec.side, spec.laneIdx);
    pts = [
      [600 - s * (stripe + 7), 580],
      [600 - s * (stripe + 3.5), 595],
      cE.pt,
    ];
    endTarget = cE.target;
  }
  const { row, props, idx } = commitMergeDraft(state, {
    pts, mergeAlign: 4, mergeType: 0, startTarget, endTarget,
  });
  return { state, row, props, idx, pts, startTarget, endTarget, w, spec };
}

function runCell(id, cls, approach, w, kind) {
  const cell = buildCell(cls, approach, w, kind);
  const { state, row, props, idx, startTarget, endTarget } = cell;
  const poly = buildPolygon(state, idx);
  const res = checkInvariants(poly, row, props, state, {
    startTarget, endTarget, only: ['I2p', 'I3', 'I4', 'I5'],
  });
  const failures = [...res.failures];
  const stats = { ...res.stats };

  // ---- signed I2': dist(tip, target-lane-center POLYLINE with side)
  const cpts = overlayRowPts(row);
  const roads = liveRoads(state);
  for (const [label, tip, target] of [
    ['start', cpts[0], startTarget],
    ['end', cpts[cpts.length - 1], endTarget],
  ]) {
    if (!target) continue;
    const dest = roads[target.roadIdx];
    const prof = profileFor(dest);
    const lanePoly = offsetPolyline(
      dest.pts, (target.laneIdx - 0.5) * prof.laneW, target.side);
    const dev = distToPolyline(tip, lanePoly).d;
    stats[`I2pSigned_${label}`] = R(dev);
    if (dev > 0.35) {
      failures.push({
        inv: 'I2p-signed', deviation: R(dev),
        detail: `${label} tip ${dev.toFixed(3)} from TARGET lane-center polyline (side=${target.side}, laneIdx=${target.laneIdx})`,
      });
    }
  }

  const bonded = poly
    ? { start: poly.meta.bondedS?.name ?? null, end: poly.meta.bondedE?.name ?? null }
    : null;
  // D-class start must be UNBONDED (open ground); a bond there means the
  // harness geometry interferes — flag as harness note not a defect.
  const harness = [];
  if (cls === 'D' && bonded && bonded.start) harness.push('D-start unexpectedly bonded');
  if (bonded && endTarget && !bonded.end) harness.push('targeted end not bonded in render scan');
  if (bonded && startTarget && !bonded.start) harness.push('targeted start not bonded in render scan');

  return {
    id, cls, approach: approach === 1 ? 'W' : 'E', w, targetKind: kind,
    pass: failures.length === 0,
    failures,
    stats,
    bonded,
    harness,
    repro: {
      dest: { pts: DEST.pts, w, name: 'DestV' },
      draft: {
        pts: cell.pts.map((p) => [R(p[0]), R(p[1])]),
        w: 2, mergeAlign: 4, mergeType: 0,
        startTarget, endTarget,
      },
    },
  };
}

// full cross of the slice axes: 2 class x 2 side x 2 width x 3 target = 24
const cells = [];
for (const cls of ['A', 'D']) {
  for (const approach of [1, -1]) {
    for (const w of [6, 8]) {
      for (const kind of ['outer', 'inner', 'far']) {
        const id = `${cls}-w${w}-${approach === 1 ? 'W' : 'E'}-${kind}`;
        cells.push(runCell(id, cls, approach, w, kind));
      }
    }
  }
}

const failed = cells.filter((c) => !c.pass);
const out = {
  slice: 'std-laneclick',
  cellsRun: cells.length,
  cellsFailed: failed.length,
  passed: cells.filter((c) => c.pass).map((c) => c.id),
  failures: failed.map((c) => ({
    cell: c.id, class: c.cls, side: c.approach, width: c.w, target: c.targetKind,
    align: 4, type: 0,
    invariants: c.failures.map((f) => ({ inv: f.inv, deviation: f.deviation, detail: f.detail })),
    bonded: c.bonded,
    repro: c.repro,
  })),
  harnessFlags: cells.filter((c) => c.harness.length).map((c) => ({ cell: c.id, notes: c.harness })),
  allStats: Object.fromEntries(cells.map((c) => [c.id, c.stats])),
};
console.log(JSON.stringify(out, null, 1));
