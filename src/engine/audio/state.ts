/**
 * Shared audio module state — held in a single mutable namespace so the
 * various audio sub-modules (init, sfx, v8Engine, tireGrain, proceduralEngine)
 * can read/write the same AudioContext and node graph.
 *
 * One-time initialization happens in init.ts on first user interaction
 * (touch/click/keydown), per browser autoplay-policy requirements.
 */

export interface AudioState {
  audioCtx: AudioContext | null;
  audioStarted: boolean;

  masterGain: GainNode | null;
  sfxGain: GainNode | null;
  uiGain: GainNode | null;
  musicGain: GainNode | null;

  engNoise: AudioBufferSourceNode | null;
  engNoiseGain: GainNode | null;
  engRes1: BiquadFilterNode | null;
  engRes2: BiquadFilterNode | null;
  engRes3: BiquadFilterNode | null;
  engRes4: BiquadFilterNode | null;
  r1g: GainNode | null;
  r2g: GainNode | null;
  r3g: GainNode | null;
  r4g: GainNode | null;
  engBass: OscillatorNode | null;
  engBassGain: GainNode | null;
  exhaust: BiquadFilterNode | null;
  exhaustGain: GainNode | null;
  bikeScream: BiquadFilterNode | null;
  bikeScreamGain: GainNode | null;
  tireNoise: AudioBufferSourceNode | null;
  tireGain: GainNode | null;
  tireFilter: BiquadFilterNode | null;
  brakePadNoise: AudioBufferSourceNode | null;
  brakePadGain: GainNode | null;
  brakePadFilter: BiquadFilterNode | null;

  lastGear: number;
  /** H1234: audible-rpm conditioning state — the voice's pitch falls at
   *  a capped mechanical rate (rises stay instant), so the kinematic
   *  model's ~50%-in-100ms upshift dive stops playing as a slide
   *  whistle. 0 = unprimed. */
  lastAudioRpm: number;
  /** H1291: release-hold timer (seconds) for the limiter-bounce audio
   *  state. physics' player.revLimiter flickers at frame rate as the
   *  hard power cut drops speed just under the gear top — attack is
   *  instant, release holds ~0.2s so the layers don't machine-gun. */
  limiterHold: number;
}

export const audio: AudioState = {
  audioCtx: null,
  audioStarted: false,
  masterGain: null,
  sfxGain: null,
  uiGain: null,
  musicGain: null,
  engNoise: null,
  engNoiseGain: null,
  engRes1: null,
  engRes2: null,
  engRes3: null,
  engRes4: null,
  r1g: null,
  r2g: null,
  r3g: null,
  r4g: null,
  engBass: null,
  engBassGain: null,
  exhaust: null,
  exhaustGain: null,
  bikeScream: null,
  bikeScreamGain: null,
  tireNoise: null,
  tireGain: null,
  tireFilter: null,
  brakePadNoise: null,
  brakePadGain: null,
  brakePadFilter: null,
  lastGear: 1,
  lastAudioRpm: 0,
  limiterHold: 0,
};

export interface AudioFrameInputs {
  player: {
    speed: number;
    rpm: number;
    gear: number;
    drifting: boolean;
    slipAngle: number;
    onRoad: boolean;
    wheelspinRatio: number;
    wheelGap: number;
    /** H1250: tyre grip utilisation, 0 = straight line, 1 = at the limit,
     *  >1 = sliding. Drives the pre-limit cornering scrub (see tireGrain);
     *  computed by sim/tireLoad. Optional so non-game callers (audiolab,
     *  previews) can omit it. */
    gripUse?: number;
    /** H1291: physics truth for the rev limiter — gearAndRpm's atLimit
     *  (speed pinned at the held gear's top under gas, needle bouncing).
     *  Every "limiter" audio layer keys off this, NOT rpm position: a
     *  normal full-throttle pull parks the needle at 0.97·redline (deep
     *  in the red) without bouncing. Optional for non-game callers. */
    revLimiter?: boolean;
  };
  controls: {
    gas: boolean;
    /** H1160: analog throttle 0..1 (trigger / slider pedal; keyboard = 1).
     *  Gates the launch-screech heuristic so feathering the gas doesn't
     *  squeal — parity with skid marks' BURNOUT_GAS_THRESH (H752). */
    gasAmount: number;
    braking: boolean;
    ebrk: boolean;
    brakeAmount: number;
  };
  car: {
    name: string;
    isBike: boolean;
    idleRPM: number;
    redline: number;
    /** H857: raw GT4 engine-type string ('V8 (OHV)', 'L6 (DOHC)', 'V12
     *  (DOHC)', 'Rotor2 (Rotary)'…) for data-accurate engine voicing.
     *  Optional — falls back to name-based classification when absent. */
    eType?: string;
    /** H1221: raw GT4 aspiration string — 'NA' | 'TURBO' | 'SuperCharger'.
     *  Factory forced induction; drives the turbo/SC audio layer. */
    asp?: string;
    /** H1221: power upgrade stage 0-4 (upgradeHeadroom). Stage flavor is
     *  turbo-kit themed, so higher stages intensify the boost voice and
     *  open up the exhaust character. */
    powerStage?: number;
    /** H1221/H1222: supercharger shop mod ACTIVE on this car — the
     *  call site mirrors the full physics boost gate (life.supercharged
     *  && canSC && settings.supercharger !== false), so true here means
     *  the torque boost really applies and the SC whine should play. */
    supercharged?: boolean;
    /** H1221: effective HP / stock HP (≥1 with power upgrades) — overall
     *  built-engine loudness/aggression scalar. */
    hpRatio?: number;
    /** H1251: per-car character applied to the shared recorded family voice
     *  (see engineVoice). Absent = neutral, i.e. the H1237 behaviour. */
    voice?: import('./engineVoice').EngineVoice;
    /** H1268: which RECORDED family this car speaks with — a manifest key from
     *  config/cars/engineFamily.resolveEngineFamily, resolved once at the call
     *  site because it is pure catalog data. null/absent = no recording fits
     *  (Harley V-twins, unknown layouts) and the pulse synth keeps the car.
     *
     *  Before this the family key WAS the classified engine type, which could
     *  only ever name one recording per layout; the pack now ships 50, six of
     *  them inline-fours. */
    sampleFamily?: string | null;
  };
  uiOpen: boolean;
  /** H1238: engine shut off (PARK). Silences every engine voice via the
   *  same all-voices duck the menu path uses — the car is genuinely off,
   *  not merely unheard, so foley one-shots (muffler cooldown) are the
   *  only thing left running. */
  engineOff?: boolean;
  dt: number;
}

export interface VolumeSettings {
  volCarSfx?: number;
  volMenuSfx?: number;
  volMusic?: number;
}
