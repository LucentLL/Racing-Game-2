// H1268 probe entry: re-exports the catalog + the family resolver so a plain
// node harness can resolve every car and audit the distribution.
// Bundle with:
//   npx esbuild tools/audiolab/famentry.ts --bundle --alias:@=./src --format=esm --outfile=tools/audiolab/famentry.mjs
export { CAR_CATALOG } from '@/config/cars/catalog';
export { GT4_SPECS } from '@/config/cars/gt4Database';
export {
  resolveEngineFamily, carMake, carCountry, carLayout, carDisplacementCc,
} from '@/config/cars/engineFamily';
