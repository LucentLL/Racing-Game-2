/**
 * H1164: water-submerge state machine — the canyon fall's sibling for
 * rivers and lakes.
 *
 * Water was only ever a paint job: tile 9 renders as water but physics
 * folds it into the grass family (playerSurface GRASS_TILE_TYPES), so
 * cars skated across rivers at off-road speed. Now driving into water
 * on a NON-fatal map (the city — fatal touge maps keep their own cliff
 * machinery) sinks the car: the sprite fades out over SINK_DURATION
 * with input frozen (the caller's fallTimer substep freeze), then the
 * car is fished out at the last on-road position for a flat fee.
 *
 * Reuses player.fallTimer for the timer so the existing physics freeze
 * (gameLoop substeps = 0 while fallTimer > 0) and the shrink/fade
 * render wrapper work unchanged; player.fallKind distinguishes the
 * water normalization/recovery from the canyon one. Debounce absorbs
 * one-frame clips of a waterline shoulder — you have to actually drive
 * in. No minimum speed: creeping into a lake still sinks.
 *
 * NOT a monolith port — sanctioned invention (the monolith also drives
 * on water); user ask 2026-07-15.
 */
import type { PlayerState } from '@/state/player';

export const SINK_DURATION = 1.4;  // seconds of submerge animation (2× the cliff drop)
const SINK_DEBOUNCE = 0.25;        // continuous in-water time before the sink fires
const SINK_HELD = 0.02;            // floor fallTimer holds at once fully sunk

let wetAccum = 0;
let sinking = false;
let lastRoadX: number | null = null;
let lastRoadY = 0;
let lastRoadA = 0;

export function resetWaterSubmerge(): void {
  wetAccum = 0;
  sinking = false;
  // Drop the last-road snapshot too — it belongs to the OLD map after a
  // switch (switchMap calls this), and a stale cross-map teleport would
  // be far worse than the home fallback.
  lastRoadX = null;
}

/** Caller records the player's pose every frame they're ON a road —
 *  the "fished out" recovery teleports back to the most recent one. */
export function noteOnRoadPose(x: number, y: number, a: number): void {
  lastRoadX = x;
  lastRoadY = y;
  lastRoadA = a;
}

export function lastRoadPose(): { x: number; y: number; a: number } | null {
  return lastRoadX === null ? null : { x: lastRoadX, y: lastRoadY, a: lastRoadA };
}

/** Per-frame submerge update. `inWater` MUST be evaluated against the
 *  player's FINAL post-physics position (water tile, not on a road /
 *  bridge deck). Calls `onSink` once on the frame the sink begins
 *  (splash/rumble) and `onSunk` once when the animation bottoms out
 *  (recovery — teleport + fee). Returns true while sinking/sunk. */
export function tickWaterSubmerge(
  player: PlayerState,
  inWater: boolean,
  dt: number,
  onSink: () => void,
  onSunk: () => void,
): boolean {
  if (sinking) {
    if (player.fallTimer > SINK_HELD) {
      player.fallTimer = Math.max(SINK_HELD, player.fallTimer - dt);
      if (player.fallTimer <= SINK_HELD) {
        // Bottomed out this frame — recover exactly once. The recovery
        // resets fallTimer via resetPlayerMotion.
        sinking = false;
        wetAccum = 0;
        onSunk();
      }
    } else if (player.fallTimer <= 0) {
      // Something external (map switch / tow) cleared the fall — drop
      // the phase without firing recovery twice.
      sinking = false;
      wetAccum = 0;
    }
    return sinking;
  }
  if (inWater) {
    wetAccum += dt;
    if (wetAccum >= SINK_DEBOUNCE) {
      wetAccum = 0;
      sinking = true;
      player.fallTimer = SINK_DURATION;
      player.fallKind = 'water';
      onSink();
      return true;
    }
  } else {
    wetAccum = 0;
  }
  return false;
}
