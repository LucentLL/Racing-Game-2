// physlab entry — bundle target for headless Phase 0B physics runs.
// Re-exports everything the step-steer harness needs from src.
// Build (from repo root):
//   npx esbuild tools/physlab/entry.ts --bundle --alias:@=./src --format=esm --outfile=tools/physlab/physlab.mjs
export {
  createPhase0BIntegratorState,
  tickPhase0BIntegrator,
  type Phase0BIntegratorState,
  type Phase0BStepInputs,
  type Phase0BSettings,
  type Phase0BCarSpec,
} from '@/physics/phase0BIntegrator';
export { buildPhase0BCarSpec, computeCarTurnRate } from '@/physics/phase0BCatalogAdapter';
export {
  computeDesiredYawRate,
  computeMassDamp,
  computeEffectiveSteerInput,
} from '@/physics/steering';
export { isBicycleModelEligible, BICYCLE_MIN_SPEED } from '@/physics/bicycleModel';
export { CAR_CATALOG, ALL_CAR_IDS, type CatalogCar } from '@/config/cars/catalog';
export { GT4_SPECS } from '@/config/cars/gt4Database';
export { SCALE_MS, MPH_PER_MS, wpxsToMph } from '@/physics/physicsUnits';
export { MAP_W, MAP_H, TILE } from '@/config/world/tiles';
// H1105: camera-orientation pipeline for the camera-jerk probe (camjerk.mjs) —
// lets the harness replicate the FULL on-screen motion (world rotation + sway),
// not just the physics.
export {
  tickPVelAngleFilter,
  selectCamTarget,
  tickPCamAngle,
  CAM_SLIP_FULL,
} from '@/physics/cameraOrientation';
// H1107: arcade longitudinal advance for the full-loop repro probe
// (fullcircle.mjs) — replicates the REAL gameLoop order (advancePSpeed →
// snapshot → integrator tick → pSpeed restore), which the integrator-only
// probes skip.
export { advancePSpeed } from '@/physics/arcadeUpdate';
