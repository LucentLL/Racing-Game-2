/**
 * Name entry screen — DOM overlay (not canvas).
 *
 * The character creation surface: gender M/F selector, body-base preview
 * (Muscular / Lean / Overweight, switched at runtime by fitness band —
 * the picker is preview-only), name + racer-alias inputs (10 char max,
 * alphanumeric+space filter), age slider (21-60) with end-label
 * quick-jumps and ± step buttons, RANDOM CHARACTER button, NEXT.
 *
 * Why DOM: the picker has 5+ inputs that need IME / keyboard / mobile-
 * keyboard handling that canvas painting can't provide. canvas
 * draw/handle entry points are present but no-op (see drawNameEntry).
 *
 * Test-mode hatch: setting playerName='test' on commit unlocks all cars,
 * sets money to 999,999, maxes vehicle stats, enables FPS counter, and
 * sets LIFE._testMode=true. The age value is preserved (v8.99.38 fix —
 * earlier code rerolled age in test mode and silently discarded slider).
 *
 * Ported from monolith L44684-44930.
 *
 * SCAFFOLD status: type contract + entry points stubbed with TODO line
 * refs. The DOM string + listener wiring (~250 lines) is deferred.
 */

/** Caller-supplied callbacks the overlay invokes on commit / interaction.
 *  These bridge the DOM surface back to LIFE / gameState mutations that
 *  the screen module shouldn't know about directly. */
export interface NameEntryDeps {
  /** Called when NEXT is tapped with both fields valid. The overlay has
   *  already filtered + trimmed the strings and clamped the age. */
  onCommit(commit: NameEntryCommit): void;
  /** Notification toast for one-off messages (e.g., test-mode unlock). */
  showNotif(msg: string): void;
}

/** Final values committed when the player taps NEXT. */
export interface NameEntryCommit {
  /** Player real name (10 chars max, alphanumeric+space, trimmed). */
  playerName: string;
  /** Racer alias (10 chars max, alphanumeric+space, trimmed). */
  playerAlias: string;
  /** Selected age (21-60, clamped). */
  age: number;
  /** 'M' | 'F'. Skin tone is pinned to 1 (only tone shipped). */
  gender: 'M' | 'F';
  /** True when playerName.toLowerCase()==='test' — test-mode hatch. */
  testMode: boolean;
}

/** Builds the DOM overlay if it doesn't already exist, focuses the name
 *  input, and wires all listeners. Idempotent — repeat calls are no-ops.
 *  TODO(D28-followup): port from L44687-44919. */
export function ensureNameOverlay(_deps: NameEntryDeps): void {
  // TODO: L44687-44919. Builds gender picker + body-base preview canvas
  // + name/alias inputs + age slider + ± buttons + RANDOM + NEXT.
}

/** Removes the overlay from the DOM and clears cached input refs. Safe
 *  to call when the overlay is already absent. TODO(D28-followup): port
 *  from L44920-44922. */
export function hideNameOverlay(): void {
  // TODO: L44920-44922.
}

/** Focuses the name (idx=0) or alias (idx=1) input. Used by the keydown
 *  Tab handler to cycle. TODO(D28-followup): port from L44923-44927. */
export function focusNameField(_idx: 0 | 1): void {
  // TODO: L44923-44927.
}

/** Canvas no-op kept for the render() dispatcher symmetry — the DOM
 *  overlay covers the canvas while gameState==='nameEntry'. */
export function drawNameEntry(_ctx: CanvasRenderingContext2D): void {
  // Intentionally empty — DOM overlay handles the screen.
}

/** Canvas no-op kept for the tap dispatcher symmetry — the DOM overlay
 *  swallows all interaction while gameState==='nameEntry'. */
export function handleNameEntryClick(_tx: number, _ty: number): void {
  // Intentionally empty — DOM overlay handles all interaction.
}
