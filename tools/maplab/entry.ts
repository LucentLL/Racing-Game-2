// H1239/H1243 probe entry: re-exports the active-map runtime + registry so a
// plain node harness can assert which building/surface/lot rows a map hands the
// render passes, and render authored geometry (pit paddocks) to SVG.
// Bundle with:
//   npx esbuild tools/maplab/entry.ts --bundle --alias:@=./src --format=esm --outfile=tools/maplab/maplab.mjs
export {
  getActiveMapId,
  setActiveMapId,
  getActiveMapLots,
  getActiveMapBuildings,
  getActiveMapSurfaces,
} from '@/world/mapRuntime';
export { getMapDef, listMaps, buildPitPaddock } from '@/world/mapRegistry';
export { REAL_TRACKS } from '@/config/world/realTracks';
export { _weGarageRect } from '@/editor/stamp';
export { buildTrackPath, advanceTrackAI, cornerSpeedCap, poseAt, nearestS } from '@/sim/trackAI';
export { advanceOppPhysics, generateRaceOpponent } from '@/sim/race';
export { CAR_CATALOG } from '@/config/cars/catalog';
export { TILE, WPX_PER_M } from '@/config/world/tiles';
