import { input, clearAllInputs } from './state';

/**
 * Wire raw keydown/keyup handlers that maintain `input.keys`. Higher-level
 * UI mutation (menu navigation, tilt toggle, perf overlay) is handled by
 * the UI router — this module is intentionally narrow.
 *
 * Special-cases:
 *   - Bails when focus is on an INPUT/TEXTAREA/contentEditable so the World
 *     Editor's property fields can receive typed digits/letters.
 *   - Lets browser shortcuts (F1-F12, Ctrl+R, DevTools combos) pass through
 *     untouched.
 *   - Clears all input state on tab visibility change or window blur to
 *     prevent stuck keys after app-switch/screenshot.
 */

export interface KeyboardOptions {
  /** Optional gate — when false, keydown writes are skipped (e.g., during text-entry game states). */
  isActive?: () => boolean;
}

export function installKeyboardHandlers(options: KeyboardOptions = {}): () => void {
  const isActive = options.isActive ?? (() => true);

  const onKeyDown = (e: KeyboardEvent): void => {
    const ae = document.activeElement as HTMLElement | null;
    if (
      ae &&
      (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)
    ) {
      return;
    }
    if (!isActive()) return;
    if (/^F\d{1,2}$/.test(e.key)) return;
    if (
      (e.ctrlKey || e.metaKey) &&
      ['r', 'R', 'I', 'i', 'J', 'j', 'u', 'U'].includes(e.key)
    ) {
      return;
    }
    input.keys[e.key] = true;
  };

  const onKeyUp = (e: KeyboardEvent): void => {
    input.keys[e.key] = false;
  };

  const onVisibilityChange = (): void => {
    if (document.hidden) clearAllInputs();
  };

  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('keyup', onKeyUp);
  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('blur', clearAllInputs);

  return () => {
    document.removeEventListener('keydown', onKeyDown);
    document.removeEventListener('keyup', onKeyUp);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    window.removeEventListener('blur', clearAllInputs);
  };
}
