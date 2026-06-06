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
  /** H140: signed steering value, -1..1. Set in mergeInputs each frame
   *  by smoothing the gamepad analog stick toward `sign(gp.steer) *
   *  pow(|gp.steer|, 1.3)` (monolith L23806-23809), or snapping to
   *  `(steerRight - steerLeft)` when no gamepad is connected (L23814).
   *  Read by arcadeUpdate as the final steering authority. The
   *  steerLeft/steerRight booleans remain populated for any legacy
   *  reader that hasn't migrated; physics-side now prefers steerAxis. */
  steerAxis: number;
  /** Analog gas pedal amount, 0..1. Mobile slider gives a real fraction
   *  of the bar; gamepad trigger gives 0..1 from its analog axis;
   *  keyboard W/Up snaps to 1.0 when held. Physics scales accel by
   *  this — without it, 25 % pedal pressure produced 100 % power and
   *  every car wide-open-throttle-burnouted from a tap. */
  gasAmount: number;
  /** Analog brake pedal amount, 0..1. Same shape as gasAmount —
   *  scales brake force in the brake branch of advancePSpeed so a
   *  feather-tap doesn't slam the rotors. */
  brakeAmount: number;
  /** Analog e-brake amount, 0..1. Mobile slider gives a real fraction
   *  of the handbrake throw; gamepad A/LB snaps to 1.0 when held. The
   *  skid-mark spawner gates on this so a barely-touched handbrake
   *  doesn't paint a full lockup trail. */
  ebrkAmount: number;
}

export function createInputState(): InputState {
  return {
    gas: false,
    brake: false,
    ebrk: false,
    steerLeft: false,
    steerRight: false,
    steerAxis: 0,
    gasAmount: 0,
    brakeAmount: 0,
    ebrkAmount: 0,
  };
}
