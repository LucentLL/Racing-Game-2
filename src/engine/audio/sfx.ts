import { audio } from './state';

// H692: prefix with import.meta.env.BASE_URL so GitHub Pages (deployed
// under '/Racing-Game-2/') resolves to '/Racing-Game-2/audio/...'. Dev
// keeps BASE_URL='/' so the URL stays '/audio/...' verbatim.
export const SFX_BASE = `${import.meta.env.BASE_URL}audio/`;

export const TIRE_SFX_FILES: readonly string[] = [
  'Tire_Screech-001.wav',
  'Tire_Screech-002.wav',
  'Tire_Screech-003.wav',
  'Tire_Screech-004.wav',
];

export const CRASH_SFX_FILES: readonly string[] = [
  'Crash_Hard-001.wav',
  'Crash_Hard-002.wav',
  'Crash_Hard-003.wav',
  'Crash_Hard-004.wav',
];

export const V8_GEAR_FILES: readonly string[] = [
  'Muscle_Car_Gear0 (Loop).wav',
  'Muscle_Car_Gear0_Accelerate (Loop).wav',
  'Muscle_Car_Gear1 (Loop).wav',
  'Muscle_Car_Gear2 (Loop).wav',
  'Muscle_Car_Gear3 (Loop).wav',
  'Muscle_Car_Gear4 (Loop).wav',
  'Muscle_Car_Gear5 (Loop).wav',
  'Muscle_Car_Gear6 (Loop).wav',
];

/** H1226/H1237: is the Muscle_Car V8 sample layer active? Lives here
 *  (not v8Engine) so the loader can consult it without an import cycle
 *  — v8Engine already imports this module. Default OFF: the user's
 *  ear-test found the sample cohesion-breaking next to the pulse
 *  voices, and skipping it saves ~24MB of fetch. Flip to true to
 *  restore the sampled V8. */
export const V8_SAMPLE_LAYER = false;

export const tireSampleBuffers: Array<AudioBuffer | null> = [null, null, null, null];
export const crashSampleBuffers: Array<AudioBuffer | null> = [null, null, null, null];
export const v8GearBuffers: Array<AudioBuffer | null> = new Array(8).fill(null);

export const sfxFlags = {
  tireSamplesLoaded: false,
  crashSamplesLoaded: false,
  v8SamplesLoaded: false,
};

export async function loadAllSFX(ac: AudioContext): Promise<void> {
  const loadSet = async (
    files: readonly string[],
    bufArr: Array<AudioBuffer | null>,
    base: string,
  ): Promise<boolean> => {
    const loads = files.map(async (f, i) => {
      try {
        const resp = await fetch(base + encodeURI(f));
        if (!resp.ok) return;
        const buf = await resp.arrayBuffer();
        bufArr[i] = await ac.decodeAudioData(buf);
      } catch (e) {
        console.log('SFX ' + f + ' failed:', e);
      }
    });
    await Promise.all(loads);
    return bufArr.some((b) => b !== null);
  };

  sfxFlags.tireSamplesLoaded = await loadSet(TIRE_SFX_FILES, tireSampleBuffers, SFX_BASE);
  sfxFlags.crashSamplesLoaded = await loadSet(CRASH_SFX_FILES, crashSampleBuffers, SFX_BASE);
  // H1237: the Muscle_Car set is ~24MB of the bundle and H1226 turned
  // the V8 sample layer OFF by default (cohesion), so skip fetching it
  // entirely unless the flag is on — that bandwidth now pays for the
  // real per-family recordings instead.
  sfxFlags.v8SamplesLoaded = V8_SAMPLE_LAYER
    ? await loadSet(V8_GEAR_FILES, v8GearBuffers, SFX_BASE)
    : false;
}

let lastCrashTime = 0;

export function playCrashSound(severity: number): void {
  if (!sfxFlags.crashSamplesLoaded || !audio.audioCtx || !audio.sfxGain) return;
  const now = Date.now();
  if (now - lastCrashTime < 500) return;
  lastCrashTime = now;
  const idx = Math.floor(Math.random() * 4);
  const buf = crashSampleBuffers[idx];
  if (!buf) return;
  const src = audio.audioCtx.createBufferSource();
  src.buffer = buf;
  src.playbackRate.value = 0.9 + Math.random() * 0.2;
  const g = audio.audioCtx.createGain();
  g.gain.value = Math.min(0.6, 0.15 + severity * 0.15);
  src.connect(g);
  g.connect(audio.sfxGain);
  src.start();
}
