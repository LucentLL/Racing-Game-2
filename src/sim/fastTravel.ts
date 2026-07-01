/**
 * H961: Simulation-mode fast travel — tap a destination pin on the
 * full-screen map and arrive there as if you drove.
 *
 * Design rule (cozy/sim mode, see project_cozy_sim_mode memory):
 * simulated activities go through the SAME economy code as real play.
 * A fast travel therefore charges exactly what the drive would have:
 *
 *   - fuel:      dist × FUEL_BURN_PER_UNIT × faultEffects.fuelMult
 *                (identical to advancePSpeed's per-frame burn — a
 *                leaky O2 sensor makes fast travel thirstier too)
 *   - odometer:  += dist game units (same accumulator as gameLoop H76)
 *   - wear:      the H78 per-unit factors × the same mileage wearMult
 *                ramp (tires 0.001/u, engine 0.0005/u × engineWearMult,
 *                paint 0.0001/u). No drift bonus — a chauffeured
 *                A-to-B trip doesn't drift.
 *   - faults:    the same six H535 threshold rolls fire after wear,
 *                and H528 hidden-fault reveal ticks on the new odo —
 *                without these a sim-mode player's car never breaks
 *                and the repair economy starves.
 *
 * Teleport pose mutation mirrors finishIncomingTow (the tow-home warp
 * that already ships): set px/py + pSpeed=0 and let the per-frame
 * systems re-derive everything else. Arrival side effects (job A/B
 * pickup/delivery, office modal, home hint, gas-pump menu) fire
 * NATURALLY on the next frames because the player simply IS there and
 * every arrival check is a per-frame proximity test — pSpeed=0 also
 * satisfies the truck-driver near-stop gate.
 *
 * No time cost: real driving doesn't consume day slots either (the
 * clock is slot-based), so charging time here would make simulation
 * MORE expensive than driving.
 */

import type { LifeState } from '@/state/life';
import type { PlayerState } from '@/state/player';
import type { FaultEffects } from '@/sim/faultEffects';
import { FUEL_BURN_PER_UNIT } from '@/physics/arcadeUpdate';
import { gameUnitsToMiles } from '@/physics/physicsUnits';
import { CAR_CATALOG } from '@/config/cars/catalog';
import { getMileageTier } from '@/sim/mileageTier';
import { diagnoseFault, type DiagnoseFaultDeps, type ExistingFaultLike } from '@/sim/diagnoseFault';
import { tickHiddenFaultReveal } from '@/sim/hiddenFaultReveal';

/** A travelable destination pin, cached on life._mapTravelPins by
 *  drawFullMap at paint time (same paint-time rect-cache pattern as
 *  the pause menu's _opt* rows) and hit-tested by the gameLoop tap
 *  router. sx/sy are SCREEN px on the hud canvas; wx/wy are WORLD px. */
export interface TravelPin {
  sx: number;
  sy: number;
  wx: number;
  wy: number;
  /** Player-facing name for the arrival notif ("HOME", "PICKUP"…). */
  label: string;
}

/** Tap hit radius around a pin center, screen px. Pins paint at r=5
 *  with a label to the right — 14 gives a comfortable touch target
 *  without letting two city-adjacent pins swallow each other. */
export const TRAVEL_PIN_HIT_R = 14;

export type FastTravelResult =
  | { ok: true; msg: string }
  | { ok: false; msg: string };

/** Everything fastTravelTo mutates or reads, handed in by the caller
 *  (gameLoop's tap router) so this module stays global-free like the
 *  rest of sim/. */
export interface FastTravelDeps {
  life: LifeState;
  player: PlayerState;
  faultEffects: FaultEffects;
}

/** Teleport the player to `pin`, charging the drive's fuel/odo/wear.
 *  Returns a result whose msg the caller surfaces as a notif either
 *  way (arrival confirmation or the reason travel was refused). */
