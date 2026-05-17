/**
 * Tactile feedback dispatcher. Routes a single playRumble call
 * to BOTH the web Gamepad rumble API (desktop / PC) and the
 * Capacitor Haptics plugin (mobile). Both fire simultaneously
 * when both are present — harmless, and a Steam Deck-style
 * touchscreen + gamepad combo gets feedback through whichever
 * the user actually feels.
 *
 * Web Gamepad path: `vibrationActuator.playEffect('dual-rumble',
 * ...)` — works in Chrome / Edge / modern Firefox + the Tauri
 * 2.x webview (Chromium-based).
 *
 * Capacitor path (H231): `Haptics.impact({style})` for one-shot
 * crashes, `Haptics.vibrate({duration})` for rumble-strip
 * pulses. Routed via src/platform/mobile.ts.
 *
 * Two consumers:
 *   - Crash impacts (one-shot strong rumble — `playRumble(0.6,
 *     0.4, 250)` scaled by impact). Mobile maps to heavy impact.
 *   - Rumble strips (short pulses fired at ~10 Hz while the
 *     player is on the edge-of-road buffer — `playRumble(0.25,
 *     0.18, 90)` per pulse). Mobile maps to light impact.
 *
 * The Web Gamepad API's `playEffect` doesn't stack — calling it
 * again before the previous effect ends restarts the actuator
 * with the new params. That's fine for our usage.
 */

import { playHapticImpact, playHapticVibrate } from '@/platform/mobile';

/** Optional shape of `GamepadHapticActuator.playEffect` —
 *  TypeScript's lib.dom doesn't always have it typed in older
 *  versions, so we declare what we use. */
interface VibrationActuator {
  playEffect(
    type: string,
    options: {
      duration: number;
      strongMagnitude: number;
      weakMagnitude: number;
      startDelay?: number;
    },
  ): Promise<string>;
  reset?: () => Promise<string>;
}

interface GamepadWithRumble {
  connected: boolean;
  vibrationActuator?: VibrationActuator | null;
}

/** Resolve the first connected gamepad's vibrationActuator, or
 *  null when nothing's available. Re-resolved every call because
 *  the gamepad list reference can change after disconnect /
 *  reconnect. */
function getActuator(): VibrationActuator | null {
  if (typeof navigator === 'undefined' || !navigator.getGamepads) return null;
  const pads = navigator.getGamepads();
  for (const p of pads) {
    if (!p) continue;
    const gp = p as unknown as GamepadWithRumble;
    if (gp.connected && gp.vibrationActuator) return gp.vibrationActuator;
  }
  return null;
}

/** Fire a tactile pulse. Multiplexes across the connected
 *  gamepad's vibrationActuator AND the Capacitor Haptics plugin
 *  when available — each is best-effort, both no-op cleanly when
 *  their backing platform isn't present.
 *
 *  Magnitudes clamped to [0, 1]; durationMs to [10, 5000]. Style
 *  mapping for the mobile path: strong > 0.7 → heavy impact;
 *  strong > 0.3 → medium; else → light. Short-duration calls
 *  (<= 120ms) route through Haptics.vibrate({duration}) instead
 *  so the strip-pulse cadence reads as a buzz rather than a
 *  series of distinct thumps. */
export function playRumble(strong: number, weak: number, durationMs: number): void {
  const s = Math.max(0, Math.min(1, strong));
  const w = Math.max(0, Math.min(1, weak));
  const d = Math.max(10, Math.min(5000, durationMs));

  // ---- Web Gamepad rumble ----
  const act = getActuator();
  if (act) {
    // Fire-and-forget. .catch silences "playEffect called too
    // fast" type errors some browsers throw when the actuator
    // is already running a previous effect — we don't care.
    void act.playEffect('dual-rumble', {
      duration: d,
      strongMagnitude: s,
      weakMagnitude: w,
    }).catch(() => {});
  }

  // ---- Capacitor Haptics (mobile) ----
  // Short pulses (rumble strips) → vibrate; longer impacts
  // (crashes) → impact() with a strength-derived style.
  if (d <= 120) {
    playHapticVibrate(d);
  } else {
    const style: 'light' | 'medium' | 'heavy' = s > 0.7 ? 'heavy' : s > 0.3 ? 'medium' : 'light';
    playHapticImpact(style);
  }
}

/** Stop any active rumble. Called when the player leaves the
 *  rumble-strip zone so the cadence ends cleanly instead of
 *  trailing off after the last pulse's full duration. */
export function stopRumble(): void {
  const act = getActuator();
  if (!act || !act.reset) return;
  void act.reset().catch(() => {});
}
