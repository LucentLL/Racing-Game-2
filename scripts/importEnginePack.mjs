/**
 * H1268: import the Skril "RealisticEngineSound" pack into public/audio/engines/.
 *
 * The pack ships 50 recorded engine families as ~336 MB of pack-root (exterior)
 * WAV, of which the nine RPM bands this importer takes are 262 MB. That cannot
 * ship: GitHub LFS gives 1 GB of storage on the free plan and the repo is
 * already 211 MB, and a browser would have to pull it over the wire. Vorbis q6
 * (~192 kbps) takes the bands to 30.8 MB (11.8%) at a bitrate transparent for
 * this material, and Vorbis is GAPLESS — which matters more than the bitrate
 * here, because every one of these files is played on a looping
 * AudioBufferSourceNode and MP3/AAC encoder padding would put a click at every
 * loop point.
 *
 * The SOURCE is not format-uniform: most files are 44.1 kHz / 16-bit / stereo,
 * but the pack also contains 24-bit, 32-bit-float @ 48 kHz and a couple of mono
 * takes (i4_Japanese_1's on-throttle band set is the 48 kHz one). ffmpeg copes
 * and the output keeps the source rate; Web Audio's decodeAudioData resamples to
 * the context rate on decode, so a family with mixed-rate bands still crossfades
 * correctly. Nothing to fix — but do not assume uniformity when changing this.
 *
 * Ogg Vorbis is safe for every target this game actually ships to: Tauri/Steam
 * is WebView2 (Chromium), Play Store is Capacitor (Android WebView, Chromium),
 * and the test build is Chrome/Edge. There is no iOS target (capacitor.config.ts
 * declares android only). If iOS is ever added, re-run this with a second AAC
 * pass and give the manifest per-family alternates.
 *
 * Usage:
 *   node scripts/importEnginePack.mjs            # import every engine family
 *   node scripts/importEnginePack.mjs --dry      # report what it would do
 *   node scripts/importEnginePack.mjs V8_German i6_Japanese_1   # named only
 *
 * Re-running is safe and incremental: a band whose .ogg is newer than its .wav
 * is skipped, so adding one family does not re-encode the other 42.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const PACK = 'sfx/RealisticEngineSound/Assets/Sounds';
const OUT = 'public/audio/engines';
const MANIFEST = path.join(OUT, 'manifest.json');
/** Vorbis quality. 6 ≈ 192 kbps stereo. Raising this is cheap in code and
 *  expensive in LFS quota — measure before changing it. */
const QUALITY = 6;

/** The band layout sampleEngine.BAND_FRACS understands. `pair` bands have an
 *  ON-throttle and an OFF-throttle take (that is the load axis); `single` bands
 *  have one take that serves both. Anything else in the pack (startup,
 *  engine_stop, aggressiveness_*, intake_*) is deliberately NOT imported — it
 *  is not wired yet and would be dead weight in the deploy. */
const BANDS = [
  { name: 'idle', kind: 'single' },
  { name: 'idle_low', kind: 'pair' },
  { name: 'low', kind: 'pair' },
  { name: 'low_med', kind: 'pair' },
  { name: 'med', kind: 'pair' },
  { name: 'med_high', kind: 'pair' },
  { name: 'high', kind: 'pair' },
  { name: 'very_high', kind: 'pair' },
  { name: 'maxRPM', kind: 'single' },
];

/** Directories under Sounds/ that are shared SFX, not engine families. */
const NOT_ENGINES = new Set([
  'Gearbox', 'Intake', 'Muffler', 'Reversing', 'Shifting', 'Skids',
  'Supercharger', 'Turbo', 'Valves', 'Wind_Sounds',
]);

function findFfmpeg() {
  const candidates = [
    'ffmpeg',
    'C:/Users/mcgee/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-8.1.1-full_build/bin/ffmpeg.exe',
  ];
  for (const c of candidates) {
    try {
      execFileSync(c, ['-version'], { stdio: 'ignore' });
      return c;
    } catch { /* try the next */ }
  }
  throw new Error('ffmpeg not found - install it or add it to PATH');
}

/** Pack dir name -> manifest key / output dir. Lowercased so URLs are
 *  case-stable across the case-insensitive dev filesystem and the
 *  case-SENSITIVE GitHub Pages host (a mismatch there is a silent 404). */
const slug = (dir) => dir.toLowerCase();

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const only = args.filter((a) => !a.startsWith('--'));

const ffmpeg = dry ? null : findFfmpeg();
fs.mkdirSync(OUT, { recursive: true });

const all = fs.readdirSync(PACK, { withFileTypes: true })
  .filter((d) => d.isDirectory() && !NOT_ENGINES.has(d.name))
  .map((d) => d.name)
  .filter((n) => fs.existsSync(path.join(PACK, n, 'idle.wav')))
  .filter((n) => only.length === 0 || only.includes(n))
  .sort();

