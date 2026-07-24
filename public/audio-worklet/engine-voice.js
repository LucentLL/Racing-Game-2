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
      this.pool.push({ active: false, amp: 0, noise: 0, env: 0, sinP: 0, cosP: 1, sinD: 0, cosD: 1 });
    }
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
    // Per-sample decay multiplier — the only exp for the whole voice.
    const decayS = v.decayS || 0.007;
    this.envK = Math.exp(-1 / (sampleRate * decayS));
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

  spawn(amp, nMix) {
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
    const tone = this.toneHz * (1 + 0.04 * this.noise());
    const w = (TWO_PI * tone) / sampleRate;
    slot.active = true;
    slot.amp = amp;
    slot.noise = nMix;
    slot.env = 1;
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
    const k = this.envK;
    // Idle firings stay audible; load adds the combustion energy.
    const fireAmp = 0.25 + 0.75 * load;
    // Load also hardens the burn: more noise crack in each pulse.
    const nMix = Math.min(0.85, this.noiseMix * (0.75 + 0.55 * load));

    for (let i = 0; i < out.length; i++) {
      // -- advance crank, spawn firings ---------------------------------
      // The rpm cap (16000 → ~2.2°/sample at 44.1k) guarantees
      // degPerSample is far below the tightest firing gap (45°, hd), so
      // this while catches every crossed angle; after a wrap the 0°
      // firing lands at most one sample late via nextIdx = 0.
      if (degPerSample > 0) {
        this.phase += degPerSample;
        while (this.nextIdx < this.angles.length && this.phase >= this.angles[this.nextIdx]) {
          this.spawn(this.amps[this.nextIdx] * fireAmp * (1 + this.jitter * this.noise()), nMix);
          this.nextIdx++;
        }
        if (this.phase >= 720) {
          this.phase -= 720;
          this.nextIdx = 0;
        }
      }

      // -- render the pool ----------------------------------------------
      let s = 0;
      for (let p = 0; p < MAX_PULSES; p++) {
        const pu = this.pool[p];
        if (!pu.active) continue;
        s += pu.amp * pu.env * ((1 - pu.noise) * pu.sinP + pu.noise * this.noise());
        // Rotate the oscillator, decay the envelope — no transcendentals.
        const sinN = pu.sinP * pu.cosD + pu.cosP * pu.sinD;
        pu.cosP = pu.cosP * pu.cosD - pu.sinP * pu.sinD;
        pu.sinP = sinN;
        pu.env *= k;
        if (pu.env < 0.002) pu.active = false;
      }
      out[i] = s;
    }
    return true;
  }
}

registerProcessor('engine-voice', EngineVoiceProcessor);
