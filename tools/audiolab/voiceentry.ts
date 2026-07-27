// H1270: probe entry for tools/audiolab/voicecheck.mjs — the recorded-engine
// band crossfade, drivable headlessly against a stubbed WebAudio API.
// Bundle with:
//   npx esbuild tools/audiolab/voiceentry.ts --bundle --alias:@=./src --format=esm --outfile=tools/audiolab/voiceentry.mjs
export { audio } from '@/engine/audio/state';
export {
  updateFamilySample, stopFamilySample, isFamilySampleActive, _sampleInternals,
} from '@/engine/audio/sampleEngine';
