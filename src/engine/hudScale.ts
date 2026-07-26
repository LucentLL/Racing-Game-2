/**
 * H1253: default HUD size, by device.
 *
 * `--wheel-dia` is `min(400px, 50vw-24px, 42vh)` (H1048). That was tuned for
 * LANDSCAPE PHONES: they are height-bound and the wheel has to sit under a
 * thumb, so 42vh is right there. On a desktop window the same formula makes
 * the wheel nearly half the screen height, and the wheel / gauges / pedal
 * cluster dominates the game — the user's "FAR TOO BIG and unplayable".
 *
 * Rather than change the shipped mobile layout, the DEFAULT multiplier now
 * depends on the pointer: a coarse pointer (phone, tablet, touchscreen) keeps
 * 1.0; a fine pointer (mouse) gets 0.6, which brings the desktop cluster back
 * to roughly its pre-H1048 size. An explicit HUD Size choice in OPT always
 * wins over this.
 *
 * Lives in its own module (like engine/renderScale) so the pause menu can read
 * it without importing gameLoop, which would be a circular import.
 */

/** Multiplier applied to --wheel-dia when the player hasn't chosen one. */
export function getDefaultHudScale(): number {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 1;
  try {
    return window.matchMedia('(pointer: coarse)').matches ? 1 : 0.6;
  } catch {
    return 1;
  }
}

/** The size steps the OPT row cycles through, descending from full. */
export const HUD_SCALE_STEPS: readonly number[] = [1, 0.85, 0.7, 0.6, 0.5, 0.4];
