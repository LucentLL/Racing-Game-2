// mergelab/sweep-std-auto.mjs — audit slice: mergeType 0 (Std), mergeAlign 4
// (Auto), NO explicit targets. Classes A/B/C/D, both sides, w = 6/8/12.
import {
  mkWorld, commitPlainRoad, commitMergeDraft, buildPolygon,
  checkInvariants, rebuildOnce, profileFor,
} from './probe.mjs';

const LANE_W = 1.275;
const r2 = (x) => Math.round(x * 100) / 100;
const rp = (pts) => pts.map(([x, y]) => [r2(x), r2(y)]);

// ------------------------------------------------------------- generators
// A alongside-straight: vertical dest, 3-pt lane ~1.6 off the stripe,
// tips angled toward the road ends (bow) so both ends bond.
function cellsA(w) {
  const stripe = (profileFor(w).laneCount * LANE_W) / 2;
  return [-1, 1].map((side) => {
    const off = (d) => 600 + side * (stripe + d);
    return {
      id: `A-w${w}-${side < 0 ? 'W' : 'E'}`, cls: 'A',
      side: side < 0 ? 'west' : 'east', w,
      dests: [{ pts: [[600, 560], [600, 640]], w, name: 'DestV' }],
      draft: [[off(0.7), 575], [off(1.6), 600], [off(0.7), 625]],
    };
  });
}

// B connector-90: vertical V + horizontal H ~30 tiles apart; 4-pt lane from
// alongside-V curving to alongside-H (inside corner), both handednesses.
// Tips drawn just INSIDE the stripe (canonical draw; commit clamp lands them
// on the stripe).
function cellsB(w) {
  const s = profileFor(w).totalW / 2 - 0.3;
  return [1, -1].map((hand) => {
    const x0 = 600 + hand * s;
    const yE = 640 - s;
    return {
      id: `B-w${w}-${hand > 0 ? 'R' : 'L'}`, cls: 'B',
      side: hand > 0 ? 'right(E)' : 'left(W)', w,
      dests: [
        { pts: [[600, 540], [600, 610]], w, name: 'DestV' },
        { pts: hand > 0 ? [[590, 640], [680, 640]] : [[520, 640], [610, 640]], w, name: 'DestH' },
      ],
      draft: [
        [x0, 600],
        [x0 + hand * 1.5, 622],
        [600 + hand * 14, yE - 3],
        [600 + hand * 35, yE],
      ],
    };
  });
}

// C connector-45: vertical V + 45-degree diagonal D; lane connects them on
// the inside. Both handednesses.
function cellsC(w) {
  const s = profileFor(w).totalW / 2 - 0.3;
  const u = Math.SQRT1_2;
  return [1, -1].map((hand) => {
    const bStart = [600 + hand * 20, 618];
    const bEnd = [600 + hand * 70, 668];
    // foot 40% along D; perp toward the V-side of D
    const foot = [600 + hand * 40, 638];
    const end = [foot[0] - hand * u * s, foot[1] + u * s];
    return {
      id: `C-w${w}-${hand > 0 ? 'R' : 'L'}`, cls: 'C',
      side: hand > 0 ? 'right(E)' : 'left(W)', w,
      dests: [
        { pts: [[600, 540], [600, 600]], w, name: 'DestV' },
        { pts: [bStart, bEnd], w, name: 'DestD' },
      ],
      draft: [
        [600 + hand * s, 585],
        [600 + hand * (s + 3), 608],
        [600 + hand * 19, 626],
        end,
      ],
    };
  });
}

// D ramp-one-end: single dest; start ~14 tiles off centerline (open ground,
// > STANDARD_SEARCH_R 8 so it must NOT bond), end ON the road.
function cellsD(w) {
  return [-1, 1].map((side) => ({
    id: `D-w${w}-${side < 0 ? 'W' : 'E'}`, cls: 'D',
    side: side < 0 ? 'west' : 'east', w,
    dests: [{ pts: [[600, 560], [600, 640]], w, name: 'DestV' }],
    draft: [[600 + side * 14, 578], [600 + side * 8, 595], [600, 610]],
  }));
}

// ------------------------------------------------------------------ runner
const cells = [];
for (const w of [6, 8, 12]) {
  cells.push(...cellsA(w), ...cellsB(w), ...cellsC(w), ...cellsD(w));
}

