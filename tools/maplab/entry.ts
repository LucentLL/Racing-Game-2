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
// H1267: start/finish line + starting-grid geometry, so startgrid.mjs can dump
// the EXACT quads the renderer bakes into Path2Ds to SVG and look at them.
export { rebuildRenderEntries, RENDER_ENTRIES } from '@/render/worldMap';
export {
  buildStartDecals, startLineOn, arcOfTile, projectS, densifyFlat,
  trackEntryFor, trackPathFor,
} from '@/world/startLine';
export { asphaltHalfPx } from '@/render/roads/crossingGeom';
export { EDGE_MARGIN, drawStartGrid, drawStartGridGlow, resetStartGrid } from '@/render/startGrid';
export * as START_GRID from '@/config/world/startGrid';
// H1269: lap-integrity probe surface (startLineOn / trackPathFor already above).
export { _lapInternals } from '@/sim/trackRace';
