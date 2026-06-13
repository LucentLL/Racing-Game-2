/**
 * H819: single source of truth for the steering-sensitivity slider.
 *
 * THE BUG THIS FIXES: the OPT slider wrote `touchSteerSens` or
 * `padSteerSens` keyed on `'ontouchstart' in window`, but the physics
 * (phase0BAdapter.resolveSensSlider + gameLoop `_sensSlider`) ALWAYS
 * read `padSteerSens`. On any device where `ontouchstart` is true —
 * which includes desktop Chrome/Edge and every touchscreen Windows
 * laptop by default — the slider wrote a key the physics never read,
 * so the steering-sensitivity slider had zero effect (user report:
 * "sensitivity slider doesn't change controller sensitivity").
 *
 * FIX: both the write side (slider) and the read side (physics)
 * resolve the key through `steerSensKey()` here, so they can't
 * diverge. Detection is `pointer: coarse` (the primary-input-is-touch
 * media query) instead of `ontouchstart` (mere touch *capability*),
 * so a touchscreen laptop driven by mouse/keyboard/gamepad correctly
 * uses the keyboard/pad sens, and a phone uses the touch sens.
 */

import type { LifeState } from '@/state/life';

/** Steering-sensitivity slider clamp range (shared with the OPT UI). */
export const STEER_SENS_MIN = 0.5;
export const STEER_SENS_MAX = 2.0;
export const STEER_SENS_DEFAULT = 1.0;

/** True when the device's PRIMARY pointer is touch (phones/tablets).
 *  `pointer: coarse` is false on a touchscreen laptop whose primary
 *  pointer is a mouse — unlike `'ontouchstart' in window`, which is
 *  true there and mis-routed the sens key. */
export function isTouchPrimary(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(pointer: coarse)').matches;
}

/** The gameplaySettings key the steering-sensitivity slider reads/
 *  writes for the current input modality. Touch devices get their own
 *  value; keyboard + gamepad share `padSteerSens`. */
export function steerSensKey(): 'touchSteerSens' | 'padSteerSens' {
  return isTouchPrimary() ? 'touchSteerSens' : 'padSteerSens';
}

/** Resolve the live steering-sensitivity multiplier for physics.
 *  Reads the SAME key the OPT slider writes, clamped to the slider's
 *  advertised range so a stale save can't trash steering. */
export function getSteerSens(life: LifeState | null | undefined): number {
  const raw = life?.gameplaySettings?.[steerSensKey()];
  if (typeof raw !== 'number' || raw <= 0) return STEER_SENS_DEFAULT;
  return Math.max(STEER_SENS_MIN, Math.min(STEER_SENS_MAX, raw));
}
