import { audio } from './state';

export const SFX_BASE = '/audio/';

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
  sfxFlags.v8SamplesLoaded = await loadSet(V8_GEAR_FILES, v8GearBuffers, SFX_BASE);
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
