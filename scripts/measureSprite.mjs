// Car-sprite body-size measurer + SPRITE_BUFFER codegen.
//
// THE HARD RULE (enforced here):
//   A sprite's on-road footprint is derived from its solid BODY pixels —
//   alpha-trimmed AND mirror-excluded — never from transparent padding or
//   protruding door-mirrors. We measure the trimmed opaque box (which is
//   mirror-INCLUSIVE) and the true body width (median of the central 60%
//   of length-stations, mirror-EXCLUDED). The buffer width multiplier
//   widthMult = boxWidth / bodyWidth = (1 + ear%/100) pushes the mirror
//   "ears" just OUTSIDE the GT4 length x width rect so the body fills W.
//   GT4 `wid` is the mirrors-excluded body width (ISO 612 sec 6.2), which
//   is exactly what this maps onto.
//
//   - lengthMult is held at 1.000 for every sprite (length needs no
//     correction: trimmed box length already equals body length to <2%).
//   - widthMult is clamped to [1.00, 1.20]. Outside that band the detector
//     mistook real bodywork (flares / a wide-body kit / a halo) for mirrors
//     -> we fall back to 1.000 and WARN the key for hand-tuning.
//   - MOTORCYCLES are exempt: a bike's handlebars ARE its real width and
//     GT4 `wid` is already the handlebar span, so bikes get [1.000, 1.000]
//     (sized by the full mirror-inclusive box). The body-detector is never
//     run on them (it is wrong-signed and numerically unstable on bikes).
//
//   IMPORT QA GATE: any sprite whose measured body-aspect deviates > 6%
//   from its GT4 length/width aspect is flagged — that is mis-proportioned
//   ART that no buffer can fix (it must be redrawn).
//
// USAGE:
//   node scripts/measureSprite.mjs <file.png> [...]   -> JSON measurement
//   node scripts/measureSprite.mjs --emit             -> print regenerated
//        src/config/cars/spriteBuffer.ts to stdout; warnings to stderr.
//        (Review the warnings, then write the file.)
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CARS_DIR = path.join(ROOT, 'public', 'cars');
const MANIFEST_PATH = path.join(ROOT, 'src', 'config', 'cars', 'manifest.ts');
const BUFFER_PATH = path.join(ROOT, 'src', 'config', 'cars', 'spriteBuffer.ts');

const BIKE_KEYS = new Set(['kawasaki_ninja', 'honda_cb500', 'suzuki_bandit', 'suzuki_katana']);
const CLAMP_MIN = 1.00;
const CLAMP_MAX = 1.20;
const QA_DEVIATION_PCT = 6;

/** GT4 length x width (mm) the RENDERER targets per key — from
 *  TRAFFIC_BODY_SIZES (drawTopCar.ts) + a few player-only keys. Used ONLY
 *  for the import QA gate (body-aspect vs spec-aspect). Keys absent here
 *  skip the QA check. */
const GT4_QA_DIMS = {
  sedan: [5017, 1854], civic99: [4439, 1705], accord99: [4813, 1786],
  hatch: [4732, 1950], suv: [4732, 1950], pickup: [5176, 2018],
  cruiser: [5395, 1980], silvia: [4520, 1695], silvia_180sx: [4520, 1695],
  ae86: [4205, 1625], rx7_fc: [4290, 1760], rx7_fd: [4285, 1760],
  gtr_r34: [4600, 1785], gtr_r34_vspec: [4600, 1785], nsx_na: [4405, 1810],
  miata_na: [3950, 1675], dodge_viper: [4488, 1923], plymouth_cuda: [5008, 1880],
  dodge_charger: [5232, 1948], dodge_super_bee: [5232, 1948],
  audi_quattro: [4404, 1723], ruf_btr: [4291, 1652], ruf_ctr_yb: [4291, 1652],
  ruf_ctr2: [4245, 1735], semi: [7556, 2667], semi_truck: [7556, 2667],
  boxtruck: [7333, 2444], box_truck: [7333, 2444], towtruck: [8556, 2600],
};

