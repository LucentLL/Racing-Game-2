/**
 * Per-frame breakdown-recovery tick. When a breakdown fires
 * (engine stall, flat tire, overheating — set by the L42049
 * breakdown roll), `life.breakdownTimer` carries the
 * "auto-restart" countdown. This module ticks it down and
 * either restarts the engine OR flips the tow menu open at
 * expiry. Also handles the out-of-gas immediate-tow path.
 *
 * H529: 1:1 port of monolith L42090-L42112 inside the per-frame
 * update tick. Pure mutator on LifeState; returns a discriminated
 * descriptor when something happened this frame so the caller
 * can surface the right notif.
 *
 * THE TWO PATHS:
 *
 *   1. Stall recovery (LIFE.broken && LIFE.breakdownTimer > 0):
 *      - decrement timer by dt
 *      - on expiry (timer <= 0):
 *          if engine > 10 && tires > 10 && fuel > 0 → restart
 *          else → flip towMenuOpen (can't recover unaided)
 *
 *   2. Out-of-gas immediate tow:
 *      - if broken && fuel <= 0 && timer <= 0 && !towMenuOpen
 *        && !incomingTow → flip towMenuOpen
 *      - covers the case where OUT OF GAS breakdown fired but
 *        the player ignored / hasn't called tow yet.
 *
 * The ENGINE STALL breakdown type is the only one that uses the
 * timer (3-second countdown — gives the player a moment to coast
 * before deciding to tow). FLAT TIRE and OVERHEATING both set
 * breakdownTimer=0 + towMenuOpen=true at fire time, so they
 * skip the recovery branch and go straight to the out-of-gas-
 * style tow gate.
 */

import type { LifeState } from '@/state/life';

/** Engine-stat threshold above which an auto-restart succeeds.
 *  Below this the engine is too damaged to recover unaided.
 *  Matches monolith `LIFE.engine > 10` at L42098. */
export const RECOVERY_ENGINE_FLOOR = 10;

/** Tires-stat threshold. Below this the wheels are too worn to
 *  drive even after restart. Matches monolith `LIFE.tires > 10`
 *  at L42098. */
export const RECOVERY_TIRES_FLOOR = 10;

/** Fuel-stat threshold (post-decimal — 0..100 in modular).
 *  Matches monolith `LIFE.fuel > 0` at L42098. */
export const RECOVERY_FUEL_FLOOR = 0;

/** Discriminated result of [[tickBreakdownRecovery]]. */
export type BreakdownRecoveryResult =
  | null
  | { kind: 'restarted' }
  | { kind: 'tow-required' };

/** Per-frame breakdown recovery tick.
 *
 *  Returns:
 *    null              — no breakdown active OR timer still
 *                        counting down OR no state change this
 *                        frame (the common case).
 *    'restarted'       — timer hit zero AND stats let the engine
 *                        restart. Caller surfaces the monolith's
 *                        'Car restarted...' notif.
 *    'tow-required'    — timer hit zero but stats can't recover,
 *                        OR out-of-gas + idle + no tow pending.
 *                        Caller surfaces the monolith's "Car won't
 *                        start. Call a tow truck." notif (the
 *                        immediate-out-of-gas branch doesn't show
 *                        a notif in the monolith — caller can
 *                        check life.fuel <= 0 to differentiate).
 *
 *  Ported 1:1 from monolith L42090-L42112. */
export function tickBreakdownRecovery(life: LifeState, dt: number): BreakdownRecoveryResult {
  if (!life.broken) return null;

  // Stall-recovery branch — timer counting down.
  if ((life.breakdownTimer ?? 0) > 0) {
    life.breakdownTimer = (life.breakdownTimer ?? 0) - dt;
    if ((life.breakdownTimer ?? 0) > 0) return null;
    // Timer just hit zero — decide restart vs tow.
    if (
      life.engine > RECOVERY_ENGINE_FLOOR
      && life.tires > RECOVERY_TIRES_FLOOR
      && life.fuel > RECOVERY_FUEL_FLOOR
    ) {
      life.broken = false;
      life.breakdownType = '';
      return { kind: 'restarted' };
    }
    life.towMenuOpen = true;
    return { kind: 'tow-required' };
  }

  // Out-of-gas immediate-tow gate. Fires when broken + no fuel +
  // not already showing tow menu + no inbound tow.
  if (
    life.fuel <= 0
    && (life.breakdownTimer ?? 0) <= 0
    && !life.towMenuOpen
    && !life.incomingTow
  ) {
    life.towMenuOpen = true;
    return { kind: 'tow-required' };
  }

  return null;
}
