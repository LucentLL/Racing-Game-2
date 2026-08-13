// Render an SVG (+PNG via headless Edge) crop of the built candidate network.
//   node tools/osm/crop.mjs <name> <centerTileX> <centerTileY> <sizeTiles>
// Reads fixtures/osm/charlotte_rows.json; writes fixtures/osm/preview/<name>.{svg,png}
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PREV = join(ROOT, 'fixtures', 'osm', 'preview');
const [name = 'crop', cx = '1250', cy = '1250', size = '120'] = process.argv.slice(2);
const S = parseFloat(size);
const vb = [parseFloat(cx) - S / 2, parseFloat(cy) - S / 2, S, S];

const { rows, props, intersections } = JSON.parse(readFileSync(join(ROOT, 'fixtures', 'osm', 'charlotte_rows.json'), 'utf8'));

const CLS_STYLE = {
  motorway: { color: '#c46030', w: 5 }, trunk: { color: '#c88a2e', w: 4 },
  primary: { color: '#b0a032', w: 3 }, secondary: { color: '#7a8a4a', w: 2.2 },
  tertiary: { color: '#8a97a5', w: 1.4 },
};
const scale = Math.min(1, 350 / S);
const parts = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb.join(' ')}" width="1600" height="1600">`,
  `<rect x="${vb[0]}" y="${vb[1]}" width="${vb[2]}" height="${vb[3]}" fill="#10130f"/>`];
const order = ['tertiary', 'secondary', 'primary', 'trunk', 'motorway'];
for (const pass of ['ground', 'bridge']) {
  for (const cls of order) {
    rows.forEach((r, i) => {
      const p = props[i];
      const base = p.class.replace('_link', '');
      if (base !== cls) return;
      if ((pass === 'bridge') !== (r[3] >= 2)) return;
      const link = p.class.endsWith('_link');
      const st = CLS_STYLE[base];
      let d = '';
      for (let k = 4; k < r.length; k += 2) d += (k === 4 ? 'M' : 'L') + r[k] + ' ' + r[k + 1];
      const col = pass === 'bridge' ? '#e0e6ee' : st.color;
      parts.push(`<path d="${d}" fill="none" stroke="${col}" stroke-width="${(link ? st.w * 0.5 : st.w) * scale * 0.2}" stroke-linecap="round" stroke-linejoin="round" opacity="${link ? 0.85 : 0.95}"/>`);
    });
  }
}
for (const r of intersections) {
  const col = r[1] === 4 ? '#4fd070' : r[1] === 2 ? '#e05050' : '#e0c050';
  parts.push(`<circle cx="${r[7]}" cy="${r[8]}" r="${0.35 * Math.max(1, scale)}" fill="${col}"/>`);
}
parts.push('</svg>');
const svgPath = join(PREV, `${name}.svg`);
writeFileSync(svgPath, parts.join('\n'));
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
execFileSync(EDGE, ['--headless=new', '--disable-gpu', `--screenshot=${join(PREV, name + '.png')}`,
  '--window-size=1600,1600', 'file:///' + svgPath.replace(/\\/g, '/')]);
console.log(`wrote ${name}.svg/.png @ center ${cx},${cy} size ${size}`);
