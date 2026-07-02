// sweep-centered-flagloss.mjs — slice: centered-flagloss
// Part 1 (flag-integrity): classes A & B, align 4, w=6 — commit normally
//   (row polyline is lane-center shifted, sidecar laneCentered=true), then
//   rebuild the polygon with the sidecar flag DELETED (simulates a save
//   whose sidecar lost the flag) and report invariant deviations vs the
//   true-flag baseline.
// Part 2 (commit-props verification): every class A-D commit — assert
//   props.laneCentered and bondInnerStart/bondInnerEnd were actually set
//   for each BONDED end.
import {
  mkWorld, commitPlainRoad, commitMergeDraft, buildPolygon,
  checkInvariants, overlayRowPts, distToPolyline,
} from './probe.mjs';

const out = { slice: 'centered-flagloss', cells: [] };

// ---- geometry recipes (empty area x,y in 500..700; dest committed FIRST)
// Class A canonical pass draw (smoke recipe): 2.0 off centerline of a w=6
// vertical road — inside the stripe, commit clamp lands it ON the stripe.
// (The literal "1.6 off the stripe" draw is a KNOWN genuine HEAD I2
// failure per setup notes — using it would contaminate flag-loss deltas.)
function geomA(side) {
  const destV = [[600, 560], [600, 640]];
  const x = side === 'west' ? 598.0 : 602.0;
  return {
    dests: [{ pts: destV, w: 6, name: 'DestV' }],
    draftPts: [[x, 575], [x, 600], [x, 625]],
  };
}
// Class B connector-90: DestV vertical + DestH horizontal 40 tiles below
// V's south end; lane runs alongside V then curves to alongside H.
// handedness 'right' = west of V, right turn, west along north of H;
// handedness 'left'  = east of V, left turn, east along north of H.
function geomB(hand) {
  const destV = [[600, 540], [600, 640]];
  const destH = [[540, 680], [680, 680]];
  const draftPts = hand === 'right'
    ? [[597.5, 600], [597.0, 650], [590, 672], [578, 677.5]]
    : [[602.5, 600], [603.0, 650], [610, 672], [622, 677.5]];
  return {
    dests: [{ pts: destV, w: 6, name: 'DestV' }, { pts: destH, w: 6, name: 'DestH' }],
    draftPts,
  };
}
// Class C connector-45: vertical road + 45-degree diagonal road.
function geomC(hand) {
  const destV = [[600, 540], [600, 620]];
  const destD = [[620, 640], [680, 700]]; // dir (1,1)/sqrt2
  // tips 2.5 perpendicular off each centerline
  const draftPts = hand === 'right'
    ? [[597.5, 600], [598.5, 635], [618, 652], [638.23, 661.77]] // NW side of diagonal
    : [[602.5, 600], [606.0, 632], [624, 646], [641.77, 658.23]]; // SE side of diagonal
  return {
    dests: [{ pts: destV, w: 6, name: 'DestV' }, { pts: destD, w: 6, name: 'DestD' }],
    draftPts,
  };
}
// Class D ramp-one-end: start 10 tiles out in open ground, end ON the road.
function geomD(side) {
  const destV = [[600, 540], [600, 660]];
  const draftPts = side === 'west'
    ? [[590, 580], [593, 596], [599.0, 610]]
    : [[610, 580], [607, 596], [601.0, 610]];
  return { dests: [{ pts: destV, w: 6, name: 'DestV' }], draftPts };
}

function runCommit(geom, mergeAlign = 4, mergeType = 0) {
  const state = mkWorld();
  for (const d of geom.dests) commitPlainRoad(state, d.pts, d.w, d.name);
  const lane = commitMergeDraft(state, {
    pts: geom.draftPts, mergeAlign, mergeType, w: 2, z: 0,
  });
  return { state, lane };
}

function summarize(res) {
  return {
    pass: res.pass,
    I1_start: res.stats.I1_start ?? null,
    I1_end: res.stats.I1_end ?? null,
    I2: res.stats.I2 ?? null,
    I3: res.stats.I3?.properIntersections ?? null,
    I4_max: res.stats.I4?.maxVertexDistFromPolyline ?? null,
    I5: res.stats.I5 ? [res.stats.I5.minWidth, res.stats.I5.maxWidth] : null,
    failures: res.failures,
  };
}

// mean distance of inner-edge vertices (middle 40% by index) to a dest
// centerline — direct outboard-shift metric for alongside runs.
function innerMidDist(poly, destPts) {
  const inner = poly.inner;
  const lo = Math.floor(inner.length * 0.3);
  const hi = Math.ceil(inner.length * 0.7);
  let s = 0; let n = 0;
  for (let i = lo; i < hi; i++) { s += distToPolyline(inner[i], destPts).d; n++; }
  return n ? +(s / n).toFixed(4) : null;
}

