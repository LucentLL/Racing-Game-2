/**
 * H1278: guard probe for the firing-character wobble (idle lope / warble).
 *
 * Static half — who lopes, and is every depth inside the car's own safe
 * pitch window (the H1273/H1274 wrong-note law: rateMul × (1 ± depth) must
 * stay clampless). Dynamic half — drive the REAL sampleEngine on a stubbed
 * WebAudio clock and prove the wobble (a) oscillates at the rpm-locked
 * frequency, (b) fades out above fadeTop, (c) is identity for a no-lope car.
 *
 * Bundle first:
 *   npx esbuild tools/audiolab/voiceentry.ts --bundle --alias:@=./src \
 *     --format=esm --outfile=tools/audiolab/voiceentry.mjs
 * Then: node tools/audiolab/lopecheck.mjs
 */

globalThis.Path2D = class {
  moveTo() {} lineTo() {} closePath() {} arc() {} rect() {}
  quadraticCurveTo() {} bezierCurveTo() {} addPath() {} ellipse() {} arcTo() {}
};

let NOW = 0;
class Param {
  constructor(v) { this.v0 = v; this.target = v; this.t0 = 0; this.tc = 0; }
  get value() {
    if (this.tc <= 0) return this.target;
    return this.target + (this.v0 - this.target) * Math.exp(-(NOW - this.t0) / this.tc);
  }
  set value(v) { this.v0 = v; this.target = v; this.tc = 0; this.t0 = NOW; }
  setTargetAtTime(target, t, tc) { this.v0 = this.value; this.t0 = Math.max(NOW, t); this.target = target; this.tc = tc; }
}
globalThis.setTimeout = (fn) => 0;
class GainNode { constructor() { this.gain = new Param(1); } connect() {} }
class BufferSource {
  constructor() { this.buffer = null; this.loop = false; this.playbackRate = new Param(1); }
  connect() {} start() {} stop() {}
}
class Biquad { constructor() { this.type = ''; this.frequency = new Param(0); this.Q = new Param(1); this.gain = new Param(0); } connect() {} }
const ctx = {
  get currentTime() { return NOW; },
  createGain: () => new GainNode(),
  createBufferSource: () => new BufferSource(),
  createBiquadFilter: () => new Biquad(),
};

const M = await import('./voiceentry.mjs');
const {
  audio, updateFamilySample, stopFamilySample, _sampleInternals,
  CAR_CATALOG, computeEngineVoice, safeRateWindow, familyMedianCc, carVoiceCc,
  resolveEngineFamily,
} = M;
audio.audioCtx = ctx;
audio.sfxGain = new GainNode();

let fail = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) fail++;
};

/** The exact call the game makes (gameLoop _engineVoiceFor). */
function voiceOf(c) {
  return computeEngineVoice({
    id: c.id, name: c.name, redline: c.redline, hp: c.hp,
    weight: c.kg, aspiration: c.asp, idleRPM: c.idleRPM,
    cc: carVoiceCc(c.name, c.eType),
    familyMedianCc: familyMedianCc(resolveEngineFamily(c)),
    eType: c.eType, modelYear: c.modelYear,
  });
}

const cars = Object.values(CAR_CATALOG);

