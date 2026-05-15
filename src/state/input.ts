/**
 * Per-frame input snapshot, populated by the keyboard listener and
 * read by physics.
 *
 * H6: keyboard only (arrow keys + WASD). Gamepad + touch / mobile
 * steering wheel SVG land in later H commits when the full input
 * pipeline ports (src/input/keyboard + gamepad + touch).
 *
 * Boolean held-state matches the monolith's `keys` set (L20103) for
 * gas/brake/ebrk/steer. The arcade physics in H6 only reads gas,
 * brake, steerLeft, steerRight; the others reserve slots for the
 * real physics body port.
 */

/** Held-state of relevant inputs. Updated by keydown/keyup listeners. */
export interface InputState {
  gas: boolean;
  brake: boolean;
  ebrk: boolean;
  steerLeft: boolean;
  steerRight: boolean;
}

export function createInputState(): InputState {
  return { gas: false, brake: false, ebrk: false, steerLeft: false, steerRight: false };
}
