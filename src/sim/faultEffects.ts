/**
 * FAULT_EFFECTS — per-fault gameplay-effect multipliers + aggregator.
 *
 * The H-era body ports populated life.faults from impacts (zone-aware
 * body damage in src/sim/faults.ts maybeTriggerZoneFault) and from
 * test-drive purchases (src/sim/sellerTestDrive.ts). They render in
 * the pause-menu STATUS tab. But the modular runtime has been
 * IGNORING those faults' actual effects on gameplay since extraction
 * — comments in sellerTestDrive.ts:15, pauseMenu.ts:376, and
 * inspection.ts:44 all explicitly note "FAULT_EFFECTS isn't ported."
 *
 * This commit lands the data + aggregator. Each fault id maps to an
 * EffectEntry that contributes to one or more output multipliers /
 * flags. computeFaultEffects walks life.faults and aggregates them
 * the same way monolith _faultFX is built per frame at L43180-43200:
 *   multiply: accelMult, fuelMult, gripMult, brakeMult
 *   add (signed): steerPull
 *   max:      shiftMult, engineWearMult
 *   min:      nightVisMult
 *   or:       rpmFlutter, steerSlow, hideGauges
 *
 * Subsequent H commits wire individual effect classes into the live
 * physics + audio + render paths (one class per commit, per the
 * migration cadence):
 *   H248 — accelMult into arcadeUpdate's throttle/power band.
 *   H249 — gripMult into the steering+cornering computation.
 *   H250 — brakeMult into the brake decel.
 *   H251 — fuelMult into the per-frame fuel burn.
 *   H252 — steerPull (random direction per fault) into yaw input.
 *   H253 — nightVisMult into the headlight cone + night tint.
 *   H254 — rpmFlutter / steerSlow / hideGauges into HUD + audio.
 *   H255 — desc lines into pause-menu STATUS tab + inspection +
 *          sellerTestDrive symptoms.
 *
 * Until those land, computeFaultEffects is a pure function returning
 * a freshly-allocated FaultEffects each call — no module-level
 * cache, no behavioral change.
 *
 * 1:1 port of monolith L43132-43200.
 */

/** Per-fault gameplay-effect entry. All fields optional — only the
 *  ones a given fault contributes to. */
export interface EffectEntry {
  /** Engine power multiplier. <1 reduces throttle response. */
  accelMult?: number;
  /** Fuel-burn multiplier. >1 burns more per unit distance. */
  fuelMult?: number;
  /** Tire grip multiplier. <1 reduces cornering authority. */
  gripMult?: number;
  /** Brake force multiplier. <1 reduces stopping power. */
  brakeMult?: number;
  /** Steering pull MAGNITUDE. The aggregator multiplies by a per-
   *  fault random direction (±1) cached on the fault entry to keep
   *  the pull-direction stable across frames. */
  steerPull?: number;
  /** Shift delay multiplier (slip / hesitation). >1 = sluggish. */
  shiftMult?: number;
  /** Engine wear-rate multiplier. >1 = degrades faster. */
  engineWearMult?: number;
  /** Night vision multiplier. <1 = dimmer headlights + tint. */
  nightVisMult?: number;
  /** RPM gauge flutters around the target instead of tracking it. */
  rpmFlutter?: boolean;
  /** Steering response slowed (heavy steering). */
  steerSlow?: boolean;
  /** Gauges hidden (no speedo / tach readout). */
  hideGauges?: boolean;
  /** Player-facing description shown in STATUS tab + inspection. */
  desc: string;
}

/** Output of computeFaultEffects. Same shape as monolith _faultFX. */
export interface FaultEffects {
  accelMult: number;
  fuelMult: number;
  gripMult: number;
  brakeMult: number;
  steerPull: number;
  shiftMult: number;
  engineWearMult: number;
  nightVisMult: number;
  rpmFlutter: boolean;
  steerSlow: boolean;
  hideGauges: boolean;
}

/** Identity element — no faults = no effects. */
export function makeIdentityFaultEffects(): FaultEffects {
  return {
    accelMult: 1,
    fuelMult: 1,
    gripMult: 1,
    brakeMult: 1,
    steerPull: 0,
    shiftMult: 1,
    engineWearMult: 1,
    nightVisMult: 1,
    rpmFlutter: false,
    steerSlow: false,
    hideGauges: false,
  };
}

/** Fault catalog — id → effect entry. 1:1 port of monolith
 *  L43132-43175. v8.99.104 fixes preserved: VCG is external leak
 *  (no oil consumption), PS_LEAK drops gripMult and only raises
 *  steering effort. */
