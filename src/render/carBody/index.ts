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

export { darken, lighten } from './colorUtils';

import type { GenerationRenderer } from './types';
import { RX7_FD } from './genData/rx7Fd';
import { RX7_FC } from './genData/rx7Fc';
import { FOCUS_WRC } from './genData/focusWrc';
import { IMPREZA_GC8 } from './genData/imprezaGc8';
import { EVO6_RALLY } from './genData/evo6Rally';
import { SUPRA_A80 } from './genData/supraA80';
import { SUPRA_A70 } from './genData/supraA70';
import { GTR_R34 } from './genData/gtrR34';
import { GTR_R33 } from './genData/gtrR33';
import { GTR_R32 } from './genData/gtrR32';

/**
 * The per-generation render registry. Populated as C19b proceeds with
 * one entry per chassis (rx7_fd, gtr_r34, nsx_na, miata_na, civic_ek,
 * civic_eg, ae86, dodge_viper, etc.). drawCarBodyV2 (C19b dispatcher,
 * still pending) reads by id; unknown ids fall through to the legacy
 * bodyType silhouette in drawTopCar (C19c).
 *
 * v126.89 aliases many chassis to gtr_r34 as a placeholder fallback
 * until per-gen renderers are authored; those aliases will live
 * alongside their distinct renderers when they're ported.
 */
export const GEN_DATA: Record<string, GenerationRenderer> = {
  rx7_fd: RX7_FD,
  rx7_fc: RX7_FC,
  focus_wrc: FOCUS_WRC,
  impreza_gc8: IMPREZA_GC8,
  evo6_rally: EVO6_RALLY,
  supra_a80: SUPRA_A80,
  supra_a70: SUPRA_A70,
  gtr_r34: GTR_R34,
  gtr_r33: GTR_R33,
  gtr_r32: GTR_R32,

  // Placeholder aliases — the V2 sprite branch's gate is
  // `!!(genId && GEN_DATA[genId])`, so any chassis whose PNG is in the
  // VEHICLE_IMAGE_MANIFEST must have a GEN_DATA entry even when no
  // dedicated vector silhouette is authored. GTR_R34 is used as the
  // generic-coupe vector fallback; it only paints during the brief
  // window before the PNG finishes loading.
  gtr_r34_vspec:   GTR_R34,
  nsx_na:          GTR_R34, // mid-engine but coupe proportions
  silvia_180sx:    GTR_R34, // hatchback; vector unused once PNG loads
  miata_na:        GTR_R34, // roadster; vector unused once PNG loads
  dodge_viper:     GTR_R34,
  plymouth_cuda:   GTR_R34,
  dodge_charger:   GTR_R34,
  audi_quattro:    GTR_R34,
  dodge_super_bee: GTR_R34, // Coronet Super Bee `70 (B-body)
  ruf_btr:         GTR_R34, // RUF BTR `86 (911-based RR)
  ruf_ctr_yb:      GTR_R34, // RUF CTR "Yellow Bird" `87
  ruf_ctr2:        GTR_R34, // RUF CTR2 `96 (993-based 4WD)
  ae86:            GTR_R34, // Toyota Corolla AE86 Levin / Sprinter Trueno
};
