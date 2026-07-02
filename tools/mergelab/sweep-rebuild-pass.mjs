// mergelab/sweep-rebuild-pass.mjs — I6 rebuild-stability slice.
// Classes A + B, align 4, w=6/w=8, both sides. For each cell:
//   commit -> gate I1-I5 (informational firstCommit)
//   rebuildOnce (4-knot resample + recommit, the Rebuild Roads recipe)
//     -> re-check I1/I2/I5   (R1, gated)
//   rebuildOnce again (double rebuild) -> re-check I1/I2/I5 (R2, gated)
// A failing cell = R1 or R2 fails its I1/I2/I5 gate.
import {
  mkWorld, commitPlainRoad, commitMergeDraft, buildPolygon,
  checkInvariants, rebuildOnce, overlayRowPts, distToPolyline, profileFor,
} from './probe.mjs';

// stripe-inside draw offsets (the canonical passing first-commit draw per
// smoke A: drawn just INSIDE the stripe so the commit clamp lands the
// smoothed line ON the stripe). stripe(w=6)=2.55 -> draw 2.0;
// stripe(w=8)=3.825 -> draw 3.3.
const DRAW_OFF = { 6: 2.0, 8: 3.3 };

// ------------------------------------------------------------- generators
// class A: vertical dest road x=600 y 560..640 (w varies); straight 3-pt
// lane parallel at DRAW_OFF, y 575..625, west (-1) or east (+1).
function cellA(w, side) {
  const off = DRAW_OFF[w] * side;
  return {
    dests: [{ pts: [[600, 560], [600, 640]], w, name: 'DestV' }],
    draft: [[600 + off, 575], [600 + off, 600], [600 + off, 625]],
  };
}

// class B: DestV vertical (x=600, y 560..610) + DestH horizontal (y=640)
// ~30 tiles apart; 4-pt lane from alongside-V curving to alongside-H.
// hand=+1: base = lane WEST of V curving west along H; hand=-1 mirrored EAST.
function cellB(wV, wH, hand) {
  const offV = DRAW_OFF[wV];
  const offH = DRAW_OFF[wH];
  const mx = (x) => 600 + (x - 600) * hand; // hand=+1 keeps base (west), -1 mirrors east
  return {
    dests: [
      { pts: [[600, 560], [600, 610]], w: wV, name: 'DestV' },
      { pts: [[560, 640], [680, 640]], w: wH, name: 'DestH' },
    ],
    draft: [
      [mx(600 - offV), 600],
      [mx(600 - offV - 1.5), 620],
      [mx(590), 640 - offH - 1.3],
      [mx(580), 640 - offH],
    ],
  };
}

const CELLS = [
  { id: 'A-w6-west', cls: 'A', side: 'west', w: 6, gen: () => cellA(6, -1) },
  { id: 'A-w6-east', cls: 'A', side: 'east', w: 6, gen: () => cellA(6, +1) },
  { id: 'A-w8-west', cls: 'A', side: 'west', w: 8, gen: () => cellA(8, -1) },
  { id: 'A-w8-east', cls: 'A', side: 'east', w: 8, gen: () => cellA(8, +1) },
  { id: 'B-w6-west', cls: 'B', side: 'west-of-V', w: 6, gen: () => cellB(6, 6, +1) },
  { id: 'B-w6-east', cls: 'B', side: 'east-of-V', w: 6, gen: () => cellB(6, 6, -1) },
  { id: 'B-w8-west', cls: 'B', side: 'west-of-V', w: 8, gen: () => cellB(8, 8, +1) },
  { id: 'B-w8-east', cls: 'B', side: 'east-of-V', w: 8, gen: () => cellB(8, 8, -1) },
  { id: 'B-V6H8-west', cls: 'B', side: 'west-of-V', w: '6/8', gen: () => cellB(6, 8, +1) },
  { id: 'B-V6H8-east', cls: 'B', side: 'east-of-V', w: '6/8', gen: () => cellB(6, 8, -1) },
  { id: 'B-V8H6-west', cls: 'B', side: 'west-of-V', w: '8/6', gen: () => cellB(8, 6, +1) },
  { id: 'B-V8H6-east', cls: 'B', side: 'east-of-V', w: '8/6', gen: () => cellB(8, 6, -1) },
];

const keyStats = (res) => ({
  pass: res.pass,
  I1_start: res.stats.I1_start ?? null,
  I1_end: res.stats.I1_end ?? null,
  I2: res.stats.I2 ?? null,
  I5: res.stats.I5 ?? null,
  failures: res.failures,
});

// I2u: same band test as checkInvariants I2 but withOUT the 5-tile proximity
// gate (capped at 8 tiles). Exposes the vacuous pass where the drifted
// parallel run escapes I2's own d>5 skip window entirely.
function i2Ungated(poly, dests) {
  const inner = poly.inner;
  const COS7 = Math.cos((7 * Math.PI) / 180);
  const tanAt = (pts, i) => {
    const a = Math.max(0, i - 1); const b = Math.min(pts.length - 1, i + 1);
    const dx = pts[b][0] - pts[a][0]; const dy = pts[b][1] - pts[a][1];
    const L = Math.hypot(dx, dy) || 1;
    return [dx / L, dy / L];
  };
  let worst = 0; let n = 0; let detail = null;
  for (let i = 0; i < inner.length; i++) {
    const tan = tanAt(inner, i);
    for (const dest of dests) {
      const f = distToPolyline(inner[i], dest.pts);
      if (f.d > 8) continue;
      if (Math.abs(tan[0] * f.tx + tan[1] * f.ty) < COS7) continue;
      n++;
      const p = profileFor(dest.w, dest.name);
      const stripe = (p.laneCount * p.laneW) / 2;
      const lo = stripe - 0.25; const hi = stripe + 0.35;
      const out = f.d < lo ? lo - f.d : f.d > hi ? f.d - hi : 0;
      if (out > worst) {
        worst = out;
        detail = `inner[${i}] d=${f.d.toFixed(3)} from ${dest.name}, band [${lo.toFixed(3)}, ${hi.toFixed(3)}]`;
      }
    }
  }
  return { verticesChecked: n, worstBandExcess: +worst.toFixed(4), detail };
}