// ------------------------------------------------------------ the matrix
const matrix = [
  { cell: 'A-west', cls: 'A', side: 'west', geom: geomA('west'), flagLoss: true, expectBond: ['start', 'end'] },
  { cell: 'A-east', cls: 'A', side: 'east', geom: geomA('east'), flagLoss: true, expectBond: ['start', 'end'] },
  { cell: 'B-right', cls: 'B', side: 'right', geom: geomB('right'), flagLoss: true, expectBond: ['start', 'end'] },
  { cell: 'B-left', cls: 'B', side: 'left', geom: geomB('left'), flagLoss: true, expectBond: ['start', 'end'] },
  { cell: 'C-right', cls: 'C', side: 'right', geom: geomC('right'), flagLoss: false, expectBond: ['start', 'end'] },
  { cell: 'C-left', cls: 'C', side: 'left', geom: geomC('left'), flagLoss: false, expectBond: ['start', 'end'] },
  { cell: 'D-west', cls: 'D', side: 'west', geom: geomD('west'), flagLoss: false, expectBond: ['end'] },
  { cell: 'D-east', cls: 'D', side: 'east', geom: geomD('east'), flagLoss: false, expectBond: ['end'] },
];

for (const m of matrix) {
  const rec = { cell: m.cell, class: m.cls, side: m.side, w: 6, align: 4, type: 0, targets: null };
  try {
    const { state, lane } = runCommit(m.geom);
    const row = lane.row;
    const props = state.overlayRoadProps[String(lane.idx)] ?? {};
    const polyTrue = buildPolygon(state, lane.idx);
    const resTrue = checkInvariants(polyTrue, row, props, state);

    // --- part 2: commit-props verification
    const bondedS = polyTrue?.meta.bondedS?.name ?? null;
    const bondedE = polyTrue?.meta.bondedE?.name ?? null;
    rec.commitProps = {
      laneCentered: props.laneCentered === true,
      bondInnerStart: props.bondInnerStart ?? null,
      bondInnerEnd: props.bondInnerEnd ?? null,
      renderScanBondStart: bondedS,
      renderScanBondEnd: bondedE,
      committedPts: overlayRowPts(row).length,
    };
    const propDefects = [];
    const anyBondExpected = m.expectBond.length > 0;
    if (m.expectBond.includes('start') && !props.bondInnerStart) propDefects.push('bondInnerStart unset for bonded start');
    if (m.expectBond.includes('end') && !props.bondInnerEnd) propDefects.push('bondInnerEnd unset for bonded end');
    if (anyBondExpected && props.laneCentered !== true) propDefects.push('laneCentered unset on bonded standard (mt=0) commit');
    if (m.expectBond.includes('start') && !bondedS) propDefects.push('render bond re-scan found NO start bond (commit-time bond may also have failed)');
    if (m.expectBond.includes('end') && !bondedE) propDefects.push('render bond re-scan found NO end bond');
    rec.propDefects = propDefects;

    rec.baseline = summarize(resTrue);
    rec.baseline.innerMidDistToDest0 = polyTrue ? innerMidDist(polyTrue, m.geom.dests[0].pts) : null;

    // --- part 1: flag loss (classes A & B only)
    if (m.flagLoss) {
      const sc = state.overlayRoadProps[String(lane.idx)];
      const hadFlag = sc && sc.laneCentered === true;
      if (sc) delete sc.laneCentered; // simulate sidecar that lost the flag
      const polyLoss = buildPolygon(state, lane.idx);
      const resLoss = checkInvariants(polyLoss, row, sc ?? {}, state);
      rec.flagLoss = {
        rowWasCommittedShifted: hadFlag,
        result: summarize(resLoss),
        innerMidDistToDest0: polyLoss ? innerMidDist(polyLoss, m.geom.dests[0].pts) : null,
      };
      if (polyTrue && polyLoss) {
        rec.flagLoss.innerMidShiftVsTrue = +(
          (rec.flagLoss.innerMidDistToDest0 ?? 0) - (rec.baseline.innerMidDistToDest0 ?? 0)
        ).toFixed(4);
      }
      if (sc && hadFlag) sc.laneCentered = true; // restore
    }

    rec.repro = {
      dests: m.geom.dests,
      draftPts: m.geom.draftPts,
      opts: { mergeAlign: 4, mergeType: 0, w: 2, z: 0, startTarget: null, endTarget: null },
      flagLossStep: m.flagLoss ? 'after commit: delete overlayRoadProps[idx].laneCentered, then buildPolygon' : undefined,
    };
  } catch (e) {
    rec.error = String(e && e.stack ? e.stack : e);
  }
  out.cells.push(rec);
}

console.log(JSON.stringify(out, null, 1));