export function fastTravelTo(deps: FastTravelDeps, pin: TravelPin): FastTravelResult {
  const { life, player, faultEffects } = deps;

  // --- Guards: same reasons a real drive couldn't happen. ---
  if (life.broken) {
    return { ok: false, msg: "🔧 Car won't start — deal with the breakdown first." };
  }
  const racePhase = life.race?.phase;
  if (racePhase === 'approach' || racePhase === 'travel'
      || racePhase === 'countdown' || racePhase === 'racing') {
    return { ok: false, msg: '🏁 Finish the race first.' };
  }

  const dx = pin.wx - player.px;
  const dy = pin.wy - player.py;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist < 1) return { ok: true, msg: `📍 Already at ${pin.label}.` };

  // --- Fuel: exact advancePSpeed burn for this distance. ---
  const fuelMult = faultEffects.fuelMult || 1;
  const burn = dist * FUEL_BURN_PER_UNIT * fuelMult;
  if (player.fuel <= burn) {
    return { ok: false, msg: '⛽ Not enough fuel for that trip.' };
  }
  player.fuel = Math.max(0, player.fuel - burn);
  // Mirror into life.fuel (0..100). REQUIRED: the gas-pump close-sync
  // in gameLoop restores player.fuel from life.fuel whenever life.fuel
  // reads higher — burning only the runtime pool would get refunded.
  life.fuel = player.fuel * 100;

  // --- Odometer: same accumulator as the H76 per-frame block. ---
  const activeCarId = life.ownedCars[0];
  let revealMsg: string | null = null;
  if (activeCarId) {
    const odos = life.carOdometers ?? (life.carOdometers = {});
    odos[activeCarId] = (odos[activeCarId] ?? 0) + dist;

    // --- Wear: H78 per-unit factors × the same mileage ramp. ---
    const odoUnits = odos[activeCarId];
    const wearMult = 1 + gameUnitsToMiles(odoUnits) / 100000;
    const engWear = faultEffects.engineWearMult;
    life.tires  = Math.max(0, life.tires  - 0.001  * dist * wearMult);
    life.engine = Math.max(0, life.engine - 0.0005 * dist * wearMult * engWear);
    life.paint  = Math.max(0, life.paint  - 0.0001 * dist * wearMult);

    // --- Fault rolls: the six H535 threshold checks. notify stays
    // silent here — the diagnosed fault lands in life.faults and the
    // caller's arrival notif keeps the screen to one toast; the
    // REPAIRS tab shows the new fault like it does for driven wear.
    const activeCar = CAR_CATALOG[activeCarId];
    if (activeCar) {
      const faultDeps: DiagnoseFaultDeps = {
        faults: life.faults as ExistingFaultLike[],
        origin: activeCar.origin,
        mileageTier: getMileageTier(odoUnits),
        notify: () => { /* arrival toast wins; fault shows in REPAIRS */ },
      };
      if (life.engine < 40) diagnoseFault(faultDeps, 'engine');
      if (life.tires  < 40) diagnoseFault(faultDeps, 'tires');
      if (life.carHP  < 40) diagnoseFault(faultDeps, 'hp');
      if (life.engine < 15) diagnoseFault(faultDeps, 'engine', true);
      if (life.tires  < 15) diagnoseFault(faultDeps, 'tires',  true);
      if (life.carHP  < 15) diagnoseFault(faultDeps, 'hp',     true);
    }

    // --- Hidden-fault reveal: distance-driven, so a long fast travel
    // can surface a used car's hidden issue exactly like driving it.
    const reveal = tickHiddenFaultReveal(life, odoUnits);
    if (reveal) revealMsg = '⚠ HIDDEN ISSUE FOUND: ' + reveal.name;
  }

  // --- Teleport: finishIncomingTow's proven pose mutation. ---
  player.px = pin.wx;
  player.py = pin.wy;
  player.pSpeed = 0;

  const mi = gameUnitsToMiles(dist);
  const arrival = `📍 Traveled to ${pin.label} — ${mi < 0.1 ? '<0.1' : mi.toFixed(1)} mi`;
  return { ok: true, msg: revealMsg ? `${arrival} · ${revealMsg}` : arrival };
}
