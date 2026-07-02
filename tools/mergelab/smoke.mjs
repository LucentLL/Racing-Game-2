// mergelab/smoke.mjs — two must-pass cases for the probe foundation.
import {
  mkWorld, commitPlainRoad, commitMergeDraft, buildPolygon,
  checkInvariants, injectRow, overlayRowPts, rebuildOnce, profileFor,
} from './probe.mjs';

const out = {};

// ---------------------------------------------------------------- case A
// alongside-straight align-4 lane on a w=6 road (lane WEST of road).
// Drawn just inside the stripe — the commit's outboard clamp
// (_clampOutboardOfBond) lands the smoothed line exactly ON the
// destination's outer-edge stripe, the canonical accel-lane draw.
{
  const state = mkWorld();
  const road = commitPlainRoad(state, [[600, 560], [600, 640]], 6, 'DestV');
  const lane = commitMergeDraft(state, {
    pts: [[598.0, 575], [598.0, 600], [598.0, 625]],
    mergeAlign: 4, mergeType: 0,
  });
  const poly = buildPolygon(state, lane.idx);
  const res = checkInvariants(poly, lane.row, lane.props, state);
  // I6: resample to 4 knots -> re-commit (real Rebuild Roads recipe,
  // editor/rebuild.ts sampleKnots(pts,4)) -> re-check I1/I2/I5.
  const rb = rebuildOnce(state, lane.idx);
  const poly2 = buildPolygon(state, rb.idx);
  const res2 = checkInvariants(poly2, rb.row, rb.props, state, { only: ['I1', 'I2', 'I5'] });
  out.smokeA = {
    pass: res.pass, // first-commit gate: I1-I5
    committedPts: overlayRowPts(lane.row).length,
    laneCentered: lane.props.laneCentered === true,
    bondInnerStart: lane.props.bondInnerStart ?? null,
    bondInnerEnd: lane.props.bondInnerEnd ?? null,
    invariants: res.stats,
    failures: res.failures,
    // Reported, NOT gated: HEAD genuinely re-applies the H967 lane-center
    // shift to already-shifted drive-path knots on rebuild (see
    // diag_drift.mjs: rendered inner edge 2.483 -> 3.22 -> 3.91 -> 4.86
    // over 3 rebuilds). Real defect, not loosened away.
    rebuild_I6: { pass: res2.pass, invariants: res2.stats, failures: res2.failures },
  };
  void road;
}

// ---------------------------------------------------------------- case B
// user's real exported connector row (laneCentered), verbatim.
{
  const state = mkWorld();
  injectRow(state, [6, 1, 'DestV', 0,
    1048.11, 902.21, 1047.76, 971.93]);
  injectRow(state, [6, 1, 'DestH', 0,
    993.44, 986.08, 1112.52, 986.44]);
  const row = [2, 0, 'New Road', 0, 4,
    1045.41, 950.87, 1045.11, 953.52, 1044.82, 956.18, 1044.73, 958.84,
    1044.72, 961.49, 1044.71, 962.99, 1044.70, 964.47, 1044.70, 965.90,
    1044.47, 967.26, 1044.05, 968.63, 1043.53, 969.99, 1042.93, 971.31,
    1042.23, 972.58, 1041.46, 973.82, 1040.61, 974.99, 1039.68, 976.11,
    1038.69, 977.17, 1037.62, 978.16, 1036.49, 979.08, 1035.31, 979.92,
    1034.07, 980.68, 1032.79, 981.36, 1031.46, 981.96, 1030.10, 982.46,
    1028.73, 982.88, 1027.37, 983.09, 1025.94, 983.09, 1024.45, 983.08,
    1022.96, 983.08, 1020.05, 983.07, 1017.14, 983.06, 1014.24, 983.07,
    1011.33, 983.37, 1008.42, 983.67];
  const props = { bondInnerStart: [1, 0], bondInnerEnd: [0, 1], laneCentered: true };
  const idx = injectRow(state, row, props);
  const poly = buildPolygon(state, idx);
  const res = checkInvariants(poly, row, props, state, { only: ['I1', 'I2', 'I5'] });
  const all = checkInvariants(poly, row, props, state); // informational full run
  out.smokeB = {
    pass: res.pass,
    bondedStart: poly?.meta.bondedS?.name ?? null,
    bondedEnd: poly?.meta.bondedE?.name ?? null,
    invariants: res.stats,
    failures: res.failures,
    fullRunInformational: { pass: all.pass, failures: all.failures },
  };
  void profileFor;
}

console.log(JSON.stringify(out, null, 2));
