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
  };
  controls: {
    gas: boolean;
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
  };
  uiOpen: boolean;
  dt: number;
}

export interface VolumeSettings {
  volCarSfx?: number;
  volMenuSfx?: number;
  volMusic?: number;
}
