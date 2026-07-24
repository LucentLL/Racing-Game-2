/**
 * H1225: pulse-train engine voice — main-thread side.
 *
 * Loads the AudioWorklet processor (public/audio-worklet/engine-voice.js),
 * owns its shaping chain, and maps each car onto a voice:
 *
 *   worklet (per-cylinder pulses) → tanh waveshaper (combustion warmth /
 *   harmonics) → 35Hz highpass (DC guard) → lowpass (brightness: rises
 *   with throttle + revs — the LOAD axis the old synth never had) →
 *   postGain → sfxGain
 *
 * Character is data-driven per engine family: firing-angle pattern over
 * the 720° cycle (Harley 0/315 potato-potato, Viper 90/54 odd-fire,
 * crossplane-V8 amp burble, Subaru unequal-header alternation) plus a
 * pipe tone derived from the car's real per-cylinder displacement
 * (GT4_SPECS.disp), so a 7L V10 thuds while a kei triple thrums.
 *
 * This voice REPLACES the legacy noise-resonator synth wherever the
 * worklet is available (the noise bank remains only as fallback for
 * browsers without AudioWorklet) — it is THE foundation; the V8 sample
 * stays an optional layer on top per the locked direction, so eType
 * 'v8' still defers to the sample when its buffers loaded.
 */

import { audio } from './state';
import { GT4_SPECS } from '@/config/cars/gt4Database';

/** Even firing: n cylinders over the 720° four-stroke cycle. */
function even(n: number): number[] {
  return Array.from({ length: n }, (_, i) => (i * 720) / n);
}

interface PulseVoice {
  angles: number[];
  amps: number[];
  /** Multiplier on the displacement-derived pipe tone. */
  toneMul: number;
  /** Pulse decay (s) — long = thuddy overlap, short = crisp buzz. */
  decayS: number;
  noiseMix: number;
  jitter: number;
  /** Base post-gain. */
  vol: number;
  /** Brightness (lowpass) multiplier. */
  bright: number;
  /** H1226: continuous exhaust-bed level (the "exhaust feel throughout
   *  the RPM range" — dark roar under the pulse train). */
  bedMix: number;
  /** H1226: tanh saturation drive — aggression/rasp (Viper 3.5). */
  drive: number;
  /** H1227: cam-cycle lope depth — one amplitude wave per 720° cycle
   *  (~6Hz at idle). The Viper/V8/Harley purr; near-zero for turbine-
   *  smooth engines. */
  lope: number;
  /** H1233: intake-honk formant center (Hz) — the throaty resonance a
   *  90s Civic pulls through its intake when the throttle opens (user's
   *  reference video). Peaking filter in the voice chain. */
  formantHz: number;
  /** H1233: formant gain ceiling (dB) — blooms with load. */
  honk: number;
}

/** Keys match proceduralEngine's EngineType union.
 *
 *  H1226 retune from the user's per-family ear-test. Praised (b2 full
 *  range, i4 idle, boxer idle) keep their constants. The static/popcorn
 *  cases all shared two defects, fixed in the worklet: white per-pulse
 *  noise (now band-limited rasp) and silence between firings (now a
 *  continuous bed). On top of that: decays that were shorter than one
 *  cycle of their own pipe tone (b4 3ms vs a 4.3ms period → pure click
 *  = "radio static"; v12 same) got lengthened, noise mixes came down
 *  hard where pops dominated (hd 0.44 → 0.22 = the "popcorn"), and the
 *  Viper got drive/volume/contrast ("doesn't sound aggressive"). */