// ---------------------------------------------------------------- PNG decode
function readChunks(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let off = 8; const chunks = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    chunks.push({ type, data: buf.subarray(off + 8, off + 8 + len) });
    off += 12 + len;
  }
  return chunks;
}
function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}
function decode(buf) {
  const chunks = readChunks(buf);
  const ihdr = chunks.find(c => c.type === 'IHDR').data;
  const width = ihdr.readUInt32BE(0), height = ihdr.readUInt32BE(4);
  const bitDepth = ihdr[8], colorType = ihdr[9], interlace = ihdr[12];
  if (bitDepth !== 8) throw new Error('only 8-bit supported, got ' + bitDepth);
  if (interlace !== 0) throw new Error('interlaced not supported');
  let palette = null, trns = null;
  for (const c of chunks) { if (c.type === 'PLTE') palette = c.data; if (c.type === 'tRNS') trns = c.data; }
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (channels == null) throw new Error('unsupported colorType ' + colorType);
  const raw = zlib.inflateSync(Buffer.concat(chunks.filter(c => c.type === 'IDAT').map(c => c.data)));
  const bpp = channels, stride = width * bpp, out = Buffer.alloc(height * stride);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++], row = raw.subarray(pos, pos + stride); pos += stride;
    const o = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[o + x - bpp] : 0;
      const b = y > 0 ? out[o - stride + x] : 0;
      const c = (x >= bpp && y > 0) ? out[o - stride + x - bpp] : 0;
      let v = row[x];
      switch (filter) {
        case 0: break; case 1: v = (v + a) & 255; break; case 2: v = (v + b) & 255; break;
        case 3: v = (v + ((a + b) >> 1)) & 255; break; case 4: v = (v + paeth(a, b, c)) & 255; break;
        default: throw new Error('bad filter ' + filter);
      }
      out[o + x] = v;
    }
  }
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    let r, g, b, a = 255;
    if (colorType === 6) { r = out[i*4]; g = out[i*4+1]; b = out[i*4+2]; a = out[i*4+3]; }
    else if (colorType === 2) { r = out[i*3]; g = out[i*3+1]; b = out[i*3+2]; }
    else if (colorType === 0) { r = g = b = out[i]; }
    else if (colorType === 4) { r = g = b = out[i*2]; a = out[i*2+1]; }
    else if (colorType === 3) { const idx = out[i]; r = palette[idx*3]; g = palette[idx*3+1]; b = palette[idx*3+2]; a = trns && idx < trns.length ? trns[idx] : 255; }
    rgba[i*4] = r; rgba[i*4+1] = g; rgba[i*4+2] = b; rgba[i*4+3] = a;
  }
  return { width, height, colorType, rgba };
}

// Replicate the game's corner-bg flood fill (engine/sprites.ts, tol 14).
function floodRemoveBg(width, height, px) {
  const w = width, h = height;
  const corners = [[0,0],[w-1,0],[0,h-1],[w-1,h-1]];
  let any = false, sR=0,sG=0,sB=0,n=0;
  for (const [cx,cy] of corners) { const ci=(cy*w+cx)*4; if (px[ci+3]!==0){ any=true; sR+=px[ci]; sG+=px[ci+1]; sB+=px[ci+2]; n++; } }
  if (!any) return;
  const bgR=(sR/n)|0,bgG=(sG/n)|0,bgB=(sB/n)|0,tol=14,stack=[];
  for (const [cx,cy] of corners){ const ci=(cy*w+cx)*4; if(px[ci+3]!==0&&Math.abs(px[ci]-bgR)<=tol&&Math.abs(px[ci+1]-bgG)<=tol&&Math.abs(px[ci+2]-bgB)<=tol) stack.push(cx,cy); }
  while (stack.length) {
    const y=stack.pop(), x=stack.pop();
    if (x<0||y<0||x>=w||y>=h) continue;
    const i=(y*w+x)*4;
    if (px[i+3]===0) continue;
    if (Math.abs(px[i]-bgR)>tol||Math.abs(px[i+1]-bgG)>tol||Math.abs(px[i+2]-bgB)>tol) continue;
    px[i+3]=0; stack.push(x-1,y,x+1,y,x,y-1,x,y+1);
  }
}

