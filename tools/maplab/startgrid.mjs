// H1267: render every race venue's PAINTED start/finish line + starting-grid
// boxes to SVG, and assert the paint lands on the racing surface.
//
// Project rule: world geometry is verified by rendering it and looking, not by
// reading numbers. This dumps the exact same DecalQuads that render/startGrid
// bakes into Path2Ds — one generator, so what the SVG shows is what the game
// draws. It exists because the thing it replaces (H1249's "Starting grid")
// passed a geometry check that asserted the grid was BESIDE the track, which is
// precisely why the user could never find it.
//
// Usage: node tools/maplab/startgrid.mjs [outDir]

import fs from 'node:fs';
import path from 'node:path';

// worldMap builds cached Path2Ds at module init; node has no canvas. A stub is
// enough — the harness never fills anything, it only reads geometry.
if (typeof globalThis.Path2D === 'undefined') {
  globalThis.Path2D = class Path2D {
    moveTo() {} lineTo() {} closePath() {} arc() {} rect() {} quadraticCurveTo() {}
    bezierCurveTo() {} addPath() {} ellipse() {} arcTo() {}
  };
}

const M = await import('./maplab.mjs');
const {
  TILE, WPX_PER_M, listMaps, getMapDef, setActiveMapId, rebuildRenderEntries,
  trackEntryFor, trackPathFor, startLineOn, arcOfTile, buildStartDecals,
  asphaltHalfPx, EDGE_MARGIN, START_GRID,
} = M;

const outDir = process.argv[2] ?? '.tmp_geom';
fs.mkdirSync(outDir, { recursive: true });

let fail = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) fail++;
};

/** Distance (world px) from a point to a TrackPath's centerline. */
function distToPath(p, x, y) {
  const m = p.cum.length;
  let best = Infinity;
  const last = p.closed ? m : m - 1;
  for (let i = 0; i < last; i++) {
    const j = (i + 1) % m;
    const ax = p.pts[i * 2], ay = p.pts[i * 2 + 1];
    const dx = p.pts[j * 2] - ax, dy = p.pts[j * 2 + 1] - ay;
    const len2 = dx * dx + dy * dy;
    if (len2 < 1e-9) continue;
    let t = ((x - ax) * dx + (y - ay) * dy) / len2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const d = Math.hypot(ax + dx * t - x, ay + dy * t - y);
    if (d < best) best = d;
  }
  return best;
}

const INK = { white: '#eeeeea', dark: '#141416', yellow: '#d6b228' };

function writeSvg(file, title, pathObj, groups, hw, sLine) {
  // Frame the START group generously — that is the thing under review.
  const g0 = groups[0];
  const PAD = 26 * TILE;
  const minX = g0.cx - PAD, minY = g0.cy - PAD, W = PAD * 2, H = PAD * 2;
  const out = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX} ${minY} ${W} ${H}" width="900" height="900">`);
  out.push(`<rect x="${minX}" y="${minY}" width="${W}" height="${H}" fill="#3c5a3c"/>`);
  // Pavement: the centerline stroked at the true painted width.
  const d = [];
  for (let i = 0; i < pathObj.cum.length; i++) {
    d.push(`${i === 0 ? 'M' : 'L'}${pathObj.pts[i * 2].toFixed(1)},${pathObj.pts[i * 2 + 1].toFixed(1)}`);
  }
  if (pathObj.closed) d.push('Z');
  out.push(`<path d="${d.join(' ')}" fill="none" stroke="#43403e" stroke-width="${(hw + EDGE_MARGIN) * 2}" stroke-linecap="butt"/>`);
  out.push(`<path d="${d.join(' ')}" fill="none" stroke="#5a5a58" stroke-width="0.8" stroke-dasharray="6 6"/>`);
  // The decals themselves.
  for (const g of groups) {
    for (const q of g.quads) {
      const pts = [];
      for (let i = 0; i < 8; i += 2) pts.push(`${q.pts[i].toFixed(2)},${q.pts[i + 1].toFixed(2)}`);
      out.push(`<polygon points="${pts.join(' ')}" fill="${INK[q.ink]}"/>`);
    }
  }
  out.push(`<text x="${minX + 8}" y="${minY + 20}" font-family="monospace" font-size="14" fill="#fff">${title}</text>`);
  out.push('</svg>');
  fs.writeFileSync(path.join(outDir, file), out.join('\n'));
  console.log(`  wrote ${path.join(outDir, file)}`);
}