const VOICES: Record<string, PulseVoice> = {
  i4:  { angles: even(4), amps: [1, 1, 1, 1], toneMul: 1.0, decayS: 0.007, noiseMix: 0.40, jitter: 0.06, vol: 0.30, bright: 1.0, bedMix: 0.10, drive: 2.2, lope: 0.12, formantHz: 480, honk: 7 },
  i6:  { angles: even(6), amps: [1, 0.96, 1, 0.96, 1, 0.96], toneMul: 1.0, decayS: 0.0065, noiseMix: 0.20, jitter: 0.04, vol: 0.30, bright: 1.0, bedMix: 0.10, drive: 2.4, lope: 0.08, formantHz: 380, honk: 4 },
  v6:  { angles: even(6), amps: [1, 0.9, 1.05, 0.92, 1.02, 0.88], toneMul: 1.05, decayS: 0.0065, noiseMix: 0.24, jitter: 0.05, vol: 0.31, bright: 1.0, bedMix: 0.12, drive: 2.6, lope: 0.15, formantHz: 420, honk: 4.5 },
  // Crossplane burble: even 90° spacing but bank-alternating pulse
  // emphasis — the lopsided LRLLRLRR exhaust arrival pattern.
  v8:  { angles: even(8), amps: [1, 0.82, 1.12, 0.78, 1.06, 0.88, 1.18, 0.74], toneMul: 0.9, decayS: 0.010, noiseMix: 0.28, jitter: 0.06, vol: 0.36, bright: 1.0, bedMix: 0.18, drive: 2.7, lope: 0.35, formantHz: 220, honk: 5 },
  // Viper-style odd-fire V10: alternating 90°/54° intervals. Meanest
  // voice in the table: hard drive, hot bed, strong lope contrast.
  // H1229: drive 3.5→2.9 — with energy-compensated pulse peaks the max
  // drive squared off the tanh = the reported "audio clipping" at revs.
  v10: { angles: [0, 90, 144, 234, 288, 378, 432, 522, 576, 666], amps: [1, 0.78, 1.15, 0.75, 1.1, 0.8, 1.18, 0.72, 1.05, 0.82], toneMul: 0.88, decayS: 0.010, noiseMix: 0.32, jitter: 0.08, vol: 0.42, bright: 1.05, bedMix: 0.22, drive: 2.9, lope: 0.4, formantHz: 240, honk: 6 },
  v12: { angles: even(12), amps: even(12).map((_, i) => (i % 2 ? 0.95 : 1)), toneMul: 1.15, decayS: 0.006, noiseMix: 0.15, jitter: 0.03, vol: 0.31, bright: 1.12, bedMix: 0.10, drive: 2.4, lope: 0.06, formantHz: 500, honk: 3 },
  // Subaru rumble: even boxer timing but unequal-length headers make
  // alternate pulses arrive fat/thin.
  f4:  { angles: even(4), amps: [1.28, 0.68, 1.28, 0.68], toneMul: 0.85, decayS: 0.009, noiseMix: 0.38, jitter: 0.07, vol: 0.32, bright: 0.9, bedMix: 0.14, drive: 2.6, lope: 0.2, formantHz: 300, honk: 5 },
  // 2-rotor: 2 faces/rev like a 4-cyl but long overlapping pulses and a
  // higher tone → the smooth brap, not a piston chug.
  rot: { angles: even(4), amps: [1, 0.97, 1, 0.97], toneMul: 1.6, decayS: 0.012, noiseMix: 0.35, jitter: 0.04, vol: 0.28, bright: 1.15, bedMix: 0.16, drive: 2.8, lope: 0.05, formantHz: 700, honk: 4 },
  b2:  { angles: [0, 360], amps: [1, 0.94], toneMul: 1.5, decayS: 0.005, noiseMix: 0.34, jitter: 0.06, vol: 0.28, bright: 1.1, bedMix: 0.06, drive: 2.2, lope: 0.15, formantHz: 600, honk: 3 },
  b4:  { angles: even(4), amps: [1, 1, 1, 1], toneMul: 1.6, decayS: 0.0065, noiseMix: 0.15, jitter: 0.04, vol: 0.30, bright: 1.25, bedMix: 0.08, drive: 2.4, lope: 0.04, formantHz: 800, honk: 3 },
  // Harley 45° V-twin: fire at 0° and 315°, then a 405° gap. Potato.
  hd:  { angles: [0, 315], amps: [1.1, 0.95], toneMul: 1.05, decayS: 0.009, noiseMix: 0.22, jitter: 0.09, vol: 0.36, bright: 0.95, bedMix: 0.12, drive: 2.8, lope: 0.45, formantHz: 180, honk: 6 },
};

