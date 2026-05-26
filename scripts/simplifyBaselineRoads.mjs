// One-shot: rewrite src/config/world/baselineRoads.ts in place, applying
// Ramer-Douglas-Peucker simplification to every road's polyline.
//
// Why: the source polylines have many 1-2-tile staircase vertices left over
// from manual tracing. Centripetal Catmull-Rom smooths them, but the
// per-vertex perpendicular offsets that draw lane stripes / fog lines pick
// up every wobble, producing visible "swirling" and overlap on highways
// 10-12 tiles wide. Collapsing collinear noise with RDP eps=2 keeps the
// overall route while removing the high-frequency jitter.
//
// Endpoints are preserved exactly so cross-road connection points (handled
// in src/world/roadGraph.ts findConnectingRoad) keep matching.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FILE = resolve(__dirname, '../src/config/world/baselineRoads.ts');
const EPSILON = 2.0;

/** Perpendicular distance from p to the line through a,b. */
function perpDist(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  return Math.abs(dy * p[0] - dx * p[1] + b[0] * a[1] - b[1] * a[0]) / len;
}

/** Ramer-Douglas-Peucker. Returns a new array; preserves first + last. */
function rdp(points, eps) {
  if (points.length < 3) return points.slice();
  let maxD = 0;
  let maxI = 0;
  const a = points[0];
  const b = points[points.length - 1];
  for (let i = 1; i < points.length - 1; i++) {
    const d = perpDist(points[i], a, b);
    if (d > maxD) { maxD = d; maxI = i; }
  }
  if (maxD > eps) {
    const left = rdp(points.slice(0, maxI + 1), eps);
    const right = rdp(points.slice(maxI), eps);
    return left.slice(0, -1).concat(right);
  }
  return [a, b];
}

/** Process one row line. Returns the rewritten line (without trailing newline). */
function processRow(line) {
  // Match: leading [, then up to the closing ] (which is followed by ,).
  // Anchor on the opening bracket position.
  const open = line.indexOf('[');
  if (open < 0) return line;
  const close = line.lastIndexOf(']');
  if (close < 0 || close < open) return line;
  const inner = line.slice(open + 1, close);
  // Find the quoted name. There's exactly one quoted string per row.
  const nameMatch = inner.match(/^\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*("[^"]*")\s*,\s*(-?\d+)\s*,(.*)$/);
  if (!nameMatch) return line;
  const w = nameMatch[1];
  const maj = nameMatch[2];
  const name = nameMatch[3];
  const z = nameMatch[4];
  const numsStr = nameMatch[5];
  const nums = numsStr.split(',').map((s) => s.trim()).filter(Boolean).map(Number);
  if (nums.some((n) => !Number.isFinite(n))) return line;
  if (nums.length < 4 || nums.length % 2 !== 0) return line;
  const pts = [];
  for (let i = 0; i + 1 < nums.length; i += 2) pts.push([nums[i], nums[i + 1]]);
  const simplified = rdp(pts, EPSILON);
  const flat = simplified.flatMap((p) => [Math.round(p[0]), Math.round(p[1])]);
  const head = line.slice(0, open);
  const tail = line.slice(close + 1);
  return `${head}[${w},${maj},${name},${z},${flat.join(',')}]${tail}`;
}

const src = readFileSync(FILE, 'utf8');
const lines = src.split(/\r?\n/);
let touched = 0;
let beforeTotal = 0;
let afterTotal = 0;
const out = lines.map((line) => {
  const trimmed = line.trim();
  if (!trimmed.startsWith('[')) return line;
  const nextLine = processRow(line);
  if (nextLine !== line) {
    touched++;
    const oldNums = (line.match(/,/g) || []).length + 1 - 4; // approx coord count
    const newNums = (nextLine.match(/,/g) || []).length + 1 - 4;
    beforeTotal += Math.max(0, oldNums);
    afterTotal += Math.max(0, newNums);
  }
  return nextLine;
});
writeFileSync(FILE, out.join('\n'), 'utf8');
console.log(`simplified ${touched} rows; coord count ${beforeTotal} -> ${afterTotal} (${(100 * (1 - afterTotal / beforeTotal)).toFixed(1)}% reduction)`);
