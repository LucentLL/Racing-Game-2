/**
 * Mobile (Capacitor) runtime bridges.
 *
 * H231 — haptics via the Capacitor Haptics plugin. Mobile mirror
 * of the H229 web Gamepad rumble API; the same crash + rumble-
 * strip triggers fire phone vibrations on Android.
 *
 * Talks to Capacitor through `window.Capacitor.Plugins.Haptics`
 * — the global the @capacitor/haptics plugin registers when
 * Capacitor.registerPlugin runs in the native shell. No hard
 * import of @capacitor/haptics; the browser build doesn't need
 * the package installed.
 *
 * Every helper is fire-and-forget: returns void + promise
 * rejection is swallowed so haptic failures (permissions, no
 * vibrator hardware) can't crash the game loop.
 */

/** Capacitor Haptics plugin surface — we declare only what we
 *  use so the browser build doesn't need the @capacitor/haptics
 *  types. */
interface HapticsPlugin {
  impact: (options: { style: 'light' | 'medium' | 'heavy' }) => Promise<void>;
  vibrate: (options: { duration: number }) => Promise<void>;
}

interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  Plugins?: { Haptics?: HapticsPlugin };
}

interface CapacitorWindow {
  Capacitor?: CapacitorGlobal;
}

function getCapacitor(): CapacitorGlobal | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as CapacitorWindow;
  return w.Capacitor ?? null;
}

/** True when running inside a Capacitor-wrapped native app
 *  (Android / iOS). False on the web build + on the Tauri
 *  desktop build (Tauri exposes its own globals, not Capacitor's). */
export function isCapacitorRuntime(): boolean {
  const c = getCapacitor();
  return !!c && typeof c.isNativePlatform === 'function' && c.isNativePlatform();
}

function getHaptics(): HapticsPlugin | null {
  const c = getCapacitor();
  return c?.Plugins?.Haptics ?? null;
}

/** Fire a discrete haptic impact. Style maps from rumble
 *  magnitudes elsewhere — light/medium/heavy correspond roughly
 *  to the H229 Gamepad rumble strong levels (≤0.3 / ≤0.7 / >0.7).
 *
 *  Caller doesn't await — promise rejection silently no-ops so
 *  permission denial or missing vibrator hardware can't crash. */
export function playHapticImpact(style: 'light' | 'medium' | 'heavy'): void {
  const h = getHaptics();
  if (!h) return;
  void h.impact({ style }).catch(() => {});
}

/** Fire a generic vibration of the given duration in ms.
 *  Distinct from impact() — vibrate runs the motor for a
 *  duration, impact is a one-shot pattern. Used for short
 *  rumble-strip-style pulses where impact's preset 'feels' too
 *  punchy.
 *
 *  Android Vibrator clamps the duration; iOS routes this to a
 *  short impact. Same fire-and-forget pattern as impact(). */
export function playHapticVibrate(durationMs: number): void {
  const h = getHaptics();
  if (!h) return;
  const d = Math.max(10, Math.min(5000, durationMs));
  void h.vibrate({ duration: d }).catch(() => {});
}
