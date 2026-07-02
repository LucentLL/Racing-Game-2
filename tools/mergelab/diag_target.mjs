// diag: explicit BondTarget (lane-click) end — I2' path.
// D-class ramp: starts 9 tiles out in open ground, ends ON the road,
// endTarget = lane 1, west side (side by dest tangent (0,+1): +1 = west?
// side sign: alignDir for side +1 is (-tdy, tdx) = (-1, 0) for tangent
// (0,1) -> west. Lane drawn from the west -> side +1.
import {
  mkWorld, commitPlainRoad, commitMergeDraft, buildPolygon, checkInvariants,
} from './probe.mjs';

const state = mkWorld();
commitPlainRoad(state, [[600, 560], [600, 640]], 6, 'DestV');
// roadIdx 0 in liveRoads (only road committed so far); segIdx 0.
const endTarget = { roadIdx: 0, segIdx: 0, side: 1, laneIdx: 1 };
const lane = commitMergeDraft(state, {
  pts: [[591, 580], [594, 595], [598.5, 610]],
  mergeAlign: 4, mergeType: 0, endTarget,
});
const poly = buildPolygon(state, lane.idx);
const res = checkInvariants(poly, lane.row, lane.props, state, { endTarget });
console.log(JSON.stringify({
  laneCentered: lane.props.laneCentered === true,
  pass: res.pass, stats: res.stats, failures: res.failures,
}, null, 2));
