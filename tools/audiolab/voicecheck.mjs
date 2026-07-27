/**
 * H1270: prove the recorded engine voice never plays two copies of the same
 * recording at once.
 *
 * The user reported "two sets of audio playing at once when I drive". The cause
 * was in sampleEngine's band crossfade, not in the choice between voices: the
 * two crossfade slots were bound to POSITION (slot 0 = low band, slot 1 = high
 * band), so every time the rev needle crossed a band edge the loop slot 1 was
 * already playing got torn down and RESTARTED from sample position 0 in slot 0.
 * Two copies of one recording, a few hundred ms out of phase, at equal gain.
 *
 * This drives the REAL sampleEngine against a stubbed WebAudio API and counts,
 * per frame, how many audible sources share a buffer. Anything above one is the
 * bug. Bundle first:
 *   npx esbuild tools/audiolab/voiceentry.ts --bundle --alias:@=./src \
 *     --format=esm --outfile=tools/audiolab/voiceentry.mjs
 * Then: node tools/audiolab/voicecheck.mjs
 */

// ---------------------------------------------------------------------------
// Minimal WebAudio stub. Only what sampleEngine touches, with a virtual clock
// and enough bookkeeping to answer "what is audible right now".
// ---------------------------------------------------------------------------
let NOW = 0;
const live = new Set();

/**
 * AudioParam with REAL setTargetAtTime semantics, and a setTimeout queued
 * against the same virtual clock.
 *
 * This is load-bearing. The first version of this probe settled gains instantly
 * and fired setTimeout immediately, which made stopPlayer() atomic — and
 * stopPlayer is precisely where the overlap lives: it ramps a source down over
 * a 0.06 s time constant and only calls stop() 250 ms later. With an atomic
 * stub the probe reported 0% duplication against the KNOWN-BROKEN code, i.e. it
 * would have passed a bug it was written to catch. Model the decay or the probe
 * is decoration.
 */
class Param {
  constructor(v) { this.v0 = v; this.target = v; this.t0 = 0; this.tc = 0; }
  get value() {
    if (this.tc <= 0) return this.target;
    return this.target + (this.v0 - this.target) * Math.exp(-(NOW - this.t0) / this.tc);
  }
  set value(v) { this.v0 = v; this.target = v; this.tc = 0; this.t0 = NOW; }
  setTargetAtTime(target, t, tc) {
    this.v0 = this.value;
    this.t0 = Math.max(NOW, t);
    this.target = target;
    this.tc = tc;
  }
  setValueAtTime(v) { this.value = v; }
}

const timers = [];
globalThis.setTimeout = (fn, ms = 0) => { timers.push({ at: NOW + ms / 1000, fn }); return 0; };
function runTimers() {
  for (let i = timers.length - 1; i >= 0; i--) {
    if (timers[i].at <= NOW) { const { fn } = timers.splice(i, 1)[0]; fn(); }
  }
}
class GainNode {
  constructor() { this.gain = new Param(1); }
  connect() {} disconnect() {}
}
class BufferSource {
  constructor() {
    this.buffer = null; this.loop = false;
    this.playbackRate = new Param(1);
    this.started = -1; this.stopped = false;
  }
  connect(g) { this.gainNode = g; }
  start() { this.started = NOW; live.add(this); }
  stop() { this.stopped = true; live.delete(this); }
}
class Biquad {
  constructor() {
    this.type = ''; this.frequency = new Param(0);
    this.Q = new Param(1); this.gain = new Param(0);
  }
  connect() {}
}

const ctx = {
  get currentTime() { return NOW; },
  createGain: () => new GainNode(),
  createBufferSource: () => new BufferSource(),
  createBiquadFilter: () => new Biquad(),
};

const M = await import('./voiceentry.mjs');
const { audio, updateFamilySample, stopFamilySample, _sampleInternals } = M;
audio.audioCtx = ctx;
audio.sfxGain = new GainNode();

// ---------------------------------------------------------------------------
// A synthetic family with the pack's real band layout.
// ---------------------------------------------------------------------------
const NAMES = ['idle', 'idle_low', 'low', 'low_med', 'med', 'med_high', 'high', 'very_high', 'maxRPM'];
const FRACS = [0, 0.10, 0.22, 0.35, 0.48, 0.62, 0.75, 0.88, 1];
_sampleInternals.installTestFamily('probe', NAMES.map((name, i) => {
  // idle and maxRPM are single-take in the real pack. The loader signals that
  // by assigning the SAME AudioBuffer object to both band.on and band.off
  // (`if (key === 'single') band.off = decoded`), and startBand keys off
  // `b.off !== b.on` — so the stub must share the reference, not just the id,
  // or it fabricates a second player and reports a doubling that isn't real.
  const on = { id: `${name}_on` };
  const single = i === 0 || i === NAMES.length - 1;
  return { frac: FRACS[i], on, off: single ? on : { id: `${name}_off` } };
}));