/** Parse GT4 disp strings: '1595cc', '6998cc', rotary '654x2cc' — plus
 *  the stragglers the review found in the real data: '499.5cc' (Fiat
 *  500 twins; unanchored int-matching read that as 5cc), '2400 cc'
 *  (embedded space), '491x2ｃｃ' (full-width cc on the Mazda 110S L10B).
 *  '- cc' (unknown) stays null → 2000cc default. */
export function parseCc(disp: string | undefined): number | null {
  if (!disp) return null;
  const s = disp.replace(/\s+/g, '').replace(/ｃ|Ｃ/g, 'c');
  const m = /^(\d+(?:\.\d+)?)(?:x(\d+(?:\.\d+)?))?cc$/i.exec(s);
  if (!m) return null;
  return Number(m[1]) * (m[2] ? Number(m[2]) : 1);
}

/** Pipe tone from per-cylinder displacement: bigger jugs → deeper thud.
 *  ~84Hz for a 2L four, ~71Hz for the 8L Viper, ~120Hz for a kei triple. */
export function pipeToneHz(cc: number, cyls: number, toneMul: number): number {
  const cylCc = cc / Math.max(1, cyls);
  return Math.min(230, Math.max(55, 90 * Math.cbrt(400 / cylCc) * toneMul));
}

const pe = {
  status: 'idle' as 'idle' | 'loading' | 'ready' | 'failed',
  node: null as AudioWorkletNode | null,
  shaper: null as WaveShaperNode | null,
  hp: null as BiquadFilterNode | null,
  honk: null as BiquadFilterNode | null,
  lp: null as BiquadFilterNode | null,
  postGain: null as GainNode | null,
  pipeDelay: null as DelayNode | null,
  pipeDamp: null as BiquadFilterNode | null,
  pipeFb: null as GainNode | null,
  pipeMix: null as GainNode | null,
  curName: '',
  curKey: '',
  curDrive: 0,
  retries: 0,
  shiftDuckUntil: 0,
  lastDuckAt: 0,
};

/** H1234: audio-side clutch cut — a real upshift's rpm drop is masked
 *  by the clutch moment; ours played the full pitch dive at full volume
 *  ("cartoonish" accelerating, ear-test 9). Ducks the pulse voice ~110ms
 *  under the existing shift pops. Rate-limited so gear flapping at a
 *  speed boundary can't stutter the engine. */
export function notifyPulseShift(): void {
  const ctx = audio.audioCtx;
  if (!ctx) return;
  const t = ctx.currentTime;
  if (t - pe.lastDuckAt < 0.25) return;
  pe.lastDuckAt = t;
  pe.shiftDuckUntil = t + 0.11;
}

/** Rebuild the tanh curve when a voice needs a different drive. */
function setDrive(drive: number): void {
  if (!pe.shaper || drive === pe.curDrive) return;
  pe.curDrive = drive;
  const curve = new Float32Array(512);
  for (let i = 0; i < 512; i++) {
    curve[i] = Math.tanh((i / 255.5 - 1) * drive);
  }
  pe.shaper.curve = curve;
}

/** Kick off the worklet module load (called from initAudio; retried from
 *  updatePulseEngine if audio started before the module existed). */
