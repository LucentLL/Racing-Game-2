/**
 * Traffic cop AI — radar detection, pursuit chase, proximity-arrest meter,
 * pull-over-for-ticket flow, escape-after-50-tiles flag.
 *
 * Ported from monolith L27682-27884. Distinct from the player's traffic-
 * cop JOB (sim/jobs.ts) — this module is AI traffic that arrests the
 * player when they speed.
 *
 * SCAFFOLD status: typed entry + state shape; body stubbed.
 */

import type { TrafficCar } from './types';

export interface CopPursuitState {
  /** Index into traffic[] of the cop car. */
  copIdx: number;
  /** Pursuit phase. */
  phase: 'radar' | 'chasing' | 'bumped' | 'arresting' | string;
  /** Time since pursuit started (s). */
  pursuitTime: number;
  /** 0..1 — proximity arrest progress when player is stopped near a cop. */
  arrestMeter: number;
  /** Last known player speed (for ticket-issue speed). */
  lastSpeed: number;
}

/** Per-frame traffic-cop tick — detects speeders, advances pursuit, fires
 *  ticket issue / arrest.
 *
 *  TODO(C25-followup): port monolith L27682-27884. */
export function updateTrafficCop(
  _traffic: TrafficCar[],
  _state: CopPursuitState | null,
  _playerSpeed: number,
  _playerSpeedLimit: number,
  _dt: number,
): void {
  // TODO: L27682-27884.
}