// ---------------------------------------------------------------- profiling
function profile(file) {
  const { width, height, rgba } = decode(fs.readFileSync(file));
  floodRemoveBg(width, height, rgba);
  const ALPHA_T = 8;
  let minX=width,minY=height,maxX=-1,maxY=-1;
  for (let y=0;y<height;y++) for (let x=0;x<width;x++) if (rgba[(y*width+x)*4+3]>ALPHA_T){ if(x<minX)minX=x; if(x>maxX)maxX=x; if(y<minY)minY=y; if(y>maxY)maxY=y; }
  const bw=maxX-minX+1, bh=maxY-minY+1, isPortrait = height>width;
  const lengthPx = isPortrait ? bh : bw, widthPx = isPortrait ? bw : bh;
  const widths = [];
  if (isPortrait) { for (let y=minY;y<=maxY;y++){ let lo=width,hi=-1; for(let x=minX;x<=maxX;x++){ if(rgba[(y*width+x)*4+3]>ALPHA_T){ if(x<lo)lo=x; if(x>hi)hi=x; } } widths.push(hi>=lo?hi-lo+1:0); } }
  else { for (let x=minX;x<=maxX;x++){ let lo=height,hi=-1; for(let y=minY;y<=maxY;y++){ if(rgba[(y*width+x)*4+3]>ALPHA_T){ if(y<lo)lo=y; if(y>hi)hi=y; } } widths.push(hi>=lo?hi-lo+1:0); } }
  const sorted=[...widths].sort((a,b)=>a-b), maxWidth=sorted[sorted.length-1];
  const lo=Math.floor(widths.length*0.2), hi=Math.floor(widths.length*0.8);
  const central=[...widths.slice(lo,hi)].sort((a,b)=>a-b);
  const bodyWidth=central[Math.floor(central.length/2)] || maxWidth;
  return {
    file: path.basename(file), full: `${width}x${height}`,
    box: `${bw}x${bh}`, lengthPx, widthPx,
    boxAspect: +(lengthPx/widthPx).toFixed(3),
    bodyWidthPx: bodyWidth,
    bodyAspect: +(lengthPx/bodyWidth).toFixed(3),
    earInflationPct: +(((maxWidth/bodyWidth)-1)*100).toFixed(1),
  };
}

// ---------------------------------------------------------------- manifest
// Parse VEHICLE_IMAGE_MANIFEST: top-level keys are at exactly 2-space indent
// ("  key:"); every '*.png' string literal until the next top-level key
// belongs to that key (covers simple, popup {down,up}, and multi-variant
// entries). New keys are auto-discovered as long as the 2-space convention
// holds.
function parseManifest() {
  const text = fs.readFileSync(MANIFEST_PATH, 'utf8');
  const start = text.indexOf('VEHICLE_IMAGE_MANIFEST');
  const body = start >= 0 ? text.slice(text.indexOf('{', start)) : text;
  const lines = body.split(/\r?\n/);
  const out = [];           // [{ key, files: [...] }] in manifest order
  let cur = null;
  const keyRe = /^  (\w+):/;
  const pngRe = /'([^']+\.png)'/g;
  for (const line of lines) {
    const km = keyRe.exec(line);
    if (km) { cur = { key: km[1], files: [] }; out.push(cur); }
    if (!cur) continue;
    let m; while ((m = pngRe.exec(line))) cur.files.push(decodeURIComponent(m[1]));
  }
  return out.filter(e => e.files.length > 0);
}

// ---------------------------------------------------------------- codegen
function round3(n) { return Math.round(n * 1000) / 1000; }

