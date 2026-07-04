/**
 * H113/H114 — traffic-signal phase logic shared between state/traffic
 * (AI brake trigger) and render/trafficSignals (visual cones).
 *
 * All ROAD_CROSSINGS use the same global phase via Date.now() — city-
 * grid synchronization. Each crossing has two perpendicular approach
 * axes (ang1, ang2). Per phase, one axis is green/yellow and the
 * other is red. Cycle:
 *
 *   t  0 ─── 7s ──── 8s ──── 15s ──── 16s ──→ wraps
 *      ang1 GREEN  YELLOW   RED      RED
 *      ang2 RED    RED      GREEN    YELLOW
 *
 * Yellow is a 1-second warning phase before red; H113's brake AI treats
 * yellow + red identically (both = stop). Real-world rule "go if too
 * close to stop safely" not modeled.
 */

export type SignalState = 'green' | 'yellow' | 'red';

/** Full cycle period in ms. */
export const SIGNAL_PERIOD_MS = 16000;
/** Green duration per axis (each axis gets one green window per cycle). */
const GREEN_MS = 7000;
/** Yellow duration per axis (warning before red). */
const YELLOW_MS = 1000;

/** H1043: per-intersection signal state — offsets the global cycle by the
 *  crossing's authored phase so lights desync instead of blinking in lockstep.
 *  `phaseOff` undefined (legacy / non-authored crossings) → the global phase,
 *  so existing behavior is unchanged. Structural param avoids importing the
 *  RoadCrossing type (and any cycle). */
export function getSignalStatesFor(
  crossing: { phaseOff?: number },
  nowMs: number,
): { ang1: SignalState; ang2: SignalState } {
  return getSignalStates(nowMs + (crossing.phaseOff ?? 0));
}

/** Return the {ang1State, ang2State} pair for the given wall-clock time. */
export function getSignalStates(nowMs: number): { ang1: SignalState; ang2: SignalState } {
  const t = ((nowMs % SIGNAL_PERIOD_MS) + SIGNAL_PERIOD_MS) % SIGNAL_PERIOD_MS;
  // ang1 has its green/yellow in the first half, red in the second.
  // ang2 is offset by half the cycle (8s).
  const half = SIGNAL_PERIOD_MS / 2;     // 8000
  const inFirstHalf = t < half;
  const localT = inFirstHalf ? t : t - half;
  const activeState: SignalState =
    localT < GREEN_MS ? 'green'
    : localT < GREEN_MS + YELLOW_MS ? 'yellow'
    : 'red';                              // shouldn't reach here, defensive
  return inFirstHalf
    ? { ang1: activeState, ang2: 'red' }
    : { ang1: 'red', ang2: activeState };
}

/** True if a signal state requires the driver to stop. Yellow + red
 *  both stop in the modular AI; real-world "yellow = stop unless too
 *  close" not modeled. */
export function isStopState(s: SignalState): boolean {
  return s === 'yellow' || s === 'red';
}