export function loadPulseEngine(): void {
  const ctx = audio.audioCtx;
  if (pe.status !== 'idle' || !ctx || !audio.sfxGain) return;
  if (!ctx.audioWorklet) { pe.status = 'failed'; return; } // old browser → legacy synth
  pe.status = 'loading';
  // H1231: the worklet ships as a bundle-managed asset (content-hashed
  // filename, URL resolved relative to this chunk) — the SAME mechanism
  // sprites/audio use, so it works in dev, Pages, AND the Tauri exe.
  // The two prior schemes both failed somewhere: a bare public/ URL
  // cached stale DSP under new builds (ear-test 6), and H1230's ?v=
  // query 404'd under Tauri's asset protocol — the exe fell back to
  // the legacy vacuum-cleaner synth ("Civic sounds like a vacuum
  // cleaner again").
  const workletUrl = new URL('./engineVoiceWorklet.js', import.meta.url);
  ctx.audioWorklet.addModule(workletUrl.href)
    .then(() => {
      if (!audio.audioCtx || !audio.sfxGain) { pe.status = 'failed'; return; }
      pe.node = new AudioWorkletNode(audio.audioCtx, 'engine-voice', {
        numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1],
      });
      // tanh soft saturation — combustion warmth, richer harmonics than
      // the raw pulse sum. Per-voice drive via setDrive (H1226).
      pe.shaper = audio.audioCtx.createWaveShaper();
      setDrive(2.2);
      pe.hp = audio.audioCtx.createBiquadFilter();
      pe.hp.type = 'highpass';
      pe.hp.frequency.value = 35;
      // H1233: intake-honk formant (peaking) — per-voice center, gain
      // blooms with load. The 90s-Civic midrange throat.
      pe.honk = audio.audioCtx.createBiquadFilter();
      pe.honk.type = 'peaking';
      pe.honk.frequency.value = 480;
      pe.honk.Q.value = 1.1;
      pe.honk.gain.value = 0;
      pe.lp = audio.audioCtx.createBiquadFilter();
      pe.lp.type = 'lowpass';
      pe.lp.frequency.value = 800;
      pe.lp.Q.value = 0.5;
      pe.postGain = audio.audioCtx.createGain();
      pe.postGain.gain.value = 0;
      // H1235: quarter-wave EXHAUST PIPE resonator — the single biggest
      // "recording vs synthesis" gap: a real exhaust is a physical pipe
      // that rings at its own odd harmonics no matter what excites it.
      // Feedback comb (delay = half-period of the pipe fundamental,
      // NEGATIVE feedback → odd-harmonic peaks, damped loop) fed in
      // parallel with the dry path. Delay retunes per car from the
      // displacement-derived pipe tone.
      pe.pipeDelay = audio.audioCtx.createDelay(0.05);
      pe.pipeDelay.delayTime.value = 1 / (2 * 100);
      pe.pipeDamp = audio.audioCtx.createBiquadFilter();
      pe.pipeDamp.type = 'lowpass';
      pe.pipeDamp.frequency.value = 2200;
      pe.pipeFb = audio.audioCtx.createGain();
      pe.pipeFb.gain.value = -0.42;
      pe.pipeMix = audio.audioCtx.createGain();
      pe.pipeMix.gain.value = 0.8;
      pe.node.connect(pe.shaper);
      pe.shaper.connect(pe.hp);               // dry path
      pe.shaper.connect(pe.pipeDelay);        // pipe path
      pe.pipeDelay.connect(pe.pipeDamp);
      pe.pipeDamp.connect(pe.pipeFb);
      pe.pipeFb.connect(pe.pipeDelay);        // feedback loop
      pe.pipeDamp.connect(pe.pipeMix);
      pe.pipeMix.connect(pe.hp);
      pe.hp.connect(pe.honk);
      pe.honk.connect(pe.lp);
      pe.lp.connect(pe.postGain);
      pe.postGain.connect(audio.sfxGain);
      pe.status = 'ready';
    })
    .catch((e) => {
      // Don't lock the flagship voice out of the whole session on one
      // flaky fetch (mobile Pages over cellular): retry on later frames,
      // and console.warn (kept in prod builds) so a missing voice is
      // diagnosable instead of looking like the feature didn't ship.
      pe.retries++;
      pe.status = pe.retries >= 3 ? 'failed' : 'idle';
      console.warn('[pulseEngine] worklet load failed (attempt ' + pe.retries + '):', e);
    });
}

export interface PulseFrameInput {
  name: string;
  /** proceduralEngine EngineType key ('i4' | 'v8' | 'rot' | …). */
  voiceKey: string;
  cyls: number;
  rpm: number;
  rpmNorm: number;
  /** Analog throttle 0..1 — the load axis. */
  load: number;
  /** Built-engine aggression 0..0.6 (H1223). */
  hpAggr: number;
  /** True when the V8 sample loop owns this car's base voice. */
  v8SampleOwns: boolean;
}

/** Per-frame update. Returns true when the pulse voice owns the car
 *  (caller silences the legacy noise-resonator bank). */
