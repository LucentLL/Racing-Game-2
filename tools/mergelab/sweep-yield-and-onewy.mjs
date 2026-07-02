// mergelab/sweep-yield-and-onewy.mjs — audit slice:
//   mergeType 3 (Yield) align 4, classes A/B, both sides, dest w=6
//   + dest ONE-WAY (w=2) classes A/D, both sides, mt 0 and mt 3 spots
// 10 cells. Class-A draws use the canonical inside-stripe recipe (smoke A):
// the outboard-drawn (stripe+1.6) first-commit I2 failure is a KNOWN,
// already-reported HEAD behavior (setup notes) and would mask slice-specific
// defects if used here.
import {
  mkWorld, commitPlainRoad, commitMergeDraft, buildPolygon,
  checkInvariants, rebuildOnce, overlayRowPts,
} from './probe.mjs';

// ---- geometry generators (empty area x,y ~ 560..700) --------------------

// class A: vertical dest road, alongside lane drawn just inside the stripe
// (commit clamp lands it ON the stripe — canonical accel-lane draw).
function classA({ destW, side, drawOff }) {
  // side: -1 = WEST of road, +1 = EAST
  const x = 600 + side * drawOff;
  return {
    dests: [{ pts: [[600, 560], [600, 640]], w: destW, name: 'DestV' }],
    pts: [[x, 575], [x, 600], [x, 625]],
  };
}

// class B: connector-90 — DestV vertical + DestH horizontal ~30 tiles apart,
// 4-pt lane from alongside-V curving to alongside-H.
function classB({ destW, hand }) {
  // hand +1: lane WEST of V curving WEST along H's north side (right turn
  //          for southbound traffic); hand -1: mirrored EAST/east-bound.
  const dests = [
    { pts: [[600, 560], [600, 610]], w: destW, name: 'DestV' },
    { pts: [[570, 640], [650, 640]], w: destW, name: 'DestH' },
  ];
  const pts = hand > 0
    ? [[597.5, 595], [595, 620], [585, 634], [578, 637.5]]
    : [[602.5, 595], [605, 620], [615, 634], [622, 637.5]];
  return { dests, pts };
}

// class D: ramp-one-end — single dest road, start 9 tiles out in open
// ground, END lands on the road (only END bonds). Tip 0.3 off the
// centerline = realistic on-road click; EXACTLY-on-centerline is a
// separate degenerate edge case (perpSigned===0, see diag_D_onewy.mjs).
function classD({ destW, side }) {
  const x0 = 600 + side * 9;
  return {
    dests: [{ pts: [[600, 560], [600, 640]], w: destW, name: 'DestV' }],
    pts: [[x0, 585], [600 + side * 5, 592], [600 + side * 0.3, 600]],
  };
}

// ------------------------------------------------------------------ cells
const CELLS = [
  { id: 'Y-A-W6-west', cls: 'A', side: 'west', destW: 6, ma: 4, mt: 3,
    geo: classA({ destW: 6, side: -1, drawOff: 2.0 }) },
  { id: 'Y-A-W6-east', cls: 'A', side: 'east', destW: 6, ma: 4, mt: 3,
    geo: classA({ destW: 6, side: +1, drawOff: 2.0 }) },
  { id: 'Y-B-W6-RH', cls: 'B', side: 'west/right-turn', destW: 6, ma: 4, mt: 3,
    geo: classB({ destW: 6, hand: +1 }) },
  { id: 'Y-B-W6-LH', cls: 'B', side: 'east/left-turn', destW: 6, ma: 4, mt: 3,
    geo: classB({ destW: 6, hand: -1 }) },
  // one-way dest (w=2 => lps 1, laneCount 1, totalW 1.275, stripe 0.6375)
  { id: 'OW-A-west', cls: 'A', side: 'west', destW: 2, ma: 4, mt: 0,
    geo: classA({ destW: 2, side: -1, drawOff: 0.5 }) },
  { id: 'OW-A-east', cls: 'A', side: 'east', destW: 2, ma: 4, mt: 0,
    geo: classA({ destW: 2, side: +1, drawOff: 0.5 }) },
  { id: 'OW-D-west', cls: 'D', side: 'west', destW: 2, ma: 4, mt: 0,
    geo: classD({ destW: 2, side: -1 }) },
  { id: 'OW-D-east', cls: 'D', side: 'east', destW: 2, ma: 4, mt: 0,
    geo: classD({ destW: 2, side: +1 }) },
  { id: 'OW-A-west-Y', cls: 'A', side: 'west', destW: 2, ma: 4, mt: 3,
    geo: classA({ destW: 2, side: -1, drawOff: 0.5 }) },
  { id: 'OW-D-east-Y', cls: 'D', side: 'east', destW: 2, ma: 4, mt: 3,
    geo: classD({ destW: 2, side: +1 }) },
];

// ------------------------------------------------------------------- run
const results = [];
for (const cell of CELLS) {
  const r = { cell: cell.id, cls: cell.cls, side: cell.side, destW: cell.destW,
    ma: cell.ma, mt: cell.mt, targets: null };
  try {
    const state = mkWorld();
    for (const d of cell.geo.dests) commitPlainRoad(state, d.pts, d.w, d.name);
    const lane = commitMergeDraft(state, {
      pts: cell.geo.pts, mergeAlign: cell.ma, mergeType: cell.mt,
      startTarget: null, endTarget: null,
    });
    const poly = buildPolygon(state, lane.idx);
    const res = checkInvariants(poly, lane.row, lane.props, state);
    r.committedPts = overlayRowPts(lane.row).length;
    r.laneCentered = lane.props.laneCentered === true;
    r.bonded = [poly?.meta.bondedS?.name ?? null, poly?.meta.bondedE?.name ?? null];
    r.firstCommit = { pass: res.pass, failures: res.failures, stats: res.stats };
    // I6 — rebuild-stability (real Rebuild Roads recipe), re-check I1/I2/I5
    try {
      const rb = rebuildOnce(state, lane.idx);
      const poly2 = buildPolygon(state, rb.idx);
      const res2 = checkInvariants(poly2, rb.row, rb.props, state,
        { only: ['I1', 'I2', 'I5'] });
      r.I6 = { pass: res2.pass, failures: res2.failures, stats: res2.stats };
    } catch (e) {
      r.I6 = { pass: false, error: String(e && e.stack || e) };
    }
    r.repro = {
      dests: cell.geo.dests.map((d) => ({ pts: d.pts, w: d.w, name: d.name })),
      draftPts: cell.geo.pts,
      opts: { mergeAlign: cell.ma, mergeType: cell.mt, w: 2, z: 0,
        startTarget: null, endTarget: null },
    };
  } catch (e) {
    r.error = String(e && e.stack || e);
  }
  results.push(r);
}
console.log(JSON.stringify(results, null, 1));
