// H1243: render each circuit's centerline + generated pit paddock to SVG so the
// geometry can be LOOKED AT before it is trusted (project rule: verify editor /
// world geometry by rendering, not by reading numbers).
//
// Usage: node tools/maplab/paddock.mjs [outDir]
import fs from 'node:fs';
import path from 'node:path';
import { REAL_TRACKS, buildPitPaddock, getMapDef, _weGarageRect } from './maplab.mjs';

const outDir = process.argv[2] ?? '.tmp_geom';
fs.mkdirSync(outDir, { recursive: true });

let fail = 0;
const check = (l, ok, d) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}${d ? '  ' + d : ''}`);
  if (!ok) fail++;
};

/** Min distance (tiles) from a point to the track centerline. */
function distToTrack(points, x, y) {
  let best = Infinity;
  for (let i = 0; i + 1 < points.length; i += 2) {
    const d = (points[i] - x) ** 2 + (points[i + 1] - y) ** 2;
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

for (const t of REAL_TRACKS) {
  const pit = buildPitPaddock(t.startTile, t.points);
  const lotPts = pit.lots[0].slice(5);
  const exitPts = pit.lots[1].slice(5);
  const bays = pit.buildings.map((b) => b.slice(2));

  // --- assertions -------------------------------------------------------
  // The race surface is w=6 (~5 tiles); nothing in the paddock may sit on it.
  const TRACK_HALF = 2.6;
  let minAny = Infinity;
  for (const poly of [lotPts, ...bays]) {
    for (let i = 0; i + 1 < poly.length; i += 2) {
      minAny = Math.min(minAny, distToTrack(t.points, poly[i], poly[i + 1]));
    }
  }
  check(`${t.id}: paddock clears the race surface`, minAny > TRACK_HALF,
    `nearest corner ${minAny.toFixed(2)} tiles from centerline (need > ${TRACK_HALF})`);

  // Every bay must produce a garage notch, or driving in does nothing.
  let notches = 0;
  for (const b of bays) {
    const corners = [];
    for (let i = 0; i + 1 < b.length; i += 2) corners.push([b[i], b[i + 1]]);
    if (_weGarageRect(corners, 1)) notches++;
  }
  check(`${t.id}: every bay carves a garage notch`, notches === bays.length,
    `${notches}/${bays.length}`);

  // The map def must expose the pit anchor, and it must be off-track.
  const def = getMapDef(t.id);
  const dPit = def.pitTile ? distToTrack(t.points, def.pitTile[0], def.pitTile[1]) : -1;
  check(`${t.id}: MapDef exposes an off-track pitTile`,
    !!def.pitTile && dPit > TRACK_HALF, `pitTile=${JSON.stringify(def.pitTile)} d=${dPit.toFixed(2)}`);

  // The paddock must actually be reachable from the track — an apron 50 tiles
  // away would be "clear" but useless.
  check(`${t.id}: paddock is adjacent, not stranded`, minAny < 20,
    `nearest ${minAny.toFixed(2)} tiles`);

  // The pit-exit lane has the opposite job: it must REACH the track without
  // overwriting it (the lot stamp is a hard tile write).
  let exitMin = Infinity;
  for (let i = 0; i + 1 < exitPts.length; i += 2) {
    exitMin = Math.min(exitMin, distToTrack(t.points, exitPts[i], exitPts[i + 1]));
  }
  check(`${t.id}: pit exit reaches the track without overwriting it`,
    exitMin > TRACK_HALF && exitMin < 5,
    `closest ${exitMin.toFixed(2)} tiles (want ${TRACK_HALF} < d < 5)`);

  // --- render -----------------------------------------------------------
  const all = [...t.points];
  for (const poly of [lotPts, exitPts, ...bays]) all.push(...poly);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i + 1 < all.length; i += 2) {
    minX = Math.min(minX, all[i]); maxX = Math.max(maxX, all[i]);
    minY = Math.min(minY, all[i + 1]); maxY = Math.max(maxY, all[i + 1]);
  }
  // DETAIL view: frame the paddock (plus margin), not the whole circuit — a
  // full-lap view renders the bays a couple of pixels tall, which is useless
  // for judging whether the geometry is right.
  minX = Infinity; minY = Infinity; maxX = -Infinity; maxY = -Infinity;
  for (const poly of [lotPts, exitPts, ...bays]) {
    for (let i = 0; i + 1 < poly.length; i += 2) {
      minX = Math.min(minX, poly[i]); maxX = Math.max(maxX, poly[i]);
      minY = Math.min(minY, poly[i + 1]); maxY = Math.max(maxY, poly[i + 1]);
    }
  }
  const pad = 26;
  minX -= pad; minY -= pad; maxX += pad; maxY += pad;
  // Square it off so nothing is squashed.
  const side = Math.max(maxX - minX, maxY - minY);
  const mx = (minX + maxX) / 2, my = (minY + maxY) / 2;
  minX = mx - side / 2; maxX = mx + side / 2;
  minY = my - side / 2; maxY = my + side / 2;
  const W = maxX - minX, H = maxY - minY;
  const poly = (p, fill, stroke, sw) => {
    let d = '';
    for (let i = 0; i + 1 < p.length; i += 2) d += `${i ? 'L' : 'M'}${p[i]},${p[i + 1]} `;
    return `<path d="${d}Z" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`;
  };
  let track = '';
  for (let i = 0; i + 1 < t.points.length; i += 2) {
    track += `${i ? 'L' : 'M'}${t.points[i]},${t.points[i + 1]} `;
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX} ${minY} ${W} ${H}" width="1000">
<rect x="${minX}" y="${minY}" width="${W}" height="${H}" fill="#141a12"/>
<path d="${track}" fill="none" stroke="#666" stroke-width="5.2" stroke-linejoin="round"/>
<path d="${track}" fill="none" stroke="#fff" stroke-width="0.6" stroke-dasharray="2 2"/>
${poly(lotPts, '#3a3a3a', '#8ab', 0.6)}
${poly(exitPts, '#2f3a2f', '#6f6', 0.6)}
${bays.map((b, i) => poly(b, '#5a4632', '#fc8', 0.5)
    + `<text x="${(b[0] + b[4]) / 2}" y="${(b[1] + b[5]) / 2}" font-size="2.4" fill="#ffd" text-anchor="middle">${i + 1}</text>`).join('\n')}
<circle cx="${t.startTile[0]}" cy="${t.startTile[1]}" r="2" fill="none" stroke="#0f0" stroke-width="0.8"/>
<circle cx="${pit.pitTile[0]}" cy="${pit.pitTile[1]}" r="1.6" fill="#0ff"/>
<text x="${minX + 3}" y="${minY + 8}" font-size="6" fill="#fff">${t.name} — pit paddock</text>
</svg>`;
  const file = path.join(outDir, `paddock_${t.id}.svg`);
  fs.writeFileSync(file, svg);
  console.log(`  wrote ${file}`);
}

console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