function emit() {
  const entries = parseManifest();
  const warn = (...a) => console.error('[sprite-buffer]', ...a);
  const rows = [];          // { key, lengthMult, widthMult, note }
  const seenWidth = new Map();

  for (const { key, files } of entries) {
    const measured = [];
    for (const f of files) {
      const p = path.join(CARS_DIR, f);
      if (!fs.existsSync(p)) { warn(`MISSING FILE for "${key}": ${f}`); continue; }
      try { measured.push(profile(p)); }
      catch (e) { warn(`DECODE FAIL "${key}" ${f}: ${e.message}`); }
    }
    if (!measured.length) { warn(`SKIP "${key}" — no measurable files`); continue; }

    if (BIKE_KEYS.has(key)) {
      rows.push({ key, lengthMult: 1.000, widthMult: 1.000, note: 'bike: full box (handlebars = width)' });
      continue;
    }

    const avgEar = measured.reduce((s, m) => s + m.earInflationPct, 0) / measured.length;
    const avgBodyAsp = measured.reduce((s, m) => s + m.bodyAspect, 0) / measured.length;
    let widthMult = round3(1 + avgEar / 100);
    let note = '';
    if (widthMult < CLAMP_MIN) { warn(`CLAMP "${key}" widthMult ${widthMult} < ${CLAMP_MIN} -> 1.000 (detector failed)`); widthMult = 1.000; note = 'clamped (lo)'; }
    else if (widthMult > CLAMP_MAX) { warn(`OUT-OF-BAND "${key}" widthMult ${widthMult} > ${CLAMP_MAX} -> 1.000 + HAND-TUNE (real bodywork mistaken for mirrors?)`); widthMult = 1.000; note = 'FLAGGED: hand-tune'; }
    rows.push({ key, lengthMult: 1.000, widthMult, note });
    seenWidth.set(key, widthMult);

    // Import QA gate — body-aspect vs GT4 spec aspect.
    const gt4 = GT4_QA_DIMS[key];
    if (gt4) {
      const gt4Asp = gt4[0] / gt4[1];
      const dev = (avgBodyAsp / gt4Asp - 1) * 100;
      if (Math.abs(dev) > QA_DEVIATION_PCT)
        warn(`SOURCE-ART "${key}" bodyAsp ${avgBodyAsp.toFixed(3)} vs GT4 ${gt4Asp.toFixed(3)} = ${dev>0?'+':''}${dev.toFixed(1)}% — art drawn wrong shape, buffer cannot fix`);
    }
  }

  const pad = Math.max(...rows.map(r => r.key.length)) + 1;
  const lines = rows.map(r => {
    const k = (r.key + ':').padEnd(pad + 1);
    const tuple = `[${r.lengthMult.toFixed(3)}, ${r.widthMult.toFixed(3)}]`;
    return `  ${k} ${tuple},${r.note ? '  // ' + r.note : ''}`;
  });

  const header = `/**
 * Per-bodytype sprite render-buffer correction. AUTO-GENERATED by
 * scripts/measureSprite.mjs (\`node scripts/measureSprite.mjs --emit\`).
 * DO NOT EDIT BY HAND — re-run the generator after adding/replacing a sprite.
 *
 * THE HARD RULE: a sprite is sized so its solid BODY pixels (alpha-trimmed
 * AND mirror-excluded) fill the GT4 length x width footprint. widthMult =
 * 1 + (mirror ear inflation %), so protruding door-mirrors land just OUTSIDE
 * L x W and the body spans W (= GT4 \`wid\`, which is mirrors-excluded per
 * ISO 612 sec 6.2). lengthMult is always 1.000 (length needs no correction).
 * widthMult is clamped to [${CLAMP_MIN.toFixed(2)}, ${CLAMP_MAX.toFixed(2)}]; out-of-band values fall back to
 * 1.000 and are flagged for hand-tuning. Motorcycles get [1.000, 1.000]
 * (handlebars ARE the width). Collision/physics dims in CAR().size are
 * UNCHANGED — only the drawImage destination rect is scaled.
 *
 * Tuple format: [lengthMultiplier, widthMultiplier].
 */
export const SPRITE_BUFFER: Record<string, readonly [number, number]> = {
${lines.join('\n')}
};

export const SPRITE_CACHE_LONG_AXIS = 512;
`;
  process.stdout.write(header);
}

