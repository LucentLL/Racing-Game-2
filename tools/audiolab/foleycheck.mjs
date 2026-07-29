/**
 * H1286: guard probe for the per-family ignition foley.
 *
 * Manifest half — every shipped family carries startup + engine_stop takes
 * on disk with a sane measured crank length. Model half — the catch-delay
 * formula reproduces the hand-tuned H1238 timing on the i4 reference take
 * and stays floored/offset correctly. Runtime half — playCarEntry cranks
 * the FAMILY take (and returns its own catch delay) when resident, falls
 * back to the generic take + H1238 constants when not.
 *
 * Bundle first:
 *   npx esbuild tools/audiolab/voiceentry.ts --bundle --alias:@=./src \
 *     --format=esm --outfile=tools/audiolab/voiceentry.mjs
 * Then: node tools/audiolab/foleycheck.mjs
 */
import fs from 'node:fs';

globalThis.Path2D = class {
  moveTo() {} lineTo() {} closePath() {} arc() {} rect() {}
  quadraticCurveTo() {} bezierCurveTo() {} addPath() {} ellipse() {} arcTo() {}
};

let NOW = 0;
class Param {
  constructor(v) { this.value = v; }
  setTargetAtTime() {}
  cancelScheduledValues() {}
  setValueAtTime() {}
  linearRampToValueAtTime() {}
}
globalThis.setTimeout = () => 0;
const started = [];
class GainNode { constructor() { this.gain = new Param(1); } connect() {} }
class BufferSource {
  constructor() { this.buffer = null; this.loop = false; this.playbackRate = new Param(1); }
  connect() {}
  start() { started.push(this.buffer); }
  stop() {}
}
const ctx = {
  get currentTime() { return NOW; },
  createGain: () => new GainNode(),
  createBufferSource: () => new BufferSource(),
  createBiquadFilter: () => ({ type: '', frequency: new Param(0), Q: new Param(1), gain: new Param(0), connect() {} }),
};

const M = await import('./voiceentry.mjs');
const {
  audio, playCarEntry, familyCatchDelayMs, _foleyInternals,
  CAR_ENTRY_START_DELAY_MS, RESTART_START_DELAY_MS,
} = M;
audio.audioCtx = ctx;
audio.sfxGain = new GainNode();

let fail = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) fail++;
};

// --- 1. MANIFEST: takes on disk + sane crank lengths -------------------------
{
  const man = JSON.parse(fs.readFileSync('public/audio/engines/manifest.json', 'utf8'));
  let missing = 0, missingFile = 0, badLen = 0, n = 0;
  for (const [key, def] of Object.entries(man.families)) {
    if (!def.foley) { missing++; continue; }
    n++;
    const dir = 'public/audio/engines/' + (def.dir ?? key) + '/';
    for (const f of [def.foley.start, def.foley.stop]) {
      if (!f || !fs.existsSync(dir + f)) missingFile++;
    }
    const s = def.foley.startS;
    if (!(s >= 0.4 && s <= 5)) badLen++;
  }
  // The legacy pre-H1268 'i4' purchase has no pack takes — the one allowed out.
  check('every pack family has ignition foley', missing <= 1, `${missing} without (1 legacy allowed)`);
  check('foley files exist on disk', missingFile === 0, `${missingFile} missing`);
  check('crank lengths sane (0.4-5s)', badLen === 0, `${badLen} out of range (${n} checked)`);
}

// --- 2. MODEL: the catch-delay formula ---------------------------------------
{
  // Calibration point: the i4 reference take is 1.27s and H1238 hand-tuned
  // its bare-restart catch to 950ms. The model must land within a frame or two.
  const i4 = familyCatchDelayMs(1.27, false);
  check('i4 reference lands on the H1238 tuning', Math.abs(i4 - RESTART_START_DELAY_MS) <= 100,
    `${i4}ms vs tuned ${RESTART_START_DELAY_MS}ms`);
  check('doors add their 1s lead-in', familyCatchDelayMs(1.27, true) === i4 + 1000);
  check('tiny takes still read as a crank (floor)', familyCatchDelayMs(0.2, false) >= 300);
  const v12 = familyCatchDelayMs(2.9, false);
  check('long cranks catch later', v12 > i4 + 1000, `${v12}ms`);
}

// --- 3. RUNTIME: family take vs generic fallback ------------------------------
{
  // Unregistered family -> generic constants (the H1238 behaviour).
  started.length = 0;
  const dGeneric = playCarEntry(false, 'no_such_family');
  check('unresident family falls back to the constants', dGeneric === RESTART_START_DELAY_MS,
    `${dGeneric}ms`);
  const dDoors = playCarEntry(true, 'no_such_family');
  check('fallback with doors uses the doors constant', dDoors === CAR_ENTRY_START_DELAY_MS,
    `${dDoors}ms`);

  // Resident family -> its own take + its own delay.
  _foleyInternals.installReady('v8test', 2.4);
  started.length = 0;
  const dFam = playCarEntry(false, 'v8test');
  check('resident family cranks its own take', started.some((b) => b && b.duration === 2.4));
  check('and returns its own catch delay', dFam === familyCatchDelayMs(2.4, false), `${dFam}ms`);
  check('family state readable', _foleyInternals.state('v8test') === 'ready');
}

console.log(fail ? `\nFOLEYCHECK FAIL (${fail})` : '\nFOLEYCHECK OK');
process.exit(fail ? 1 : 0);