// drive-path drift proxy: min/max distance of the middle-half drive-path
// vertices from the nearest dest centerline (class A: vs DestV).
function midRun(row, destPts) {
  const pts = overlayRowPts(row);
  const arc = [0];
  for (let i = 1; i < pts.length; i++) {
    arc.push(arc[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  }
  const total = arc[arc.length - 1] || 1;
  let lo = Infinity; let hi = -Infinity;
  for (let i = 0; i < pts.length; i++) {
    if (arc[i] < 0.25 * total || arc[i] > 0.75 * total) continue;
    const { d } = distToPolyline(pts[i], destPts);
    if (d < lo) lo = d;
    if (d > hi) hi = d;
  }
  return lo === Infinity ? null : [+lo.toFixed(4), +hi.toFixed(4)];
}

const results = [];
for (const cell of CELLS) {
  const geom = cell.gen();
  const state = mkWorld();
  for (const d of geom.dests) commitPlainRoad(state, d.pts, d.w, d.name);
  const rec = { cell: cell.id, cls: cell.cls, side: cell.side, w: cell.w };
  try {
    const lane = commitMergeDraft(state, {
      pts: geom.draft, mergeAlign: 4, mergeType: 0,
      startTarget: null, endTarget: null, w: 2, z: 0,
    });
    const poly0 = buildPolygon(state, lane.idx);
    const res0 = checkInvariants(poly0, lane.row, lane.props, state);
    rec.firstCommit = keyStats(res0);
    rec.firstCommit.I2u = i2Ungated(poly0, geom.dests);
    rec.firstCommit.committedPts = overlayRowPts(lane.row).length;
    rec.firstCommit.laneCentered = lane.props.laneCentered === true;
    rec.drift = { commit0_mid_vs_DestV: midRun(lane.row, geom.dests[0].pts) };

    // ---- rebuild 1
    const r1 = rebuildOnce(state, lane.idx);
    const poly1 = buildPolygon(state, r1.idx);
    const res1 = checkInvariants(poly1, r1.row, r1.props, state, { only: ['I1', 'I2', 'I5'] });
    rec.rebuild1 = keyStats(res1);
    rec.rebuild1.I2u = i2Ungated(poly1, geom.dests);
    rec.drift.r1_mid_vs_DestV = midRun(r1.row, geom.dests[0].pts);

    // ---- rebuild 2 (double rebuild)
    const r2 = rebuildOnce(state, r1.idx);
    const poly2 = buildPolygon(state, r2.idx);
    const res2 = checkInvariants(poly2, r2.row, r2.props, state, { only: ['I1', 'I2', 'I5'] });
    rec.rebuild2 = keyStats(res2);
    rec.rebuild2.I2u = i2Ungated(poly2, geom.dests);
    rec.drift.r2_mid_vs_DestV = midRun(r2.row, geom.dests[0].pts);

    // vacuous-pass detection: gated I2 checked 0 vertices but the ungated
    // scan finds tangent-parallel run outside the band -> real drift escape.
    for (const [nm, st] of [['rebuild1', rec.rebuild1], ['rebuild2', rec.rebuild2]]) {
      if (st.I2 && st.I2.verticesChecked === 0 && st.I2u.worstBandExcess > 0) {
        st.pass = false;
        st.failures.push({
          inv: 'I2(vacuous-gated-pass)', deviation: st.I2u.worstBandExcess,
          detail: `gated I2 checked 0 vertices (run drifted past the 5-tile window); ungated: ${st.I2u.detail}`,
        });
      }
      void nm;
    }
    rec.sliceFail = !rec.rebuild1.pass || !rec.rebuild2.pass;
  } catch (e) {
    rec.error = String(e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e);
    rec.sliceFail = true;
  }
  rec.repro = {
    dests: geom.dests,
    draftPts: geom.draft,
    opts: { mergeAlign: 4, mergeType: 0, w: 2, z: 0, startTarget: null, endTarget: null },
    steps: 'commitPlainRoad(each dest) -> commitMergeDraft(opts) -> rebuildOnce -> rebuildOnce',
  };
  results.push(rec);
}

import { writeFileSync } from 'node:fs';
writeFileSync(new URL('./sweep-rebuild-pass.out.json', import.meta.url),
  JSON.stringify(results, null, 1));
// compact console summary
for (const r of results) {
  const line = (st) => st
    ? `${st.pass ? 'PASS' : 'FAIL'}${st.failures?.length ? ' [' + st.failures.map((f) => `${f.inv}:${f.deviation}`).join(',') + ']' : ''}`
    : 'ERR';
  console.log(
    `${r.cell.padEnd(14)} first=${line(r.firstCommit)}  R1=${line(r.rebuild1)}  R2=${line(r.rebuild2)}` +
    (r.drift ? `  drift=${JSON.stringify(r.drift)}` : '') + (r.error ? `  ERROR=${r.error}` : ''));
}
