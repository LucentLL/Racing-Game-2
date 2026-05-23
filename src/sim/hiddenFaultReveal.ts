/**
 * Hidden-fault reveal during driving — surfaces a used-car's
 * pre-existing hidden faults gradually as the player drives the
 * car. Each fault reveals after ~500-2000 game units of driving
 * since the last reveal (or since car-acquisition for the first
 * one).
 *
 * H528: 1:1 port of monolith L42038-L42049 inside the per-frame
 * wear-tick block. Pure mutator on LifeState; returns a
 * descriptor when a fault revealed this frame so the caller can
 * surface a notif.
 *
 * The HIDDEN-FAULTS POOL is seeded by generateUsedCarFaults at
 * car-purchase time (via the sellerVisit / inspection flows) —
 * each generated PreFault that doesn't surface via INSPECT or the
 * test-drive end-roll lands in _hiddenFaults. From there it
 * reveals organically through driving rather than appearing all
 * at once.
 *
 * WHY DRIVE-BASED REVEAL (not random per-frame): faults manifest
 * symptomatically — a worn fuel pump doesn't "appear" when you
 * walk past the car; it reveals when the engine starts to
 * stumble during a drive. The 500-2000 unit threshold (≈ 0.06-
 * 0.26 mi at the 0.0001278 unit/mi conversion) corresponds to
 * 1-5 minutes of typical driving — fast enough that the player
 * notices issues during their first job runs, slow enough that
 * a purchase doesn't feel like immediate fault-spam.
 *
 * DEDUPE: caller's life.faults may already carry a fault with
 * the same name (e.g. INSPECT surfaced it, then it appeared in
 * _hiddenFaults too — rare but possible). The reveal silently
 * drops duplicates by name match rather than double-adding.
 */

import type { LifeState } from '@/state/life';

/** Minimum driving distance (game units) between hidden-fault
 *  reveals. Matches monolith `500 + Math.random() * 1500` floor
 *  at L42041. */
export const HIDDEN_FAULT_REVEAL_MIN_UNITS = 500;

/** Random range (game units) added to the minimum threshold per
 *  reveal — so each reveal is 500-2000 units apart with uniform
 *  distribution. Matches monolith range at L42041. */
export const HIDDEN_FAULT_REVEAL_RANGE_UNITS = 1500;

/** PreFault-like shape — `unknown[]` is the storage type on
 *  LifeState (the modular tree's faults system uses structural
 *  typing rather than nominal class so save serialization stays
 *  trivial). Caller-side cast captures the fields the reveal
 *  consumer needs. */
interface RevealableFault {
  name?: string;
  [key: string]: unknown;
}

/** Result of [[tickHiddenFaultReveal]]. `null` when nothing
 *  revealed this frame (most common — happens once per ~1000
 *  game units). When a fault reveals, returns the name for the
 *  caller's notif. */
export type HiddenFaultRevealResult =
  | null
  | { kind: 'revealed'; name: string };

/** Per-frame hidden-fault reveal check. Caller invokes from the
 *  wear-tick branch (guarded on spd > 5 && !broken, same as the
 *  monolith's L42038 block).
 *
 *  ARGS:
 *    life            mutated: faults pushed, _hiddenFaultOdo
 *                    advanced when a reveal fires.
 *    currentOdo      the active car's accumulated game-unit
 *                    distance (carOdometers[activeCarId]).
 *
 *  Returns null when:
 *    - No hidden faults remain to reveal.
 *    - Driven distance since last reveal hasn't crossed the
 *      random [500, 2000) threshold.
 *    - The revealed fault's name was already in life.faults
 *      (dedupe).
 *
 *  Returns `{ kind: 'revealed', name }` when a fault successfully
 *  surfaces. Caller surfaces a `'⚠ HIDDEN ISSUE FOUND: <name>'`
 *  notif. */
export function tickHiddenFaultReveal(
  life: LifeState,
  currentOdo: number,
): HiddenFaultRevealResult {
  const hidden = life._hiddenFaults as RevealableFault[] | undefined;
  if (!hidden || hidden.length === 0) return null;

  const baseOdo = life._hiddenFaultOdo ?? 0;
  const driven = currentOdo - baseOdo;
  const threshold = HIDDEN_FAULT_REVEAL_MIN_UNITS + Math.random() * HIDDEN_FAULT_REVEAL_RANGE_UNITS;
  if (driven <= threshold) return null;

  const hf = hidden.shift();
  life._hiddenFaultOdo = currentOdo;
  if (!hf || !hf.name) return null;

  // Dedupe by name — if another path already surfaced this fault,
  // don't double-add.
  const faults = life.faults as RevealableFault[];
  if (faults.find((f) => f.name === hf.name)) return null;

  faults.push({ ...hf });
  return { kind: 'revealed', name: hf.name };
}
