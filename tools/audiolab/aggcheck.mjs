/**
 * H1285: guard probe for the overrun/hard-pull crackle (aggressiveness fx).
 *
 * Static half — every car's voice.agg is in [0,1] and STRICTLY rises across
 * the exhaust ladder (an exhaust upgrade must never pop less: the same
 * monotonicity law voicespread enforces for shelf/level). Manifest half —
 * every shipped family carries both fx files on disk plus sane vendor curves.
 * Dynamic half — drive the REAL updateFamilySample on a stubbed WebAudio
 * clock and prove the layers (a) split by load with the OFF layer blooming
 * on a lift, (b) fade toward nothing at low rpm, (c) slow the crackle loop
 * way down at idle per the vendor pitch curve, (d) boost the ON layer at the
 * limiter, (e) go silent on stopFamilySample and never run without agg data.
 *
 * Bundle first:
 *   npx esbuild tools/audiolab/voiceentry.ts --bundle --alias:@=./src \
 *     --format=esm --outfile=tools/audiolab/voiceentry.mjs
 * Then: node tools/audiolab/aggcheck.mjs
 */
import fs from 'node:fs';

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
globalThis.setTimeout = () => 0;
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
  CAR_CATALOG, computeEngineVoice, resolveEngineFamily,
  familyMedianCc, carVoiceCc,
} = M;
audio.audioCtx = ctx;
audio.sfxGain = new GainNode();

let fail = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) fail++;
};

function voiceOf(c, mods) {
  return computeEngineVoice({
    id: c.id, name: c.name, redline: c.redline, hp: c.hp,
    weight: c.kg, aspiration: c.asp, idleRPM: c.idleRPM,
    cc: carVoiceCc(c.name, c.eType),
    familyMedianCc: familyMedianCc(resolveEngineFamily(c)),
    eType: c.eType, modelYear: c.modelYear,
  }, mods);
}

const cars = Object.values(CAR_CATALOG);

// --- 1. STATIC: range + ladder monotonicity ---------------------------------
{
  const RUNGS = [
    {},                                        // stock
    { exhaustLevel: 0.25 },                    // sport
    { exhaustLevel: 0.5 },                     // performance
    { exhaustLevel: 0.75 },                    // race
    { exhaustLevel: 1, straightPipe: true },   // straight
  ];
  let outOfRange = 0;
  let nonMonotonic = 0;
  let stockLoud = 0;
  let minStock = Infinity, maxStock = -Infinity, maxStraight = -Infinity;
  for (const c of cars) {
    const ladder = RUNGS.map((m) => voiceOf(c, m).agg);
    for (const a of ladder) if (!(a >= 0 && a <= 1)) outOfRange++;
    for (let i = 1; i < ladder.length; i++) if (ladder[i] <= ladder[i - 1]) nonMonotonic++;
    if (ladder[0] > 0.3) stockLoud++;
    minStock = Math.min(minStock, ladder[0]);
    maxStock = Math.max(maxStock, ladder[0]);
    maxStraight = Math.max(maxStraight, ladder[4]);
  }
  check('agg in [0,1] for every car x rung', outOfRange === 0, `${outOfRange} out of range`);
  check('exhaust ladder strictly raises agg', nonMonotonic === 0, `${nonMonotonic} inversions`);
  check('stock stays subtle (<= 0.3)', stockLoud === 0, `${stockLoud} loud stock cars`);
  console.log(`      stock span ${minStock.toFixed(3)}..${maxStock.toFixed(3)}, straight max ${maxStraight.toFixed(3)}`);
}

// --- 2. MANIFEST: files on disk + sane vendor curves ------------------------
{
  const man = JSON.parse(fs.readFileSync('public/audio/engines/manifest.json', 'utf8'));
  const fams = Object.entries(man.families);
  let missingAgg = 0, missingFile = 0, badCurve = 0;
  for (const [key, def] of fams) {
    if (!def.agg) { missingAgg++; continue; }
    const dir = 'public/audio/engines/' + (def.dir ?? key) + '/';
    for (const f of [def.agg.on, def.agg.off]) {
      if (!fs.existsSync(dir + f)) missingFile++;
    }
    for (const curve of [def.agg.vol, def.agg.pitch]) {
      if (!curve) continue;
      let prevT = -1;
      for (const [t, v] of curve) {
        if (!(t >= 0 && t <= 1.001) || !(v >= 0 && v <= 2) || t < prevT) badCurve++;
        prevT = t;
      }
    }
  }
  // The legacy pre-H1268 'i4' purchase has no aggressiveness takes — it is the
  // one family allowed to sit this out.
  check('every pack family has agg', missingAgg <= 1, `${missingAgg} without (1 legacy allowed)`);
  check('agg fx files exist on disk', missingFile === 0, `${missingFile} missing`);
  check('vendor curves sane + time-ordered', badCurve === 0, `${badCurve} bad keys`);
}

