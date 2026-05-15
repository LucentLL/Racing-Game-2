/**
 * H16 arcade engine sound — sawtooth oscillator + lowpass +
 * speed-driven frequency. Single voice. INTENTIONALLY simpler than
 * the monolith's v8 sample-loop crossfade engine (L18091-18272) and
 * the scaffold at src/engine/audio/v8Engine. Both of those will
 * replace this when their bodies port.
 *
 * Browser audio policy: AudioContext can't make sound until the user
 * gestures. unlockAudio() must be called from a click / touchend /
 * keydown handler at least once before audio becomes audible. The
 * lazy allocation pattern below avoids creating the context at boot
 * (which on iOS Safari leaves it in 'suspended' state until a
 * gesture anyway). Once unlocked, setEngineSpeed runs per-frame.
 *
 * Master volume + per-channel volumes (sfx vs engine vs music)
 * defer — the monolith's gameSettings.volCarSfx / volMenuSfx /
 * volMusic surface lives on LifeState. This commit ships one
 * envelope-fixed engine voice.
 */

export interface ArcadeAudio {
  ctx: AudioContext | null;
  /** Sawtooth oscillator — the engine voice. */
  engineOsc: OscillatorNode | null;
  /** Per-engine gain so we can mute / fade. */
  engineGain: GainNode | null;
  /** Lowpass to mellow the sawtooth and let high speeds bite. */
  engineFilter: BiquadFilterNode | null;
  /** True after unlockAudio() succeeded. */
  unlocked: boolean;
  /** True while the engine should be audible (i.e., gameState ===
   *  'playing'). Toggled by setEngineActive. */
  engineActive: boolean;
}

const ENGINE_FREQ_IDLE = 70;
const ENGINE_FREQ_REDLINE = 320;
const ENGINE_GAIN_ACTIVE = 0.07;
const ENGINE_GAIN_FADE_S = 0.12;
const FILTER_CUTOFF_IDLE = 280;
const FILTER_CUTOFF_REDLINE = 1500;

export function createArcadeAudio(): ArcadeAudio {
  return {
    ctx: null,
    engineOsc: null,
    engineGain: null,
    engineFilter: null,
    unlocked: false,
    engineActive: false,
  };
}

/** Call from a user-gesture handler (click / touchend / keydown). Safe
 *  to call repeatedly — only the first call does work. */
export function unlockAudio(audio: ArcadeAudio): void {
  if (audio.unlocked) return;
  const AudioCtor: typeof AudioContext | undefined =
    typeof window !== 'undefined'
      ? (window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)
      : undefined;
  if (!AudioCtor) return;
  let ctx: AudioContext;
  try {
    ctx = new AudioCtor();
  } catch {
    return;
  }
  if (ctx.state === 'suspended') {
    void ctx.resume();
  }
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = FILTER_CUTOFF_IDLE;
  const gain = ctx.createGain();
  gain.gain.value = 0;
  const osc = ctx.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.value = ENGINE_FREQ_IDLE;
  osc.connect(filter);
  filter.connect(gain);
  gain.connect(ctx.destination);
  osc.start();
  audio.ctx = ctx;
  audio.engineOsc = osc;
  audio.engineFilter = filter;
  audio.engineGain = gain;
  audio.unlocked = true;
}

/** Toggle the engine voice. Idempotent — repeat calls with the same
 *  flag are no-ops. Uses a short linear ramp so the transition reads
 *  as ignition / kill rather than a click. */
export function setEngineActive(audio: ArcadeAudio, active: boolean): void {
  if (!audio.unlocked || !audio.ctx || !audio.engineGain) return;
  if (audio.engineActive === active) return;
  audio.engineActive = active;
  const now = audio.ctx.currentTime;
  const g = audio.engineGain.gain;
  g.cancelScheduledValues(now);
  g.setValueAtTime(g.value, now);
  g.linearRampToValueAtTime(active ? ENGINE_GAIN_ACTIVE : 0, now + ENGINE_GAIN_FADE_S);
}

/** Per-frame pitch update. `speed01` is normalized 0..1 (caller does
 *  the speed/MAX_SPEED math). Frequency lerps between idle and
 *  redline; lowpass cutoff opens up at higher speed for that "engine
 *  breathing" effect. Safe to call before unlock — no-ops. */
export function setEngineSpeed(audio: ArcadeAudio, speed01: number): void {
  if (!audio.unlocked || !audio.ctx || !audio.engineOsc || !audio.engineFilter) return;
  const s = Math.max(0, Math.min(1, speed01));
  const targetFreq = ENGINE_FREQ_IDLE + (ENGINE_FREQ_REDLINE - ENGINE_FREQ_IDLE) * s;
  const targetCutoff = FILTER_CUTOFF_IDLE + (FILTER_CUTOFF_REDLINE - FILTER_CUTOFF_IDLE) * s;
  const now = audio.ctx.currentTime;
  // setTargetAtTime gives a smooth ~30ms glide rather than instant
  // snap — sounds more like a real engine breathing through gear
  // changes, less like a stepped synth.
  audio.engineOsc.frequency.setTargetAtTime(targetFreq, now, 0.03);
  audio.engineFilter.frequency.setTargetAtTime(targetCutoff, now, 0.05);
}
