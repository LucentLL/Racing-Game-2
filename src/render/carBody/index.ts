/**
 * Public surface of the carBody render subsystem.
 *
 * Subdivision so far (C19a):
 *   - silhouette       — traceCarBodyPath (legacy bodyType silhouettes)
 *   - generation       — getCarGeneration (name → V2 chassis key)
 *   - xrayGeom         — X-Ray wheel/tire geometry from GT4_SPECS
 *   - v2Helpers        — v2GroundShadow / v2Wheels / v2TaillightGlow /
 *                        v2HeadlightGlow plus the player-tail-draw and
 *                        v2RenderCarName injection points
 *   - trafficTrailer   — AI traffic vehicle trailer body
 *
 * Lands later:
 *   - genData (C19b)   — per-chassis sprite renderers populating
 *                        the GenerationRenderer registry
 *   - drawCarBodyV2    — registry dispatcher
 *   - drawTopCar (C19c)— the main per-vehicle entry point
 *
 * GenerationRenderer / GEN_DATA shape is in types.ts so the registry
 * can be typed before C19b lands.
 */

export { traceCarBodyPath } from './silhouette';
export { getCarGeneration } from './generation';
export {
  parseTireSpec,
  xrayWheelGeomFromSpec,
  xrayCarGeom,
  drawXrayTiresFromGeom,
  xrayBikeGeom,
  xrayBikeGeomFromSpec,
  drawXrayBikeTiresFromGeom,
  TRAFFIC_BODYTYPE_SPECS,
  BIKE_FALLBACK_SPECS,
} from './xrayGeom';
export {
  v2GroundShadow,
  v2Wheels,
  v2TaillightGlow,
  v2HeadlightGlow,
  setV2PlayerTailDraw,
  getV2PlayerTailDraw,
  setV2RenderCarName,
  setTaillightFaultPredicate,
  setGT4Lookup,
} from './v2Helpers';
export type { V2TracePathFn, TaillightFaultPredicate } from './v2Helpers';
export { drawTrafficTrailer } from './trafficTrailer';
export type {
  TraceCarBodyPath,
  GT4SpecLike,
  TireSpec,
  CarWheelGeom,
  BikeWheelGeom,
  GenerationRenderer,
  GenerationRenderOpts,
} from './types';
export type { TrafficCarWithTrailer, TrafficTrailer, TrafficTrailerDeps } from './trafficTrailer';

import type { GenerationRenderer } from './types';

/**
 * The per-generation render registry. Populated by genData.ts in C19b
 * with one entry per chassis (rx7_fd, gtr_r34, nsx_na, miata_na,
 * civic_ek, civic_eg, ae86, dodge_viper, etc.). drawCarBodyV2 (also
 * C19b) dispatches by id; an unknown id falls through to the legacy
 * bodyType silhouette in drawTopCar (C19c).
 */
export const GEN_DATA: Record<string, GenerationRenderer> = {};