for (const def of listMaps()) {
  const spec = def.race;
  if (!spec) continue;
  setActiveMapId(def.id);
  rebuildRenderEntries();
  const entry = trackEntryFor(def);
  const p = trackPathFor(def);
  if (!entry || !p) { check(`${def.id}: resolves a track path`, false, 'no entry/path'); continue; }
  const hw = asphaltHalfPx(String(entry.row[2] ?? ''), entry.row[0]) - EDGE_MARGIN;
  const groups = buildStartDecals(def, p, hw);
  const { s: sLine, fwd } = startLineOn(p, def, spec);

  check(`${def.id}: emits paint`, groups.length > 0 && groups[0].quads.length > 0,
    `${groups.length} group(s), ${groups.reduce((n, g) => n + g.quads.length, 0)} quads`);
  if (!groups.length) continue;

  // THE assertion H1249 got backwards: every painted corner must be ON the
  // pavement, i.e. within the painted half-width of the centerline.
  let worst = 0;
  for (const g of groups) {
    for (const q of g.quads) {
      for (let i = 0; i < 8; i += 2) {
        worst = Math.max(worst, distToPath(p, q.pts[i], q.pts[i + 1]));
      }
    }
  }
  check(`${def.id}: all paint is ON the racing surface`, worst <= hw + EDGE_MARGIN + 0.6,
    `furthest corner ${worst.toFixed(1)} px from centerline (pavement half ${(hw + EDGE_MARGIN).toFixed(1)})`);

  // Grid boxes must sit BEHIND the line in the driving direction.
  if (spec.kind !== 'sprint') {
    const slot = spec.kind === 'drag' ? START_GRID.dragSlot(0) : START_GRID.gridSlot(0);
    const poleS = sLine - fwd * slot.backT * TILE;
    const wrap = (v) => (p.closed ? ((v % p.total) + p.total) % p.total : v);
    let back = wrap(sLine) - wrap(poleS);
    if (p.closed && back > p.total / 2) back -= p.total;
    if (p.closed && back < -p.total / 2) back += p.total;
    check(`${def.id}: pole box is behind the line`, fwd * back > 0,
      `${(fwd * back / TILE).toFixed(2)} tiles back (want +${slot.backT})`);
  }

  // Drag: the checkered finish must be a true quarter mile down the strip.
  if (spec.kind === 'drag' && groups.length > 1) {
    const want = (spec.meters ?? 402) * WPX_PER_M;
    const got = Math.hypot(groups[1].cx - groups[0].cx, groups[1].cy - groups[0].cy);
    check(`${def.id}: finish band is ${spec.meters ?? 402} m out`, Math.abs(got - want) < TILE,
      `${(got / WPX_PER_M).toFixed(1)} m`);
    // And it must agree with the sim's finish (trackRace.dragFinishY).
    const simY = (spec.startTile[1] + 0.5) * TILE + want;
    check(`${def.id}: painted finish == sim finish`, Math.abs(groups[1].cy - simY) < 1.0,
      `paint y ${groups[1].cy.toFixed(1)} vs sim y ${simY.toFixed(1)}`);
  }

  writeSvg(`startgrid_${def.id}.svg`, `${def.name} — start/finish + grid`, p, groups, hw, sLine);
}

console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILURE(S)`);
process.exit(fail === 0 ? 0 : 1);
