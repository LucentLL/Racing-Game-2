/**
 * AI tow-truck arrival sequence — dispatched when the player's car breaks
 * down (LIFE.broken). Drives to the player's stalled position, reverses
 * into pickup posture, winches the car onto the flatbed, and departs.
 *
 * Ported from monolith L8694-8824 (updateIncomingTow + finishIncomingTow).
 * Distinct from the PLAYER'S tow job (which has its own state machine);
 * this is the recovery service that PICKS UP the player.
 *
 * SCAFFOLD status: state shape + entry signatures; bodies stubbed.
 */

export type IncomingTowPhase = 'arriving' | 'reversing' | 'loading' | 'departing';

export interface IncomingTow {
  /** World position of the tow truck. */
  x: number;
  y: number;
  /** Tow truck heading. */
  angle: number;
  /** Forward speed for the drive-up phase. */
  speed: number;
  /** Current phase. */
  phase: IncomingTowPhase;
  /** Stalled car's resting position (winch origin during loading). */
  playerCarX?: number;
  playerCarY?: number;
  /** Loading-animation progress 0..1 (loading phase only). */
  loadProg: number;
  /** Cached destination angle for the reversing phase. */
  reverseTarget?: number;
}

/** Per-frame state machine update. Advances loadProg, drives the truck to
 *  pickup posture, finalizes after departing.
 *
 *  TODO(C25-followup): port monolith L8694-8810. */
export function updateIncomingTow(
  _tow: IncomingTow,
  _playerX: number,
  _playerY: number,
  _dt: number,
): void {
  // TODO: L8694-8810.
}

/** Called when the tow truck reaches the off-screen despawn point.
 *  Hands control back to the sim layer (player's car appears at the
 *  mechanic shop next slot). */
export function finishIncomingTow(_tow: IncomingTow): void {
  // TODO(C25-followup): port from L8810-8824.
}
