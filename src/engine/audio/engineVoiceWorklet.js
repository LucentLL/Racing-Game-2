/**
 * H1225: pulse-train engine voice — AudioWorkletProcessor.
 *
 * Synthesizes individual cylinder firings instead of filtered noise:
 * a crank-angle phase accumulator walks a 720° four-stroke cycle and
 * spawns a combustion pulse at each firing angle. Pulse = exponentially
 * decaying mix of a pipe-resonance sine + noise burst. Engine character
 * comes from the DATA, not the DSP: firing-angle pattern (even i4 vs
 * Harley 0/315 potato vs Viper 90/54 odd-fire), per-cylinder amplitude
 * pattern (crossplane V8 burble, Subaru unequal-header rumble), pipe
 * tone (from per-cylinder displacement), decay and noise mix.
 *
 * REALTIME RULES (adversarial review, H1225): the render path performs
 * ZERO heap allocation and ZERO transcendentals — pulses live in a
 * preallocated pool; the decay is a per-sample multiply (env *= k) and
 * the sine is a 2-multiply phase rotator. Math.sin/cos/exp run only at
 * spawn (per firing) and in setVoice.
 *
 * Kept as plain JS in public/ so ctx.audioWorklet.addModule(BASE_URL +
 * 'audio-worklet/engine-voice.js') works identically in dev, GitHub
 * Pages, and the Tauri exe. Main-thread config lives in
 * src/engine/audio/pulseEngine.ts; it posts {angles, amps, toneHz,
 * decayS, noiseMix, jitter} on the port.
 *
 * Params (k-rate): rpm (crank speed; the main thread ramps it to 0 when
 * the voice is silenced so the pool drains and render cost → ~0), load
 * (0..1 analog throttle — scales pulse energy so throttle is audible at
 * constant RPM).
 */

const MAX_PULSES = 24;
const TWO_PI = 6.283185307179586;

class EngineVoiceProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'rpm', defaultValue: 0, minValue: 0, maxValue: 16000, automationRate: 'k-rate' },
      { name: 'load', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }

  constructor(options) {
    super();
    this.phase = 0;        // crank angle within the 720° cycle
    this.nextIdx = 0;      // next firing-angle index to cross
    this.rand = 22222;     // xorshift state — cheap noise, no Math.random/sample
    // Preallocated pulse pool — no object churn on the render thread.
    this.pool = [];
    for (let i = 0; i < MAX_PULSES; i++) {
      this.pool.push({ active: false, amp: 0, noise: 0, sf: 1, env: 0, att: 0, sinP: 0, cosP: 1, sinD: 0, cosD: 1 });
    }
    // H1226: shared noise colorists (one-pole states). Raw white noise
    // in the pulses read as "radio static"/"popcorn" (ear-test) — the
    // combustion crack is now BAND-LIMITED rasp (~200-1800Hz), and a
    // continuous dark exhaust BED (~600Hz lowpass) runs under the
    // pulse train so there is exhaust feel across the whole rev range
    // instead of silence between firings.
    const kFor = (fc) => 1 - Math.exp((-TWO_PI * fc) / sampleRate);
    this.kRaspLP = kFor(1800);
    this.kRaspHP = kFor(200);
    this.kBedLP = kFor(600);
    this.raspLP = 0;
    this.raspHP = 0;
    this.bedLP = 0;
    this.bedEnv = 0;
    // H1228: correlated cycle-to-cycle combustion variation ("grit") —
    // a slow random walk in firing strength, updated per spawn. Reads
    // as gritty flutter, never hiss (uncorrelated per-pulse randomness
    // at high fire rates was the "painful white noise").
    this.grit = 0;
    this.setVoice((options && options.processorOptions) || {});
    this.port.onmessage = (e) => this.setVoice(e.data || {});
  }

  setVoice(v) {
    const angles = (v.angles && v.angles.length ? v.angles : [0, 180, 360, 540]).slice();
    const amps = v.amps && v.amps.length === angles.length ? v.amps.slice() : angles.map(() => 1);
    // Sort angle/amp PAIRS together — firing-order tables may be written
    // in firing sequence, not ascending crank angle.
    const idx = angles.map((_, i) => i).sort((a, b) => angles[a] - angles[b]);
    this.angles = idx.map((i) => angles[i]);
    this.amps = idx.map((i) => amps[i]);
    this.toneHz = v.toneHz || 100;
    this.noiseMix = v.noiseMix == null ? 0.35 : v.noiseMix;
    this.jitter = v.jitter == null ? 0.05 : v.jitter;
    this.bedMix = v.bedMix == null ? 0.12 : v.bedMix;
    // H1227: once-per-720°-cycle amplitude wave — the cam-cycle LOPE
    // (a Viper/V8/Harley idle purrs at ~6Hz, it doesn't machine-gun).
    this.lope = v.lope == null ? 0.15 : v.lope;
    // Voice decay cap — the actual per-block decay tightens with fire
    // rate (H1228) so pulses stay impulsive at revs.
    this.decayS = v.decayS || 0.007;
    // Re-voice WITHOUT resetting phase or killing live pulses (a hard
    // reset steps the output — a click if it ever happens undocked).
    // Just re-aim nextIdx at the first angle ahead of the current crank.
    this.nextIdx = 0;
    while (this.nextIdx < this.angles.length && this.angles[this.nextIdx] < this.phase) this.nextIdx++;
  }

  // xorshift32 → [-1, 1)
  noise() {
    let x = this.rand;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    this.rand = x | 0;
    return (x | 0) / 2147483648;
  }

  spawn(amp, nMix, toneEff, jit, sf) {
    // Free slot, else steal the most-decayed pulse — no shift/splice.
    let slot = null;
    let weakest = null;
    let weakestEnv = 2;
    for (let i = 0; i < MAX_PULSES; i++) {
      const p = this.pool[i];
      if (!p.active) { slot = p; break; }
      if (p.env < weakestEnv) { weakestEnv = p.env; weakest = p; }
    }
    if (!slot) slot = weakest;
    const tone = toneEff * (1 + jit * this.noise());
    const w = (TWO_PI * tone) / sampleRate;
    slot.active = true;
    slot.amp = amp;
    slot.noise = nMix;
    slot.sf = sf;
    slot.env = 1;
    slot.att = 1;
    slot.sinP = 0;
    slot.cosP = 1;
    slot.sinD = Math.sin(w);
    slot.cosD = Math.cos(w);
  }

  process(inputs, outputs, parameters) {
    const out = outputs[0][0];
    if (!out) return true;
    const rpm = parameters.rpm[0];
    const load = Math.min(1, Math.max(0, parameters.load[0]));
    const degPerSample = (rpm * 6) / sampleRate; // rpm/60 rev/s × 360°
    // H1228 (ear-test 4): pitch at revs comes from the PULSE TRAIN
    // ITSELF — a train of short, nearly IDENTICAL pulses is periodic at
    // the fire rate and reads as a rich harmonic buzz through the tanh
    // stage. The two failure modes it replaces: an injected sine at the
    // fire rate (H1227 tone lock) glides with RPM = "goofy spaceship
    // wee-woo"; per-pulse randomness at 400+ fires/s = "painful white
    // noise". So randomness FADES with fire rate (rf): full character
    // at idle (praised), near-deterministic at revs, and the decay
    // tightens so pulses stay impulsive instead of smearing.
    const fireRate = (rpm / 120) * this.angles.length;
    // H1230: ramp tightened (was 50→300/s) so the sine/noise fade
    // completes earlier in the rev range on high-redline engines.
    const rf = Math.min(1, Math.max(0, (fireRate - 40) / 200));
    const decayNow = Math.min(this.decayS, 0.55 / Math.max(1, fireRate));
    const k = Math.exp(-1 / (sampleRate * decayNow));
    // Attack also tightens with rate — a 1.2ms rise would smear a
    // 0.8ms high-rpm pulse back into mush; idle keeps the soft onset.
    const kAtt = Math.exp(-1 / (sampleRate * Math.min(0.0012, 0.25 / Math.max(1, fireRate))));
    // H1229: pipe-tone SINE fraction also fades with fire rate — sine
    // fragments restarting at a rate unrelated to their own frequency
    // ring metallic ("synth space" in b4/i6 above ~60% RPM). At revs a
    // pulse is a pure shaped click; a click train is perfectly harmonic
    // at the fire rate. Idle (rf=0) keeps the full tonal thump.
    const sineAmt = 1 - rf;
    // Energy conservation: shorter high-rpm pulses carry less energy —
    // compensate, but gently (^0.35, cap 2.5): the H1228 sqrt/3.5 comp
    // drove tanh into square-wave flat tops = the reported "audio
    // clipping" on hard-driven voices (V10).
    const eComp = Math.min(2.5, Math.pow(this.decayS / decayNow, 0.35));
    // Idle firings stay audible; load adds the combustion energy.
    const fireAmp = (0.25 + 0.75 * load) * eComp;
    // Load hardens the burn; per-pulse noise fades out at high rates
    // (grit there comes from the correlated walk, not fresh noise).
    const nMix = Math.min(0.85, this.noiseMix * (0.55 + 0.6 * load) * (1 - 0.75 * rf));
    const jitAmp = this.jitter * (0.35 + 0.65 * (1 - rf));
    const jitTone = 0.005 + 0.035 * (1 - rf);

    for (let i = 0; i < out.length; i++) {
      // -- advance crank, spawn firings ---------------------------------
      // The rpm cap (16000 → ~2.2°/sample at 44.1k) guarantees
      // degPerSample is far below the tightest firing gap (45°, hd), so
      // this while catches every crossed angle; after a wrap the 0°
      // firing lands at most one sample late via nextIdx = 0.
      if (degPerSample > 0) {
        this.phase += degPerSample;
        while (this.nextIdx < this.angles.length && this.phase >= this.angles[this.nextIdx]) {
          // The cam-cycle lope: one slow amplitude wave per 720° cycle
          // (~6Hz at a 700 RPM idle — the purr; growl-roughness at revs).
          const lopeMod = 1 + this.lope * Math.sin((TWO_PI * this.phase) / 720);
          // Correlated combustion walk — gritty flutter at any rate.
          this.grit = 0.7 * this.grit + 0.075 * this.noise();
          this.spawn(
            this.amps[this.nextIdx] * fireAmp * lopeMod * (1 + this.grit)
              * (1 + jitAmp * this.noise()),
            nMix, this.toneHz, jitTone, sineAmt,
          );
          this.nextIdx++;
        }
        if (this.phase >= 720) {
          this.phase -= 720;
          this.nextIdx = 0;
        }
      }

      // -- shared noise color (one white sample each, one-pole filtered)
      const w1 = this.noise();
      this.raspLP += this.kRaspLP * (w1 - this.raspLP);
      this.raspHP += this.kRaspHP * (this.raspLP - this.raspHP);
      const rasp = (this.raspLP - this.raspHP) * 2.4; // band-limited crack, RMS-comped
      const w2 = this.noise();
      this.bedLP += this.kBedLP * (w2 - this.bedLP);

      // -- continuous exhaust bed (swells with load + revs, smoothed) ---
      const bedTarget = this.bedMix * (0.25 + 0.75 * load) * Math.min(1, rpm / 2200);
      this.bedEnv += 0.002 * (bedTarget - this.bedEnv);
      let s = this.bedEnv * this.bedLP * 3;

      // -- render the pool ----------------------------------------------
      for (let p = 0; p < MAX_PULSES; p++) {
        const pu = this.pool[p];
        if (!pu.active) continue;
        s += pu.amp * pu.env * (1 - pu.att)
          * ((1 - pu.noise) * (pu.sf * pu.sinP + (1 - pu.sf) * 0.8) + pu.noise * rasp);
        // Rotate the oscillator, decay the envelope — no transcendentals.
        const sinN = pu.sinP * pu.cosD + pu.cosP * pu.sinD;
        pu.cosP = pu.cosP * pu.cosD - pu.sinP * pu.sinD;
        pu.sinP = sinN;
        pu.env *= k;
        pu.att *= kAtt;
        if (pu.env < 0.004) pu.active = false;
      }
      out[i] = s;
    }
    return true;
  }
}

registerProcessor('engine-voice', EngineVoiceProcessor);
