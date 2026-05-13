/**
 * Shared input state — populated by keyboard, gamepad, and touch handlers,
 * read by physics/update.
 */

export interface InputState {
  keys: Record<string, boolean>;
  steerInput: number;
  gasInput: number;
  brakeInput: number;
  ebrkInput: boolean;
  braking: boolean;
  gasAmount: number;
  brakeAmount: number;
  bikeLeanPos: number;
}

export const input: InputState = {
  keys: {},
  steerInput: 0,
  gasInput: 0,
  brakeInput: 0,
  ebrkInput: false,
  braking: false,
  gasAmount: 0,
  brakeAmount: 0,
  bikeLeanPos: 0,
};

export function clearAllInputs(): void {
  for (const k of Object.keys(input.keys)) input.keys[k] = false;
  input.gasInput = 0;
  input.brakeInput = 0;
  input.ebrkInput = false;
  input.steerInput = 0;
  input.gasAmount = 0;
  input.brakeAmount = 0;
}
