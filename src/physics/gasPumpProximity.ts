/**
 * Gas-pump proximity check. Fires inside update() once per tick when
 * the player is near-stationary near a pump with their fuel door on
 * the correct side. Opens the fuel menu (LIFE.fuelMenuOpen = true)
 * and snaps pSpeed to zero to prevent the player from rolling away
 * mid-menu.
 *
 * Three gates must all be true before the per-pump scan even runs:
 *
 *   1. No other UI is open (fuel menu, settings, car-select, home).
 *      Otherwise re-opening the pump while in another menu would
 *      stomp UI state.
 *   2. Player is moving slowly (|pSpeed| < 3). Drive-by pumping is
 *      not a thing; the player has to come to a near-stop to
 *      trigger.
 *   3. Fuel is below 98%. Topping off the last 2% gives a fluid-
 *      friendly buffer so a player pulling up with a near-full tank
 *      doesn't get an unwanted menu pop-up.
 *
 * Per-pump checks (all must pass for a trigger):
 *
 *   a. Squared distance to pump < TILE² · 2.5 — a ~1.58-tile radius.
 *      The squared comparison avoids the sqrt in the hot path.
 *   b. Pump is on the correct fuel-door side, OR fuel door is
 *      center (C). Cross product of (pAngle direction) × (vector
 *      from car to pump) gives the perpendicular sign:
 *        cross > 0 → pump on player's RIGHT (Y-down canvas).
 *        cross < 0 → pump on player's LEFT.
 *      Center-fuel cars (some classics, EVs) bypass the side check.
 *   c. Car is sideways to the pump (|dot(forward, dirToPump)| < 0.7).
 *      Prevents triggering when the car is parked head-on with the
 *      pump in front of it, only when parked alongside.
 *
 * Monolith source: inside update() at L26550-L26579.
 */

/** World-space coordinate point — tile coords × TILE. */
export interface WorldPoint {
  wx: number;
  wy: number;
}

/** A single gas-station pump and its world position. */
export type GasPump = WorldPoint;

/** A gas station with a collection of pumps. Real Charlotte stations
 *  carry more fields (brand, fuel grades, name); the proximity check
 *  only reads `pumps`. */
export interface GasStation {
  pumps: ReadonlyArray<GasPump>;
}

/** Fuel-door position on the car. 'L' / 'R' = left/right of forward
 *  travel; 'C' = center (no side preference). */
export type FuelDoor = 'L' | 'R' | 'C';

/** Inputs to the proximity check. */
export interface GasPumpProximityState {
  /** Player world-x (px, not tiles). */
  px: number;
  /** Player world-y (px). */
  py: number;
  /** Player heading angle (radians). */
  pAngle: number;
  /** Signed forward speed (game units). */
  pSpeed: number;
  /** Fuel level 0..100 (percent). */
  fuel: number;
  /** Is any UI overlay open right now? Pass `fuelMenuOpen ||
   *  menuOpen || carSelectOpen || homeScreenOpen` — the function
   *  doesn't care which; just whether the pump menu would step
   *  on another UI. */
  anyUIOpen: boolean;
}

/** Result when a pump triggers — caller uses these to mutate global
 *  state. The function itself is pure (no mutation, no side effects). */
export interface GasPumpTriggerResult {
  triggered: true;
  /** The station whose pump fired — caller may want to record which
   *  brand / fuel grade. */
  station: GasStation;
  /** The specific pump that triggered. */
  pump: GasPump;
}

/** No-trigger result. */
export interface GasPumpNoTriggerResult {
  triggered: false;
}

export type GasPumpResult = GasPumpTriggerResult | GasPumpNoTriggerResult;

/** Min speed for ANY trigger. Above this (|pSpeed| >= 3) the check
 *  short-circuits — drive-by pumping is not a thing. */
export const PUMP_TRIGGER_MAX_SPEED = 3;

/** Max fuel level for a trigger. At or above 98%, the player doesn't
 *  need fuel and a pop-up would be annoying. */
export const PUMP_TRIGGER_MAX_FUEL = 98;

/** Pump proximity radius² scale factor — multiplied by TILE² to get
 *  the squared radius. 2.5 → ~1.58-tile radius. Wide enough that
 *  pulling up reasonably close fires but tight enough that
 *  passing-by-with-stop doesn't trigger. */
export const PUMP_RADIUS_SQ_FACTOR = 2.5;

/** Forward / direction-to-pump alignment threshold. |dot| < 0.7 →
 *  car is sideways to pump (alongside). |dot| >= 0.7 → pointing
 *  toward or away (head-on) and the trigger doesn't fire. 0.7 ≈
 *  cos(45°), so the "sideways enough" cone is ±45° around the
 *  perpendicular. */
export const PUMP_PARALLEL_DOT_THRESHOLD = 0.7;

/** Run the gas-pump proximity check for one tick. Returns the trigger
 *  result; caller mutates the LIFE state when triggered:
 *
 *    LIFE.fuelMenuOpen = true
 *    LIFE.stationTab = 'fuel'
 *    pSpeed = 0
 *
 *  The function short-circuits on the gate failures (any UI open,
 *  speed too high, fuel too high) without scanning pumps.
 *
 *  Ported 1:1 from monolith L26550-L26579.
 */
export function checkGasPumpProximity(
  state: GasPumpProximityState,
  stations: ReadonlyArray<GasStation>,
  fuelDoor: FuelDoor,
  TILE: number,
): GasPumpResult {
  if (state.anyUIOpen) return { triggered: false };
  if (Math.abs(state.pSpeed) >= PUMP_TRIGGER_MAX_SPEED) return { triggered: false };
  if (state.fuel >= PUMP_TRIGGER_MAX_FUEL) return { triggered: false };

  const radiusSq = TILE * TILE * PUMP_RADIUS_SQ_FACTOR;
  const cosA = Math.cos(state.pAngle);
  const sinA = Math.sin(state.pAngle);

  for (const station of stations) {
    for (const pump of station.pumps) {
      const dpx = state.px - pump.wx;
      const dpy = state.py - pump.wy;
      const distSq = dpx * dpx + dpy * dpy;
      if (distSq >= radiusSq) continue;

      // Center-fuel cars bypass the side check.
      if (fuelDoor === 'C') {
        return { triggered: true, station, pump };
      }

      // Cross product (pAngle direction) × (vector from car to pump):
      //   cosA * (pump.wy - py) - sinA * (pump.wx - px)
      // > 0 → pump on RIGHT (Y-down canvas), < 0 → pump on LEFT.
      const cross = cosA * (pump.wy - state.py) - sinA * (pump.wx - state.px);
      const pumpOnLeft = cross < 0;
      const pumpOnRight = cross > 0;

      // Sideways check — |dot(forward, -dirToPump)| < threshold.
      // (-dpx, -dpy) is the vector from car to pump; we read the
      // absolute alignment of forward direction with that vector.
      const dist = Math.sqrt(distSq) || 1;
      const dot = Math.abs(cosA * (-dpx / dist) + sinA * (-dpy / dist));
      const isSideOn = dot < PUMP_PARALLEL_DOT_THRESHOLD;
      if (!isSideOn) continue;

      if ((fuelDoor === 'L' && pumpOnLeft) || (fuelDoor === 'R' && pumpOnRight)) {
        return { triggered: true, station, pump };
      }
    }
  }
  return { triggered: false };
}
