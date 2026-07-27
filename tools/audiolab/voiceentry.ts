// H1270: probe entry for tools/audiolab/voicecheck.mjs — the recorded-engine
// band crossfade, drivable headlessly against a stubbed WebAudio API.
// Bundle with:
//   npx esbuild tools/audiolab/voiceentry.ts --bundle --alias:@=./src --format=esm --outfile=tools/audiolab/voiceentry.mjs
export { audio } from '@/engine/audio/state';
export {
  updateFamilySample, stopFamilySample, isFamilySampleActive, _sampleInternals,
} from '@/engine/audio/sampleEngine';
// H1273: the probe also needs real car data + the per-car voice, so it can
// drive the crossfade with the RX-7 FD's actual idle/redline/rateMul instead
// of nominal numbers.
export { CAR_CATALOG } from '@/config/cars/catalog';
export { computeEngineVoice } from '@/engine/audio/engineVoice';
export { resolveEngineFamily } from '@/config/cars/engineFamily';

export { safeRateWindow } from '@/engine/audio/engineVoice';
export { ICONIC_VOICES, ICONIC_PATTERNS, iconicVoiceFor } from '@/engine/audio/iconicVoices';
export { familyMedianCc, carDisplacementCc, carVoiceCc } from '@/config/cars/engineFamily';