// ---------------------------------------------------------------- check
// Parse the committed SPRITE_BUFFER so the build can FAIL when a sprite is
// missing an entry or has drifted from its measured body size. LFS-safe:
// a file that exists but won't decode (an un-pulled LFS pointer) is SKIPPED,
// not failed — only a decodable sprite that is missing/drifted is an error.
function parseCommittedBuffer(bufferPath) {
  const text = fs.readFileSync(bufferPath, 'utf8');
  const out = {};
  const re = /^\s*(\w+):\s*\[\s*([\d.]+)\s*,\s*([\d.]+)\s*\]/gm;
  let m; while ((m = re.exec(text))) out[m[1]] = [parseFloat(m[2]), parseFloat(m[3])];
  return out;
}

function check(bufferPath) {
  const entries = parseManifest();
  const committed = parseCommittedBuffer(bufferPath);
  const fails = [], skipped = [], advisories = [];
  let ok = 0;

  for (const { key, files } of entries) {
    // Did any file decode? (missing-on-disk is an error; pointer/corrupt is a skip)
    let decoded = [], missing = false, undecodable = false;
    for (const f of files) {
      const p = path.join(CARS_DIR, f);
      if (!fs.existsSync(p)) { missing = true; continue; }
      try { decoded.push(profile(p)); } catch { undecodable = true; }
    }
    if (missing) { fails.push(`"${key}" -> manifest references a file not in public/cars/`); continue; }
    if (!decoded.length) { skipped.push(`${key} (undecodable — LFS pointer?)`); continue; }

    if (BIKE_KEYS.has(key)) {
      const c = committed[key];
      if (c && (c[1] < 0.999 || c[1] > 1.001)) fails.push(`bike "${key}" should be [1.000, 1.000], committed [${c.join(', ')}]`);
      else ok++;
      continue;
    }

    const avgEar = decoded.reduce((s, m) => s + m.earInflationPct, 0) / decoded.length;
    const raw = 1 + avgEar / 100;
    const c = committed[key];
    if (raw > CLAMP_MAX || raw < CLAMP_MIN) {            // flagged for hand-tune: advisory only
      advisories.push(`${key}: measured ${raw.toFixed(3)} is out of [${CLAMP_MIN},${CLAMP_MAX}] — verify the hand value (committed ${c ? c[1] : 'NONE'})`);
      if (!c) fails.push(`"${key}" has no SPRITE_BUFFER entry`);
      else ok++;
      continue;
    }
    const expected = round3(raw);
    if (!c) { fails.push(`"${key}" has no SPRITE_BUFFER entry (expected width ${expected.toFixed(3)})`); continue; }
    if (Math.abs(c[1] - expected) > 0.005) fails.push(`"${key}" width ${c[1].toFixed(3)} drifted from measured ${expected.toFixed(3)} — sprite changed?`);
    else ok++;
  }

  for (const a of advisories) console.error('[sprites:check] advisory:', a);
  if (skipped.length) console.error(`[sprites:check] skipped ${skipped.length} undecodable (env without LFS?): ${skipped.join(', ')}`);
  if (fails.length) {
    console.error('\n[sprites:check] FAILED — SPRITE_BUFFER is out of sync with the sprites:');
    for (const f of fails) console.error('  • ' + f);
    console.error('\n  Fix: run  npm run sprites:buffer  (regenerates src/config/cars/spriteBuffer.ts), review, commit.\n');
    process.exit(1);
  }
  console.error(`[sprites:check] OK — ${ok} sprite buffers match measured body size${skipped.length ? `, ${skipped.length} skipped` : ''}.`);
}

// ---------------------------------------------------------------- entry
const argv = process.argv.slice(2);
const bufArgIdx = argv.indexOf('--buffer');
const bufferPath = bufArgIdx >= 0 ? path.resolve(argv[bufArgIdx + 1]) : BUFFER_PATH;
if (argv.includes('--check')) {
  check(bufferPath);
} else if (argv.includes('--emit')) {
  emit();
} else {
  const rows = [];
  for (const f of argv) {
    try { rows.push(profile(f)); }
    catch (e) { rows.push({ file: path.basename(f), error: e.message }); }
  }
  console.log(JSON.stringify(rows, null, 2));
}
