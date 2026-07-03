// Stage 1 acceptance matrix for the constructive connector (ROADSPEC §4).
// Rebuild bundle first:
//   npx esbuild src/editor/merge/connector.ts --bundle --format=esm --outfile=tools/mergelab/connector.mjs
// Run: node tools/mergelab/builder_matrix.mjs
import { buildConnectorPath } from './connector.mjs';
import { writeFileSync } from 'node:fs';

const deg = (a) => (a * Math.PI) / 180;
const dirOf = (a) => [Math.cos(a), Math.sin(a)];

function checks(res, src, dst) {
  const f = [];
  const P = res.pts;
  const d0 = Math.hypot(P[0][0] - src.pt[0], P[0][1] - src.pt[1]);
  const d1 = Math.hypot(P[P.length - 1][0] - dst.pt[0], P[P.length - 1][1] - dst.pt[1]);
  if (d0 > 1e-6) f.push(`tip0 off ${d0.toFixed(4)}`);
  if (d1 > 1e-6) f.push(`tip1 off ${d1.toFixed(4)}`);
  const t0 = [P[1][0] - P[0][0], P[1][1] - P[0][1]];
  const l0 = Math.hypot(...t0);
  if ((t0[0] * src.dir[0] + t0[1] * src.dir[1]) / l0 < 0.995) f.push('start tangent off');
  const tn = [P[P.length - 1][0] - P[P.length - 2][0], P[P.length - 1][1] - P[P.length - 2][1]];
  const ln_ = Math.hypot(...tn);
  if ((tn[0] * dst.dir[0] + tn[1] * dst.dir[1]) / ln_ < 0.995) f.push('end tangent off');
  let maxTurn = 0;
  for (let i = 1; i + 1 < P.length; i++) {
    const a = Math.atan2(P[i][1] - P[i - 1][1], P[i][0] - P[i - 1][0]);
    const b = Math.atan2(P[i + 1][1] - P[i][1], P[i + 1][0] - P[i][0]);
    let dl = Math.abs(b - a) * 180 / Math.PI;
    if (dl > 180) dl = 360 - dl;
    maxTurn = Math.max(maxTurn, dl);
  }
  if (maxTurn > 30) f.push(`maxTurn ${maxTurn.toFixed(1)}deg`);
  let xings = 0;
  for (let i = 0; i + 1 < P.length; i++) {
    for (let j = i + 2; j + 1 < P.length; j++) {
      if (i === 0 && j + 2 === P.length) continue;
      const [a, b, c, d] = [P[i], P[i + 1], P[j], P[j + 1]];
      const den = (b[0]-a[0])*(d[1]-c[1]) - (b[1]-a[1])*(d[0]-c[0]);
      if (Math.abs(den) < 1e-12) continue;
      const t = ((c[0]-a[0])*(d[1]-c[1]) - (c[1]-a[1])*(d[0]-c[0])) / den;
      const u = ((c[0]-a[0])*(b[1]-a[1]) - (c[1]-a[1])*(b[0]-a[0])) / den;
      if (t > 0.001 && t < 0.999 && u > 0.001 && u < 0.999) xings++;
    }
  }
  if (xings > 0) f.push(`selfX ${xings}`);
  // radius floor: hard fail only when the builder DIDN'T flag it —
  // flagged belowFloor is the tight-quarters contract (warning ring).
  if (res.minRadius < 2.6 && !res.belowFloor) f.push(`radius ${res.minRadius.toFixed(2)} unflagged`);
  return { f, maxTurn, xings };
}

const cells = [];
for (const headingDeg of [0, 45, 90, 135, 180, 225, 270, 315]) {
  for (const placeDeg of [0, 45, 90, 135, 180, 225, 270, 315]) {
    for (const dist of [14, 30]) {
      cells.push({ headingDeg, placeDeg, dist });
    }
  }
}
const results = [];
let pass = 0, nulls = 0, behind = 0;
for (const c of cells) {
  const src = { pt: [500, 500], dir: [1, 0] };
  const dst = {
    pt: [500 + Math.cos(deg(c.placeDeg)) * c.dist, 500 + Math.sin(deg(c.placeDeg)) * c.dist],
    dir: dirOf(deg(c.headingDeg)),
  };
  const res = buildConnectorPath(src, dst, {});
  const isBehind = Math.cos(deg(c.placeDeg)) < -0.3; // dst placed behind src
  if (!res) {
    nulls++;
    if (isBehind) behind++;
    results.push({ ...c, verdict: 'null', behind: isBehind });
    continue;
  }
  const { f, maxTurn, xings } = checks(res, src, dst);
  if (f.length === 0) { pass++; results.push({ ...c, verdict: res.belowFloor ? 'PASS-tight' : 'PASS', kind: res.kind, replans: res.replans }); }
  else results.push({ ...c, verdict: 'FAIL', fails: f, kind: res.kind, minR: +res.minRadius.toFixed(2), behind: isBehind });
}
const fails = results.filter(r => r.verdict === 'FAIL');
const failsAhead = fails.filter(r => !r.behind);
writeFileSync(new URL('./builder_matrix_results.json', import.meta.url), JSON.stringify(results, null, 1));
console.log(JSON.stringify({
  cells: cells.length, pass, fail: fails.length, failAheadOnly: failsAhead.length,
  nulls, nullsBehind: behind,
  failSummary: failsAhead.slice(0, 12),
}, null, 1));
