/**
 * Rumble-strip detection — fires a short rumble pulse when the
 * player drifts JUST outside the outside lane lines, like real
 * highway rumble strips.
 *
 * Detection model: the player is "on the strip" when:
 *   - isOnRoad(player.px, player.py) === false (off road)
 *   - BUT a probe ~7 px to either side is on road (the lane is
 *     right there — the player just crossed the line)
 *   - AND |pSpeed| > a low threshold (no rumble when parked
 *     half-off-road)
 *
 * Pulses fire every `STRIP_PULSE_MS` so the rumble reads as
 * discrete bumps (matching how real strips feel — short bursts,
 * not a continuous buzz). State is intentionally module-local
 * since the rumble is global to the device.
 */

import { isOnRoad, type TileMap } from '@/world/tileMap';
import { playRumble, stopRumble } from './rumble';

/** Probe distance from player center, in world-pixels. Roughly
 *  one-third of a tile (TILE = 18). */
const STRIP_PROBE_PX = 7;

/** Min speed (world-pixels/s) below which rumble strips don't
 *  fire. Avoids buzzing the controller while the player is parked
 *  half on the shoulder. */
const STRIP_MIN_SPEED = 8;

/** Time between strip-rumble pulses (ms). 100ms ≈ 10 Hz, the
 *  feel of real cattle-grate highway strips. */
const STRIP_PULSE_MS = 100;

/** Per-pulse rumble intensities. Light weak/strong values so the
 *  strip feels distinct from a crash impact (which uses 0.6/0.4
 *  at higher duration). */
const STRIP_STRONG = 0.25;
const STRIP_WEAK = 0.18;
const STRIP_DURATION_MS = 90;

let _lastPulseMs = 0;
let _wasOnStrip = false;

/** Per-frame check. Caller threads the tile map + player pose +
 *  current Date.now() (so tests can drive the timing). Fires up
 *  to one rumble pulse per call. */
export function tickRumbleStrip(
  tileMap: TileMap,
  px: number,
  py: number,
  pSpeed: number,
  nowMs: number,
): void {
  if (Math.abs(pSpeed) < STRIP_MIN_SPEED) {
    if (_wasOnStrip) {
      stopRumble();
      _wasOnStrip = false;
    }
    return;
  }
  const center = isOnRoad(tileMap, px, py);
  if (center) {
    if (_wasOnStrip) {
      stopRumble();
      _wasOnStrip = false;
    }
    return;
  }
  // Probe 4 cardinal neighbors. If any is on road, the player is
  // sitting on the edge band where the rumble strip would be.
  // Cardinal probes (rather than heading-perp) catch sideways
  // drift on both straight and curved roads without per-frame
  // angle math.
  const near =
    isOnRoad(tileMap, px + STRIP_PROBE_PX, py)
    || isOnRoad(tileMap, px - STRIP_PROBE_PX, py)
    || isOnRoad(tileMap, px, py + STRIP_PROBE_PX)
    || isOnRoad(tileMap, px, py - STRIP_PROBE_PX);
  if (!near) {
    if (_wasOnStrip) {
      stopRumble();
      _wasOnStrip = false;
    }
    return;
  }
  // In the strip zone. Pulse on the cadence.
  _wasOnStrip = true;
  if (nowMs - _lastPulseMs < STRIP_PULSE_MS) return;
  _lastPulseMs = nowMs;
  playRumble(STRIP_STRONG, STRIP_WEAK, STRIP_DURATION_MS);
}
