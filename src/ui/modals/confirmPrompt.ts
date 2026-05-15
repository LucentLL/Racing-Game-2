/**
 * Confirm prompt — v8.98.22 modal yes/no overlay.
 *
 * Sits ABOVE every other UI surface; the router's tap dispatcher checks
 * it before any menu or screen handler. Tap inside YES rect → execute
 * action then dismiss; tap inside NO rect → dismiss; tap outside →
 * SWALLOW the input but don't dismiss (modal lock — the player must
 * pick one).
 *
 * Drawing of the prompt itself happens inside the main menu draw at
 * L35820-35857 (the YES/NO buttons emit LIFE._confirmYesRect /
 * LIFE._confirmNoRect rects that this handler reads). The prompt is
 * painted as part of the menu so it can sit on top of the centered
 * menu panel.
 *
 * Two action keys today: 'restart' (location.reload — best-effort
 * since saves are autosaved) and 'quit' (window.close + about:blank
 * fallback for browsers that disallow programmatic close).
 *
 * Ported from monolith L42026-42057.
 *
 * SCAFFOLD status: type contract + entry points stubbed with TODO line
 * refs.
 */

/** Confirm prompt actions. Add new keys when new prompts appear. */
export type ConfirmAction = 'restart' | 'quit';

/** LIFE._confirmPrompt shape. */
export interface ConfirmPromptState {
  action: ConfirmAction;
  /** Optional title override for the prompt. */
  title?: string;
  /** Optional body text. */
  body?: string;
}

/** Side-effect callbacks the action keys delegate to. The screen stays
 *  presentation-only; the caller owns reload / window-close attempts. */
export interface ConfirmPromptDeps {
  reloadPage(): void;
  closeWindow(): void;
}

/** Routes a tap inside the YES / NO rects emitted by the menu draw
 *  pass. Returns true when the prompt is up — taps outside the buttons
 *  are SWALLOWED (modal lock), so the caller MUST treat true as
 *  "consumed" and skip downstream handlers. TODO(D31-followup): port
 *  from L42044-42057. */
export function handleConfirmPromptTap(
  _tx: number,
  _ty: number,
  _state: ConfirmPromptState | null,
  _yesRect: { x: number; y: number; w: number; h: number } | null,
  _noRect: { x: number; y: number; w: number; h: number } | null,
  _deps: ConfirmPromptDeps,
): boolean {
  // TODO: L42044-42057. Returns true while prompt is up (swallows taps
  // outside YES/NO too — modal lock).
  return false;
}

/** Executes the confirm-prompt action then clears LIFE._confirmPrompt.
 *  TODO(D31-followup): port from L42026-42040. */
export function executeConfirmAction(
  _state: ConfirmPromptState,
  _deps: ConfirmPromptDeps,
): void {
  // TODO: L42026-42040.
}