export const FAULT_EFFECTS: Readonly<Record<string, EffectEntry>> = {
  // --- ENGINE FAULTS ---
  o2_sensor:         { accelMult: 0.90, fuelMult: 1.30, desc: 'Runs rich — more fuel, less power' },
  spark_plugs:       { accelMult: 0.85, fuelMult: 1.15, rpmFlutter: true, desc: 'Misfires — rough idle, weak accel' },
  timing_belt:       { accelMult: 0.80, engineWearMult: 1.5, desc: 'Timing off — power loss, engine stress' },
  valve_cover_gasket:{ accelMult: 0.92, fuelMult: 1.10, engineWearMult: 1.3, desc: 'Oil seeps onto head — slight power loss' },
  oil_leak:          { accelMult: 0.95, engineWearMult: 2.0, desc: 'Leaking oil — engine wears fast' },
  oil_pan_gasket:    { accelMult: 0.95, engineWearMult: 2.0, desc: 'Leaking oil — engine wears fast' },
  trans_hesitation:  { accelMult: 0.80, shiftMult: 2.5, desc: 'Delayed shifts — sluggish response' },
  trans_slip:        { accelMult: 0.55, shiftMult: 3.0, fuelMult: 1.20, desc: 'Trans slipping — major power loss' },
  intake_manifold:   { accelMult: 0.78, fuelMult: 1.15, rpmFlutter: true, desc: 'Vacuum leak — rough, weak power' },
  cam_sensor:        { accelMult: 0.82, rpmFlutter: true, desc: 'Intermittent misfires — power cuts' },
  alternator:        { nightVisMult: 0.5, desc: 'Dim lights — reduced visibility at night' },
  cooling_fail:      { engineWearMult: 3.0, accelMult: 0.88, desc: 'Overheating risk — engine degrades fast' },
  carbon_buildup:    { accelMult: 0.85, fuelMult: 1.10, desc: 'Clogged — sluggish throttle response' },
  battery_drain:     { nightVisMult: 0.6, desc: 'Weak battery — dim electrics' },
  electrical_sensor: { accelMult: 0.88, rpmFlutter: true, desc: 'Sensor glitch — random power drops' },

  // --- TIRE/SUSPENSION FAULTS ---
  strut_bushings:    { gripMult: 0.82, desc: 'Sloppy suspension — less grip in turns' },
  strut_wear:        { gripMult: 0.82, desc: 'Worn struts — bouncy, poor grip' },
  control_arm_bush:  { gripMult: 0.88, steerPull: 0.15, desc: 'Loose arms — wanders, grip reduced' },
  control_arm_rust:  { gripMult: 0.85, steerPull: 0.12, desc: 'Corroded arms — pulls, reduced grip' },
  ps_leak:           { steerSlow: true, desc: 'Heavy steering — slow turn response' },
  alignment:         { steerPull: 0.25, desc: 'Pulls to one side constantly' },
  tire_wear:         { gripMult: 0.78, desc: 'Bald patches — much less grip' },
  rotor_warp:        { brakeMult: 0.65, desc: 'Warped rotors — weak, pulsing brakes' },
  ball_joint:        { gripMult: 0.85, steerPull: 0.10, desc: 'Loose joint — vague steering' },
  air_susp_leak:     { gripMult: 0.75, desc: 'Suspension collapsed — poor grip, easy spin' },
  sport_brake_wear:  { brakeMult: 0.70, desc: 'Worn pads — reduced stopping power' },
  bushing_clunk:     { gripMult: 0.88, desc: 'Loose bushings — imprecise handling' },

  // --- BODY/COSMETIC FAULTS ---
  minor_rust:        { desc: 'Surface rust — cosmetic only' },
  paint_fade:        { desc: 'Clear coat gone — cosmetic only' },
  bumper_crack:      { desc: 'Cracked bumper — cosmetic only' },
  exhaust_rust:      { accelMult: 0.96, desc: 'Exhaust leak — slight backpressure loss' },
  exhaust_rot:       { accelMult: 0.95, desc: 'Rotted exhaust — backpressure loss' },
  frame_rust:        { gripMult: 0.92, desc: 'Weakened frame — flex reduces grip' },
  panel_rust:        { desc: 'Body rust — cosmetic only' },
  bumper_dent:       { desc: 'Dented bumper — cosmetic only' },
  electrical_gremlin:{ nightVisMult: 0.6, rpmFlutter: true, desc: 'Random electrical — lights/gauges glitch' },
  display_failure:   { hideGauges: true, desc: 'Gauges dead — no speedo/tach readout' },
  paint_bubble:      { desc: 'Paint bubbling — cosmetic only' },
  trim_rattle:       { desc: 'Rattles — annoying but harmless' },
};

/** Per-fault state the aggregator needs access to — minimally just
 *  the fault id and the cached pull direction (lazy-initialized so
 *  the pull stays stable for a given fault entry across frames).
 *  The body-port Fault interface in src/sim/faults.ts is wider; this
 *  is the subset computeFaultEffects actually touches. */
export interface FaultLike {
  id: string;
  _pullDir?: number;
}

/** Aggregate every active fault into a combined FaultEffects record.
 *  Pure function — returns a fresh object each call. Callers cache
 *  per frame (H248+ will plumb this through the per-frame physics
 *  tick). 1:1 port of monolith computeFaultEffects at L43180-43200. */
export function computeFaultEffects(faults: readonly FaultLike[]): FaultEffects {
  const fx = makeIdentityFaultEffects();
  for (const f of faults) {
    const e = FAULT_EFFECTS[f.id];
    if (!e) continue;
    if (e.accelMult !== undefined) fx.accelMult *= e.accelMult;
    if (e.fuelMult !== undefined) fx.fuelMult *= e.fuelMult;
    if (e.gripMult !== undefined) fx.gripMult *= e.gripMult;
    if (e.brakeMult !== undefined) fx.brakeMult *= e.brakeMult;
    if (e.steerPull !== undefined) {
      // Stable per-fault random direction — the first call assigns
      // ±1, subsequent calls reuse it. Mutates the fault entry in
      // place, matching monolith L43190 behavior.
      if (f._pullDir === undefined) f._pullDir = Math.random() > 0.5 ? 1 : -1;
      fx.steerPull += e.steerPull * f._pullDir;
    }
    if (e.shiftMult !== undefined) fx.shiftMult = Math.max(fx.shiftMult, e.shiftMult);
    if (e.engineWearMult !== undefined) fx.engineWearMult = Math.max(fx.engineWearMult, e.engineWearMult);
    if (e.nightVisMult !== undefined) fx.nightVisMult = Math.min(fx.nightVisMult, e.nightVisMult);
    if (e.rpmFlutter) fx.rpmFlutter = true;
    if (e.steerSlow) fx.steerSlow = true;
    if (e.hideGauges) fx.hideGauges = true;
  }
  return fx;
}