// --- 3. DYNAMIC: drive the real sampleEngine --------------------------------
{
  const mkBuf = () => ({ duration: 1 });
  const bands = [0, 0.22, 0.48, 0.75, 1].map((frac) => ({ frac, on: mkBuf(), off: mkBuf() }));
  const aggDef = {
    on: 'x.ogg', off: 'y.ogg', master: 0.3,
    vol: [[0, 0.2], [0.8, 1.0], [1, 1.0]],
    pitch: [[0, 0.1], [1, 1.0]],
  };
  _sampleInternals.installTestFamily('aggtest', bands, { def: aggDef, on: mkBuf(), off: mkBuf() });

  const idle = 800, redline = 8000;
  const race = voiceOf(cars.find((c) => /Skyline GT-R V-spec \(R34\)/.test(c.name)) ?? cars[0],
    { exhaustLevel: 1, straightPipe: true });
  const step = (rpm, load, voice, dt = 0.05) => {
    NOW += dt;
    updateFamilySample('aggtest', true, rpm, idle, redline, (rpm - idle) / (redline - idle), load, 0, voice);
  };

  // Warm up at WOT high rpm.
  for (let i = 0; i < 40; i++) step(7000, 1, race);
  const wot = _sampleInternals.aggState();
  check('layers live once decoded', wot.live);
  check('WOT high rpm: ON crackles, OFF near-silent', wot.onG > 0.15 && wot.offG < 0.02,
    `on ${wot.onG.toFixed(3)} off ${wot.offG.toFixed(3)}`);

  // LIFT: same rpm, throttle closed — the overrun bloom.
  for (let i = 0; i < 10; i++) step(6800, 0, race);
  const lift = _sampleInternals.aggState();
  check('lift at high rpm: OFF blooms past ON', lift.offG > 0.15 && lift.offG > lift.onG * 3,
    `off ${lift.offG.toFixed(3)} on ${lift.onG.toFixed(3)}`);
  const rateHigh = lift.rate;

  // Fall to idle, still closed: crackle dies away and slows way down.
  for (let i = 0; i < 40; i++) step(900, 0, race);
  const idleSt = _sampleInternals.aggState();
  check('at idle the crackle is near-silent', idleSt.offG < 0.08 && idleSt.onG < 0.02,
    `off ${idleSt.offG.toFixed(3)}`);
  check('pitch curve slows the loop toward idle', idleSt.rate < rateHigh * 0.35,
    `idle rate ${idleSt.rate.toFixed(2)} vs high ${rateHigh.toFixed(2)}`);

  // Limiter boost: pinned at the very top under throttle vs just below it.
  for (let i = 0; i < 20; i++) step(7400, 1, race);
  const below = _sampleInternals.aggState().onG;
  for (let i = 0; i < 20; i++) step(7990, 1, race);
  const pinned = _sampleInternals.aggState().onG;
  check('limiter pins boost the ON layer', pinned > below * 1.3,
    `pinned ${pinned.toFixed(3)} vs below ${below.toFixed(3)}`);

  // Exhaust rung scales the whole thing: stock vs straight at the same state.
  const stock = voiceOf(cars.find((c) => /Skyline GT-R V-spec \(R34\)/.test(c.name)) ?? cars[0], {});
  for (let i = 0; i < 20; i++) step(6800, 0, stock);
  const stockOff = _sampleInternals.aggState().offG;
  for (let i = 0; i < 20; i++) step(6800, 0, race);
  const raceOff = _sampleInternals.aggState().offG;
  check('straight pipe pops well past stock', raceOff > stockOff * 3,
    `race ${raceOff.toFixed(3)} vs stock ${stockOff.toFixed(3)}`);

  // Stop kills the layers.
  stopFamilySample();
  const stopped = _sampleInternals.aggState();
  check('stopFamilySample silences the layers', !stopped.live && stopped.onG === 0 && stopped.offG === 0);

  // A family with NO agg data never brings the layers up.
  _sampleInternals.installTestFamily('plain', bands);
  for (let i = 0; i < 10; i++) {
    NOW += 0.05;
    updateFamilySample('plain', true, 7000, idle, redline, 0.8, 1, 0, race);
  }
  const plain = _sampleInternals.aggState();
  check('no agg data -> no layers', !plain.live);
  stopFamilySample();
}

console.log(fail ? `\nAGGCHECK FAIL (${fail})` : '\nAGGCHECK OK');
process.exit(fail ? 1 : 0);
