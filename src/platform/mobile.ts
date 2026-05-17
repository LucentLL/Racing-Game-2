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

/** Google Play Review API surface, registered by the community
 *  plugin @capacitor-community/in-app-review. The plugin's
 *  `requestReview()` triggers the OS-managed review dialog. Play
 *  Store decides whether to actually show it (throttled per user
 *  + over time); the JS Promise resolves either way. */
interface InAppReviewPlugin {
  requestReview: () => Promise<void>;
}

interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  Plugins?: {
    Haptics?: HapticsPlugin;
    InAppReview?: InAppReviewPlugin;
  };
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

/** H232: request the Google Play / Apple in-app review dialog.
 *  Fire-and-forget. The OS handles all the throttling — Google
 *  Play caps reviews per user per year, may show nothing at all,
 *  and never tells the JS side either way. Caller gates this
 *  with their own client-side latch (e.g. life._reviewAsked)
 *  to avoid spamming the API; the OS will do the same on its
 *  side but we want to keep the call sites tasteful.
 *
 *  No-ops on the web build, the Tauri desktop build, and any
 *  Capacitor build that hasn't installed the plugin. */
export function requestInAppReview(): void {
  const c = getCapacitor();
  const r = c?.Plugins?.InAppReview;
  if (!r) return;
  void r.requestReview().catch(() => {});
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
