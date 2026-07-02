// diag: does the lane-center shift double-apply on Rebuild Roads?
import {
  mkWorld, commitPlainRoad, commitMergeDraft, buildPolygon, rebuildOnce,
  overlayRowPts, distToPolyline,
} from './probe.mjs';

const state = mkWorld();
commitPlainRoad(state, [[600, 560], [600, 640]], 6, 'DestV');
const destPts = [[600, 560], [600, 640]];

// lane drawn slightly INSIDE the stripe (2.0 off centerline) -> clamp puts
// the smoothed line exactly on the stripe (2.4556).
let cur = commitMergeDraft(state, {
  pts: [[598.0, 575], [598.0, 600], [598.0, 625]],
  mergeAlign: 4, mergeType: 0,
});

const midOffset = (row) => {
  const pts = overlayRowPts(row);
  let total = 0;
  const arc = [0];
  for (let i = 1; i < pts.length; i++) {
    total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    arc.push(total);
  }
  // offset of the vertex nearest mid-arc + min/max over middle half
  let lo = Infinity; let hi = -Infinity;
  for (let i = 0; i < pts.length; i++) {
    if (arc[i] < 0.25 * total || arc[i] > 0.75 * total) continue;
    const { d } = distToPolyline(pts[i], destPts);
    if (d < lo) lo = d;
    if (d > hi) hi = d;
  }
  return { nPts: pts.length, midMin: +lo.toFixed(4), midMax: +hi.toFixed(4) };
};

const innerRun = (state2, idx) => {
  const poly = buildPolygon(state2, idx);
  let lo = Infinity; let hi = -Infinity;
  for (const v of poly.inner) {
    const { d } = distToPolyline(v, destPts);
    if (d < lo) lo = d;
    if (d > hi) hi = d;
  }
  return { innerMin: +lo.toFixed(4), innerMax: +hi.toFixed(4) };
};

console.log('commit0 drivePath', midOffset(cur.row), 'render', innerRun(state, cur.idx),
  'laneCentered', cur.props.laneCentered === true);
for (let r = 1; r <= 3; r++) {
  cur = rebuildOnce(state, cur.idx);
  console.log(`rebuild${r} drivePath`, midOffset(cur.row), 'render', innerRun(state, cur.idx),
    'laneCentered', cur.props.laneCentered === true);
}