console.log(`${all.length} engine famil${all.length === 1 ? 'y' : 'ies'} to import (Vorbis q${QUALITY})`);

let srcBytes = 0;
let outBytes = 0;
let encoded = 0;
let skipped = 0;
const families = {};

for (const fam of all) {
  const srcDir = path.join(PACK, fam);
  const key = slug(fam);
  const dstDir = path.join(OUT, key);
  const bands = {};
  const missing = [];

  for (const band of BANDS) {
    // A 'pair' band degrades to a 'single' when the pack only shipped one take,
    // and a 'single' band can still turn up as a pair - never assume the layout.
    const takes = band.kind === 'pair'
      ? [['on', `${band.name}_on.wav`], ['off', `${band.name}_off.wav`]]
      : [['single', `${band.name}.wav`]];
    const present = takes.filter(([, f]) => fs.existsSync(path.join(srcDir, f)));
    if (present.length === 0) {
      const solo = path.join(srcDir, `${band.name}.wav`);
      if (band.kind === 'pair' && fs.existsSync(solo)) {
        present.push(['single', `${band.name}.wav`]);
      } else {
        missing.push(band.name);
        continue;
      }
    }
    const entry = {};
    for (const [role, file] of present) {
      const src = path.join(srcDir, file);
      const outName = file.replace(/\.wav$/i, '.ogg');
      const dst = path.join(dstDir, outName);
      srcBytes += fs.statSync(src).size;
      const fresh = fs.existsSync(dst)
        && fs.statSync(dst).mtimeMs >= fs.statSync(src).mtimeMs;
      if (!dry) {
        if (fresh) {
          skipped++;
        } else {
          fs.mkdirSync(dstDir, { recursive: true });
          execFileSync(ffmpeg, [
            '-v', 'error', '-y', '-i', src,
            '-c:a', 'libvorbis', '-q:a', String(QUALITY),
            dst,
          ]);
          encoded++;
        }
        outBytes += fs.statSync(dst).size;
      }
      entry[role] = outName;
    }
    bands[band.name] = entry;
  }

  // sampleEngine crossfades between two bracketing bands; one band cannot
  // bracket anything, so a family that thin is not usable as a voice.
  if (Object.keys(bands).length < 2) {
    console.log(`  SKIP ${fam} - only ${Object.keys(bands).length} usable band(s)`);
    continue;
  }
  families[key] = { dir: key, _pack: fam, bands };
  const note = missing.length ? `  (no ${missing.join(', ')})` : '';
  console.log(`  ${fam} -> ${key}: ${Object.keys(bands).length} bands${note}`);
}

if (dry) {
  console.log(`\nDRY RUN - ${srcBytes / 1e6 | 0} MB of source WAV across ${Object.keys(families).length} families`);
  process.exit(0);
}

// Merge into the existing manifest rather than overwriting it: the pre-H1268
// "i4" family is a DIFFERENT (earlier, already-shipped, already-ear-tested)
// purchase whose WAVs are not in this pack, and hand-authored _readme /
// _source notes elsewhere in the file should survive a re-import.
let manifest = { families: {} };
if (fs.existsSync(MANIFEST)) {
  try {
    manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  } catch (e) {
    console.warn('existing manifest unreadable, starting fresh:', e.message);
  }
}
manifest.families = { ...(manifest.families ?? {}), ...families };
manifest._readme = [
  'H1237/H1268: recorded engine voices per family. Bands are named RPM tiers',
  '(idle, idle_low, low, low_med, med, med_high, high, very_high, maxRPM);',
  'the two bands bracketing current RPM crossfade, and each band\'s on/off',
  'takes crossfade by throttle. A band is {on,off} for a load pair or',
  '{single} when one take covers both.',
  '',
  'GENERATED by scripts/importEnginePack.mjs from the Skril Studio',
  'RealisticEngineSound pack (Pro Licence) - re-run it rather than hand-editing',
  'the family entries. Families are loaded LAZILY: nothing is fetched until a',
  'car that resolves to that family is driven (config/cars/engineFamily.ts).',
  'A car whose family is absent or still loading keeps the pulse-synth voice.',
];
fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');

console.log(`\nencoded ${encoded}, reused ${skipped}`);
console.log(`${(srcBytes / 1e6).toFixed(0)} MB WAV -> ${(outBytes / 1e6).toFixed(1)} MB Ogg`
  + ` (${(100 * outBytes / Math.max(1, srcBytes)).toFixed(1)}%)`);
console.log(`${Object.keys(manifest.families).length} families in ${MANIFEST}`);