// --- 1. CENSUS + WINDOW SAFETY ---------------------------------------------
{
  const byClass = new Map();
  const bad = [];
  let loped = 0;
  for (const c of cars) {
    const v = voiceOf(c);
    if (!v.lope) continue;
    loped++;
    const key = (c.eType || '?').toUpperCase().split(' ')[0];
    byClass.set(key, (byClass.get(key) ?? 0) + 1);
    const [lo, hi] = safeRateWindow(c.redline, c.idleRPM);
    if (v.rateMul * (1 + v.lope.depth) > hi + 1e-9 || v.rateMul * (1 - v.lope.depth) < lo - 1e-9) {
      bad.push(`${c.name} depth ${v.lope.depth.toFixed(4)} escapes [${lo.toFixed(3)}, ${hi.toFixed(3)}]`);
    }
    if (v.lope.depth > 0.035) bad.push(`${c.name} depth ${v.lope.depth.toFixed(4)} > 0.035`);
  }
  const census = [...byClass.entries()].map(([k, n]) => `${k}:${n}`).join(' ');
  console.log(`loping cars: ${loped}/380  (${census})`);
  check('lope depth never escapes the safe pitch window', bad.length === 0,
    bad.length ? bad.slice(0, 3).join('; ') : `${loped} cars checked`);
  check('the expected engine classes lope',
    (byClass.get('V8') ?? 0) >= 15 && (byClass.get('L5') ?? 0) >= 1 && (byClass.get('BOXER4') ?? 0) >= 3,
    census);
  check('even-fire engines stay clean',
    !cars.some((c) => (c.eType || '').startsWith('L4 (DOHC)') && voiceOf(c).lope),
    'no L4 DOHC lopes');
}

// --- 2. DYNAMIC: the wobble oscillates at the rpm-locked frequency ---------
const NAMES = ['idle', 'idle_low', 'low', 'low_med', 'med', 'med_high', 'high', 'very_high', 'maxRPM'];
const FRACS = [0, 0.10, 0.22, 0.35, 0.48, 0.62, 0.75, 0.88, 1];
_sampleInternals.installTestFamily('probe', NAMES.map((name, i) => {
  const on = { id: `${name}_on`, frac: FRACS[i] };
  const single = i === 0 || i === NAMES.length - 1;
  return { frac: FRACS[i], on, off: single ? on : { id: `${name}_off`, frac: FRACS[i] } };
}));

const DT = 1 / 120;   // fine steps so zero-crossing counting is exact
const LOPE = { depth: 0.02, order: 0.5, fadeTop: 2600, phase: 0 };
const VOICE = { rateMul: 1, peakHz: 600, peakDb: 0, shelfDb: 0, levelMul: 1, turboKit: 'kit1', lope: LOPE };

function measureWobble(rpm, seconds, voice) {
  const samples = [];
  for (let f = 0; f * DT < seconds; f++) {
    NOW += DT;
    const rn = (rpm - 800) / (7000 - 800);
    updateFamilySample('probe', true, rpm, 800, 7000, rn, 0.5, 0, voice);
    samples.push(_sampleInternals.lopeWobble());
  }
  let crossings = 0;
  for (let i = 1; i < samples.length; i++) {
    if ((samples[i - 1] - 1) <= 0 !== (samples[i] - 1) <= 0) crossings++;
  }
  const amp = (Math.max(...samples) - Math.min(...samples)) / 2;
  return { freq: crossings / 2 / seconds, amp };
}

stopFamilySample();
{
  // 900 rpm, order 0.5 -> expected 7.5 Hz.
  const r = measureWobble(900, 4, VOICE);
  check('wobble frequency is rpm-locked (900 rpm × 0.5/rev = 7.5 Hz)',
    Math.abs(r.freq - 7.5) < 0.6, `measured ${r.freq.toFixed(2)} Hz`);
  check('wobble amplitude near idle ≈ depth',
    r.amp > 0.012 && r.amp <= 0.021, `amp ${r.amp.toFixed(4)} (depth 0.02)`);
}
{
  // Above fadeTop the wobble must be gone.
  const r = measureWobble(3200, 2, VOICE);
  check('wobble fades out above fadeTop', r.amp < 0.0005, `amp ${r.amp.toFixed(5)} at 3200 rpm`);
}
{
  // A voice with no lope is bit-identical to pre-H1278: multiplier exactly 1.
  const r = measureWobble(900, 2, { ...VOICE, lope: undefined });
  check('no-lope car has an identity wobble', r.amp === 0,
    `amp ${r.amp} — even-fire engines untouched`);
}

console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILURE(S)`);
process.exit(fail === 0 ? 0 : 1);