const results = [];
for (const cell of cells) {
  const rec = { id: cell.id, cls: cell.cls, side: cell.side, w: cell.w };
  try {
    const state = mkWorld();
    for (const d of cell.dests) commitPlainRoad(state, d.pts, d.w, d.name);
    const lane = commitMergeDraft(state, {
      pts: cell.draft, mergeAlign: 4, mergeType: 0,
      startTarget: null, endTarget: null,
    });
    const poly = buildPolygon(state, lane.idx);
    const res = checkInvariants(poly, lane.row, lane.props, state);
    rec.bondedS = poly?.meta.bondedS?.name ?? null;
    rec.bondedE = poly?.meta.bondedE?.name ?? null;
    rec.laneCentered = lane.props.laneCentered === true;
    rec.first = { pass: res.pass, failures: res.failures, stats: res.stats };
    // class-D wiring check: start must be unbonded
    if (cell.cls === 'D' && rec.bondedS !== null) {
      rec.harnessWarn = `D start unexpectedly bonded to ${rec.bondedS}`;
    }
    // I6 rebuild-stability: resample->recommit (Rebuild Roads), recheck I1/I2/I5
    try {
      const rb = rebuildOnce(state, lane.idx);
      const poly2 = buildPolygon(state, rb.idx);
      const res2 = checkInvariants(poly2, rb.row, rb.props, state, { only: ['I1', 'I2', 'I5'] });
      rec.i6 = {
        pass: res2.pass, failures: res2.failures,
        stats: {
          I1_start: res2.stats.I1_start ?? null, I1_end: res2.stats.I1_end ?? null,
          I2: res2.stats.I2 ?? null, I5: res2.stats.I5 ?? null,
        },
      };
    } catch (e) {
      rec.i6 = { pass: false, error: String(e && e.message || e) };
    }
    rec.repro = {
      dests: cell.dests.map((d) => ({ pts: rp(d.pts), w: d.w })),
      draft: { pts: rp(cell.draft), w: 2, z: 0, mergeAlign: 4, mergeType: 0, startTarget: null, endTarget: null },
    };
  } catch (e) {
    rec.error = String(e && e.stack || e);
  }
  results.push(rec);
}

// ------------------------------------------------------------------ report
const failures = [];
for (const r of results) {
  const invs = [];
  if (r.error) invs.push({ inv: 'HARNESS', deviation: NaN, detail: r.error.slice(0, 300) });
  if (r.first && !r.first.pass) {
    for (const f of r.first.failures) invs.push({ inv: f.inv, deviation: f.deviation, detail: f.detail });
  }
  if (r.i6 && !r.i6.pass) {
    if (r.i6.error) invs.push({ inv: 'I6', deviation: NaN, detail: r.i6.error.slice(0, 200) });
    for (const f of (r.i6.failures ?? [])) invs.push({ inv: `I6(${f.inv})`, deviation: f.deviation, detail: f.detail });
  }
  if (r.harnessWarn) invs.push({ inv: 'HARNESS', deviation: NaN, detail: r.harnessWarn });
  if (invs.length) {
    failures.push({ cell: r.id, cls: r.cls, side: r.side, w: r.w, bonded: [r.bondedS, r.bondedE], invariants: invs, repro: r.repro });
  }
}

const summary = results.map((r) => ({
  cell: r.id,
  firstPass: r.first ? r.first.pass : false,
  i6Pass: r.i6 ? r.i6.pass : false,
  bonded: [r.bondedS ?? null, r.bondedE ?? null],
  I1s: r.first?.stats?.I1_start?.deviation ?? null,
  I1e: r.first?.stats?.I1_end?.deviation ?? null,
  I2: r.first?.stats?.I2?.worstBandExcess ?? null,
  I3: r.first?.stats?.I3?.properIntersections ?? null,
  I4: r.first?.stats?.I4?.maxVertexDistFromPolyline ?? null,
  I5: r.first?.stats?.I5 ? [r.first.stats.I5.minWidth, r.first.stats.I5.maxWidth] : null,
  i6_I2: r.i6?.stats?.I2?.worstBandExcess ?? null,
}));

console.log(JSON.stringify({
  slice: 'std-auto',
  cellsRun: results.length,
  cellsFailedFirstCommit: results.filter((r) => !r.first || !r.first.pass).length,
  cellsFailedI6: results.filter((r) => !r.i6 || !r.i6.pass).length,
  summary,
  failures,
}, null, 1));