export function updatePulseEngine(input: PulseFrameInput): boolean {
  if (pe.status === 'idle') loadPulseEngine();
  if (pe.status !== 'ready' || !pe.node || !audio.audioCtx) return false;
  const t = audio.audioCtx.currentTime;

  if (input.v8SampleOwns) {
    pe.postGain?.gain.setTargetAtTime(0, t, 0.05);
    // Drain the pool too — a silenced worklet must not keep spawning
    // pulses at the last rpm and burning render-thread CPU.
    pe.node.parameters.get('rpm')?.setTargetAtTime(0, t, 0.1);
    return false;
  }

  const v = VOICES[input.voiceKey] ?? VOICES.i4;
  if (input.name !== pe.curName || input.voiceKey !== pe.curKey) {
    pe.curName = input.name;
    pe.curKey = input.voiceKey;
    const cc = parseCc(GT4_SPECS[input.name]?.disp) ?? 2000;
    pe.node.port.postMessage({
      angles: v.angles,
      amps: v.amps,
      toneHz: pipeToneHz(cc, input.cyls, v.toneMul),
      decayS: v.decayS,
      noiseMix: v.noiseMix,
      jitter: v.jitter,
      bedMix: v.bedMix,
      lope: v.lope,
    });
    setDrive(v.drive);
    pe.honk?.frequency.setTargetAtTime(v.formantHz, t, 0.05);
    // Retune the pipe to this car's fundamental (half-period delay).
    pe.pipeDelay?.delayTime.setTargetAtTime(
      Math.min(0.05, 1 / (2 * pipeToneHz(cc, input.cyls, v.toneMul))), t, 0.05,
    );
  }

  pe.node.parameters.get('rpm')?.setTargetAtTime(Math.max(0, input.rpm), t, 0.02);
  pe.node.parameters.get('load')?.setTargetAtTime(input.load, t, 0.05);
  // The audible load axis: brightness opens with throttle and revs.
  // Floor 550Hz — phone microspeakers roll off below ~450Hz, and an
  // all-sub idle voice (Harley: 55Hz tone under a 320Hz lid) played to
  // silence at stoplights on the mobile build (review finding).
  // H1229: rpm term 1500→3400 — treble was fading past 50% RPM; the
  // click train's high harmonics now stay above the lid ("should stay
  // clear... not fading out").
  pe.lp?.frequency.setTargetAtTime(
    Math.max(550, (650 + 2350 * input.load + 3400 * input.rpmNorm) * v.bright), t, 0.04,
  );
  // The honk blooms with throttle — closed = subtle, open = throaty.
  pe.honk?.gain.setTargetAtTime(v.honk * (0.2 + 0.8 * input.load), t, 0.05);
  // H1227: explicit rpm loudness — the worklet's energy normalization
  // keeps the pulse sum level-flat across the rev range (so tanh stops
  // compressing throttle away); the real louder-at-revs behavior is
  // reinstated here where it can't eat dynamics.
  // H1234: ×0.3 during the shift clutch-cut window.
  const duck = t < pe.shiftDuckUntil ? 0.3 : 1;
  pe.postGain?.gain.setTargetAtTime(
    v.vol * duck * (0.55 + 0.45 * input.load) * (0.75 + 0.95 * input.rpmNorm) * (1 + input.hpAggr * 0.5),
    t, 0.05,
  );
  return true;
}

/** Menu fade (uiOpen) — mirrors the legacy synth-bank fade. Also ramps
 *  rpm to 0 so the pool drains and the silenced worklet stops burning
 *  render-thread CPU for however long the menu stays open; the next
 *  active frame re-targets rpm and the voice swells back naturally. */
export function duckPulseEngine(t: number): void {
  pe.postGain?.gain.setTargetAtTime(0, t, 0.15);
  pe.node?.parameters.get('rpm')?.setTargetAtTime(0, t, 0.1);
}

/** H1028 snap-to-silence for race restarts / teleports. In-flight
 *  pulses decay in <15ms once the gain is zeroed. */
export function resetPulseEngineAudio(): void {
  const ctx = audio.audioCtx;
  if (!ctx || !pe.postGain) return;
  try {
    pe.postGain.gain.cancelScheduledValues(ctx.currentTime);
    pe.postGain.gain.setValueAtTime(0.0001, ctx.currentTime);
  } catch { /* audio node in a bad state — ignore */ }
}
