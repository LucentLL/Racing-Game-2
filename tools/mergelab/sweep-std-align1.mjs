// sweep-std-align1.mjs — audit slice: mergeType 0, mergeAlign 1 (C auto /
// symmetric legacy). Classes A (alongside-straight, both-ends bond),
// B (connector-90, both-ends bond), D (ramp-one-end). Both sides, w=6 & w=8.
// No explicit BondTargets in this slice (align-1 is the pre-lane-click path),
// so I2' never applies; I2 itself only gates align 3/4 and is skipped by
// checkInvariants for ma=1 (correct per spec).
import {
  mkWorld, commitPlainRoad, commitMergeDraft, buildPolygon,
  checkInvariants, rebuildOnce, overlayRowPts, distToPolyline,
  profileFor, stripeOf,
} from './probe.mjs';

const ALIGN = 1;
const TYPE = 0;

// stripe offset for a plain dest road of width w
const stripeW = (w) => stripeOf({ w, name: 'D' });

// ------------------------------------------------------------ cell builders
// Each returns { dests: [{pts,w,name}], draftPts }
function cellA(w, side) {
  // vertical dest x=600, y 560..640; lane parallel, drawn 1.6 outside stripe,
  // tips angled 0.8 toward the road so both ends bond (search R = 8).
  const off = stripeW(w) + 1.6;
  const s = side === 'W' ? -1 : 1;
  const xMid = 600 + s * off;
  const xTip = 600 + s * (off - 0.8);
  return {
    dests: [{ pts: [[600, 560], [600, 640]], w, name: 'DestV' }],
    draftPts: [[xTip, 575], [xMid, 600], [xTip, 625]],
  };
}

function cellB(w, hand) {
  // connector between vertical DestV and horizontal DestH ~30 tiles apart.
  // hand 'R': V on the west, lane runs east-of-V down to north-of-H going E.
  // hand 'L': mirrored (V on the east, lane west-of-V down to north-of-H going W).
  const st = stripeW(w);
  if (hand === 'R') {
    const vx = 600;
    const hy = 640;
    return {
      dests: [
        { pts: [[vx, 560], [vx, 610]], w, name: 'DestV' },
        { pts: [[630, hy], [690, hy]], w, name: 'DestH' },
      ],
      draftPts: [
        [vx + st + 1.0, 600],
        [vx + st + 5.5, 622],
        [620, hy - st - 5.5],
        [636, hy - st - 1.0],
      ],
    };
  }
  const vx = 700;
  const hy = 640;
  return {
    dests: [
      { pts: [[vx, 560], [vx, 610]], w, name: 'DestV' },
      { pts: [[610, hy], [670, hy]], w, name: 'DestH' },
    ],
    draftPts: [
      [vx - st - 1.0, 600],
      [vx - st - 5.5, 622],
      [680, hy - st - 5.5],
      [664, hy - st - 1.0],
    ],
  };
}

function cellD(w, side) {
  // single vertical dest; draft starts 10 tiles out in open ground
  // (STANDARD_SEARCH_R = 8, so the start does NOT bond), ends ON the road
  // surface 1.6 off the centerline (align-1 snaps it to a lane center).
  const s = side === 'W' ? -1 : 1;
  return {
    dests: [{ pts: [[600, 560], [600, 640]], w, name: 'DestV' }],
    draftPts: [
      [600 + s * 10, 578],
      [600 + s * 7, 590],
      [600 + s * 1.6, 602],
    ],
  };
}

const CELLS = [];
for (const w of [6, 8]) {
  for (const side of ['W', 'E']) CELLS.push({ id: `A-${side}-w${w}`, cls: 'A', side, w, mk: () => cellA(w, side) });
  for (const hand of ['R', 'L']) CELLS.push({ id: `B-${hand}-w${w}`, cls: 'B', side: hand, w, mk: () => cellB(w, hand) });
  for (const side of ['W', 'E']) CELLS.push({ id: `D-${side}-w${w}`, cls: 'D', side, w, mk: () => cellD(w, side) });
}

// extra diagnostic: drive-path mid-band offset from nearest dest (drift meter)
function midBand(row, dests) {
  const pts = overlayRowPts(row);
  const arc = [0];
  for (let i = 1; i < pts.length; i++) {
    arc.push(arc[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  }
  const total = arc[arc.length - 1] || 1;
  let lo = Infinity; let hi = -Infinity;
  for (let i = 0; i < pts.length; i++) {
    if (arc[i] < 0.3 * total || arc[i] > 0.7 * total) continue;
    let d = Infinity;
    for (const dst of dests) d = Math.min(d, distToPolyline(pts[i], dst.pts).d);
    if (d < lo) lo = d;
    if (d > hi) hi = d;
  }
  return lo === Infinity ? null : [+lo.toFixed(4), +hi.toFixed(4)];
}

const results = [];
for (const cell of CELLS) {
  const spec = cell.mk();
  const state = mkWorld();
  for (const d of spec.dests) commitPlainRoad(state, d.pts, d.w, d.name);
  const lane = commitMergeDraft(state, {
    pts: spec.draftPts, mergeAlign: ALIGN, mergeType: TYPE,
    startTarget: null, endTarget: null, w: 2, z: 0, name: 'Lane',
  });
  const poly = buildPolygon(state, lane.idx);
  const res = checkInvariants(poly, lane.row, lane.props, state, {
    startTarget: null, endTarget: null,
  });

  // I6: real Rebuild-Roads recipe, then re-check I1/I5 (I2 n/a for align 1)
  let i6 = null;
  try {
    const rb = rebuildOnce(state, lane.idx);
    const poly2 = buildPolygon(state, rb.idx);
    const res2 = checkInvariants(poly2, rb.row, rb.props, state, { only: ['I1', 'I2', 'I5'] });
    i6 = {
      pass: res2.pass,
      failures: res2.failures,
      stats: res2.stats,
      drivePathMidBand: midBand(rb.row, spec.dests),
    };
  } catch (e) {
    i6 = { pass: false, error: String(e && e.message || e) };
  }

  results.push({
    cell: cell.id, cls: cell.cls, side: cell.side, w: cell.w,
    firstCommit: {
      pass: res.pass,
      failures: res.failures,
      stats: res.stats,
      committedPts: overlayRowPts(lane.row).length,
      laneCentered: lane.props.laneCentered === true,
      bondedStart: poly?.meta.bondedS?.name ?? null,
      bondedEnd: poly?.meta.bondedE?.name ?? null,
      drivePathMidBand: midBand(lane.row, spec.dests),
    },
    i6,
    repro: {
      dests: spec.dests.map((d) => ({ pts: d.pts, w: d.w, name: d.name })),
      draftPts: spec.draftPts,
      opts: { mergeAlign: ALIGN, mergeType: TYPE, w: 2, z: 0, startTarget: null, endTarget: null },
    },
  });
}

// context numbers for interpreting align-1 deviations
const ctx = {};
for (const w of [6, 8]) {
  const p = profileFor(w);
  ctx[`w${w}`] = {
    totalW: p.totalW, stripe: +stripeW(w).toFixed(4),
    laneCenters: p.centers.map((c) => +c.toFixed(4)),
  };
}

console.log(JSON.stringify({ ctx, results }, null, 1));
