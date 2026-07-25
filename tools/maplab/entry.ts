// H1239 probe entry: re-exports the active-map runtime + registry so a plain
// node harness can assert which building/surface/lot rows a map hands the
// render passes. Bundle with:
//   npx esbuild tools/maplab/entry.ts --bundle --alias:@=./src --format=esm --outfile=tools/maplab/maplab.mjs
export {
  getActiveMapId,
  setActiveMapId,
  getActiveMapLots,
  getActiveMapBuildings,
  getActiveMapSurfaces,
} from '@/world/mapRuntime';
export { getMapDef, listMaps } from '@/world/mapRegistry';
