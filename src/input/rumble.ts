/**
 * Gamepad rumble. Uses the standard Gamepad API
 * `vibrationActuator.playEffect('dual-rumble', ...)` — works in
 * Chrome / Edge / modern Firefox + the Tauri 2.x webview (which
 * is Chromium-based). Falls through silently when no gamepad is
 * connected or the browser lacks the actuator API.
 *
 * Two consumers:
 *   - Crash impacts (one-shot strong rumble — `playRumble(0.6,
 *     0.4, 250)` scaled by impact).
 *   - Rumble strips (short pulses fired at ~10 Hz while the
 *     player is on the edge-of-road buffer — `playRumble(0.25,
 *     0.18, 90)` per pulse, retriggered each pulse window).
 *
 * The Web Gamepad API's `playEffect` doesn't stack — calling it
 * again before the previous effect ends restarts the actuator
 * with the new params. That's fine for our usage: rumble-strip
 * pulses overwrite each other (the cadence is the rumble), and
 * crash one-shots overwrite any background rumble cleanly.
 */

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

/** Fire a dual-rumble pulse. magnitudes clamped to [0, 1];
 *  durationMs to [10, 5000]. Promise rejection is swallowed —
 *  rumble is best-effort + we don't want it crashing the game
 *  loop on unsupported browsers. */
export function playRumble(strong: number, weak: number, durationMs: number): void {
  const act = getActuator();
  if (!act) return;
  const s = Math.max(0, Math.min(1, strong));
  const w = Math.max(0, Math.min(1, weak));
  const d = Math.max(10, Math.min(5000, durationMs));
  // Fire-and-forget. .catch silences "playEffect called too fast"
  // type errors some browsers throw when the actuator is already
  // running a previous effect — we don't care.
  void act.playEffect('dual-rumble', {
    duration: d,
    strongMagnitude: s,
    weakMagnitude: w,
  }).catch(() => {});
}

/** Stop any active rumble. Called when the player leaves the
 *  rumble-strip zone so the cadence ends cleanly instead of
 *  trailing off after the last pulse's full duration. */
export function stopRumble(): void {
  const act = getActuator();
  if (!act || !act.reset) return;
  void act.reset().catch(() => {});
}
