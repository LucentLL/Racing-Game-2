/**
 * FaultEffects → Phase 0B integrator-faults bridge.
 *
 * The aggregated [[FaultEffects]] struct produced by computeFaultEffects
 * (src/sim/faultEffects.ts) carries the per-frame multipliers/flags that
 * the Phase 0B integrator's force pipeline reads — but the integrator's
 * own `Phase0BStepInputs.faults` shape is a tightly-scoped subset that
 * adds one derived flag (`engineStallActive`) the FaultEffects pipeline
 * doesn't model.
 *
 * H500: this small adapter copies the eight common fields through and
 * computes engineStallActive from LIFE.broken + LIFE.breakdownType. Pure
 * function; no allocation outside the return value.
 *
 * WHY engineStallActive ISN'T ON FaultEffects: engine stall is a
 * breakdown state (LIFE.broken / breakdownType), not a "fault" in the
 * accumulating-degradation sense FaultEffects models (alignment,
 * suspension wear, brake-disc warp, etc.). The monolith treats it as
 * an independent gate that applies the SAME power-steering-reduction
 * curve at the same point in the yaw pipeline — see Phase 0B step 10
 * (H491's applyYawFaults) and the upstream steering chain (H496's
 * computeDesiredYawRate) for the two firing points.
 */

import type { FaultEffects } from '@/sim/faultEffects';
import type { Phase0BStepInputs } from './phase0BIntegrator';

/** Convenience alias for the integrator's faults sub-shape — pulled
 *  out for readability in the adapter signature. */
type IntegratorFaults = Phase0BStepInputs['faults'];

/** The breakdownType string the monolith checks for at L25999 and
 *  L24777 to fire the engine-stall PS-loss gate. Hardcoded as a
 *  literal in both places in the monolith; centralized here as the
 *  one canonical value so future renames don't have to track down
 *  every gate.
 *
 *  Matches monolith `LIFE.breakdownType==='ENGINE STALL'`. */
export const ENGINE_STALL_BREAKDOWN_TYPE = 'ENGINE STALL';

/** Translate the aggregated FaultEffects struct + breakdown state into
 *  the Phase 0B integrator's faults sub-shape.
 *
 *  FIELD MAPPING:
 *    accelMult         ← fx.accelMult
 *    brakeMult         ← fx.brakeMult
 *    gripMult          ← fx.gripMult
 *    fuelMult          ← fx.fuelMult
 *    steerPull         ← fx.steerPull
 *    steerSlow         ← fx.steerSlow
 *    shiftMult         ← fx.shiftMult
 *    rpmFlutter        ← fx.rpmFlutter
 *    engineStallActive ← !!broken && breakdownType === 'ENGINE STALL'
 *
 *  The five FaultEffects fields the integrator DOESN'T read
 *  (engineWearMult, nightVisMult, hideGauges, and the two
 *  not-actually-on-FaultEffects render flags) stay on the source
 *  struct and feed render / audio / wear-rate code paths separately.
 *
 *  Pure function. Allocates a new IntegratorFaults each call (cheap;
 *  ~70 bytes per object × ~60 fps = trivial).
 *
 *  Caller (the runtime adapter, H501) is responsible for sourcing
 *  the FaultEffects struct from ctx.faultEffects each frame and the
 *  breakdown flags from ctx.life. */
export function buildPhase0BFaults(
  fx: FaultEffects,
  broken: boolean | undefined,
  breakdownType: string | undefined,
): IntegratorFaults {
  return {
    accelMult: fx.accelMult,
    brakeMult: fx.brakeMult,
    gripMult: fx.gripMult,
    fuelMult: fx.fuelMult,
    steerPull: fx.steerPull,
    steerSlow: fx.steerSlow,
    shiftMult: fx.shiftMult,
    rpmFlutter: fx.rpmFlutter,
    engineStallActive: !!broken && breakdownType === ENGINE_STALL_BREAKDOWN_TYPE,
  };
}