let fail = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) fail++;
};

/** Audible sources right now, and the worst same-buffer duplicate pair. */
function sample() {
  const audible = [...live].filter((s) => (s.gainNode?.gain.value ?? 0) > 0.02);
  const byBuf = new Map();
  for (const s of audible) {
    const k = s.buffer?.id ?? '?';
    if (!byBuf.has(k)) byBuf.set(k, []);
    byBuf.get(k).push(s.gainNode.gain.value);
  }
  let dupes = 0;
  let worstRatio = 0;
  for (const gains of byBuf.values()) {
    if (gains.length < 2) continue;
    gains.sort((a, b) => b - a);
    dupes++;
    worstRatio = Math.max(worstRatio, gains[1] / gains[0]);   // 1.0 = equal level
  }
  return { audible: audible.length, created: live.size, dupes, worstRatio };
}

const DT = 1 / 60;
function drive(rpmNormAt, seconds, load = 0.9) {
  let peakAudible = 0, dupeFrames = 0, frames = 0, worstRatio = 0;
  for (let f = 0; f * DT < seconds; f++) {
    NOW += DT;
    runTimers();
    const rn = rpmNormAt(f * DT);
    updateFamilySample('probe', true, 1000 + rn * 6000, 1000, 7000, rn, load, 0);
    const s = sample();
    peakAudible = Math.max(peakAudible, s.audible);
    worstRatio = Math.max(worstRatio, s.worstRatio);
    if (s.dupes > 0) dupeFrames++;
    frames++;
  }
  return { peakAudible, dupePct: (100 * dupeFrames) / frames, worstRatio };
}

console.log('--- scenarios (a clean voice = 2 audible sources, 0% duplicated) ---\n');

// 1. WOT sweep idle -> redline. Every band edge crossed once, fast.
stopFamilySample();
let r = drive((t) => Math.min(1, t / 3), 3.2);
check('WOT sweep: no frame plays two copies of one recording',
  r.dupePct === 0, `peak ${r.peakAudible} audible, ${r.dupePct.toFixed(1)}% duplicated`);

// 2. Cruise breathing across a band edge — the worst case for slot thrash.
stopFamilySample();
r = drive((t) => 0.22 + 0.015 * Math.sin(t * 9), 4);
check('cruise dithering across an edge: no duplicates',
  r.dupePct === 0, `peak ${r.peakAudible} audible, ${r.dupePct.toFixed(1)}% duplicated`);

// 3. Realistic city driving: accel, upshift dives, decel.
stopFamilySample();
r = drive((t) => {
  const c = t % 4;
  return Math.max(0, Math.min(1, c < 2.4 ? c / 2.6 : 0.92 - (c - 2.4) * 0.5));
}, 20);
check('20 s of accel/upshift/decel: no duplicates',
  r.dupePct === 0, `peak ${r.peakAudible} audible, ${r.dupePct.toFixed(1)}% duplicated`);

// 4. Source churn — the count of NEW sources over a long drive. Each band edge
//    legitimately starts one pair; thrash shows up as an order-of-magnitude more.
stopFamilySample();
let created = 0;
const origStart = BufferSource.prototype.start;
BufferSource.prototype.start = function (...a) { created++; return origStart.apply(this, a); };
drive((t) => 0.22 + 0.015 * Math.sin(t * 9), 10);
BufferSource.prototype.start = origStart;
check('cruise dithering does not thrash the source pool',
  created <= 8, `${created} sources started in 10 s (pre-fix probe measured ~36/s)`);

// 5. A real sweep still ADVANCES through the bands — hysteresis must not stick.
stopFamilySample();
const seen = new Set();
for (let f = 0; f * DT < 4; f++) {
  NOW += DT;
  runTimers();
  const rn = Math.min(1, (f * DT) / 3.5);
  updateFamilySample('probe', true, 1000 + rn * 6000, 1000, 7000, rn, 0.9, 0);
  seen.add(_sampleInternals.currentLoIdx());
}
check('hysteresis does not stall the band ladder',
  seen.size >= NAMES.length - 1, `${seen.size} of ${NAMES.length} bands reached`);

console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILURE(S)`);
process.exit(fail === 0 ? 0 : 1);
