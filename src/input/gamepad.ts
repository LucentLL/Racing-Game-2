/**
 * Gamepad polling. Returns a structured GamepadFrame each tick so callers
 * can map raw button/axis state to game actions (steer/gas/brake/menu nav).
 *
 * Higher-level mutation of menu state, tilt mode, etc. lives in the UI
 * router — this module is intentionally narrow.
 */

export interface GamepadFrame {
  connected: boolean;
  name: string;
  steer: number;
  gas: number;
  brake: number;
  a: boolean;
  b: boolean;
  x: boolean;
  y: boolean;
  start: boolean;
  back: boolean;
  dpadUp: boolean;
  dpadDown: boolean;
  dpadLeft: boolean;
  dpadRight: boolean;
  lb: boolean;
  rb: boolean;
  rightStickY: number;
}

export const STEER_DEADZONE = 0.12;

const gamepadState = {
  connected: false,
  name: '',
};

const buttonPrev: Record<number, boolean> = {};

/**
 * Edge-detect a button — returns true only on the press transition, not
 * while held. Pass a unique numeric id per logical button.
 */
export function gpPressed(idx: number, val: boolean): boolean {
  const was = buttonPrev[idx] || false;
  buttonPrev[idx] = val;
  return val && !was;
}

interface GamepadDetectListeners {
  onConnect?: (name: string) => void;
  onDisconnect?: () => void;
}

export function installGamepadDetectListeners(listeners: GamepadDetectListeners = {}): () => void {
  const onConnected = (e: GamepadEvent): void => {
    listeners.onConnect?.(e.gamepad.id);
  };
  const onDisconnected = (): void => {
    gamepadState.connected = false;
    listeners.onDisconnect?.();
  };
  window.addEventListener('gamepadconnected', onConnected);
  window.addEventListener('gamepaddisconnected', onDisconnected);
  return () => {
    window.removeEventListener('gamepadconnected', onConnected);
    window.removeEventListener('gamepaddisconnected', onDisconnected);
  };
}

function selectGamepad(): Gamepad | null {
  let gamepads: ReadonlyArray<Gamepad | null>;
  try {
    gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
  } catch {
    return null;
  }
  let standardMapped: Gamepad | null = null;
  let fallback: Gamepad | null = null;
  for (const g of gamepads) {
    if (!g || !g.connected) continue;
    const id = g.id.toLowerCase();
    if (id.includes('handbrake') || id.includes('shifter') || id.includes('hbp')) continue;
    if (g.mapping === 'standard') {
      standardMapped = g;
      break;
    }
    if (g.buttons.length >= 10 && g.axes.length >= 4) {
      standardMapped = g;
      break;
    }
    if (!fallback) fallback = g;
  }
  return standardMapped ?? fallback;
}

const EMPTY_FRAME: GamepadFrame = {
  connected: false,
  name: '',
  steer: 0,
  gas: 0,
  brake: 0,
  a: false, b: false, x: false, y: false,
  start: false, back: false,
  dpadUp: false, dpadDown: false, dpadLeft: false, dpadRight: false,
  lb: false, rb: false,
  rightStickY: 0,
};

/** Fresh disconnected-state frame for ctx init. The poll loop overwrites
 *  this every RAF tick; consumers read the latest snapshot from ctx. */
export function createEmptyGamepadFrame(): GamepadFrame {
  return { ...EMPTY_FRAME };
}

export function pollGamepad(): GamepadFrame {
  const gp = selectGamepad();
  if (!gp) {
    if (gamepadState.connected) gamepadState.connected = false;
    return { ...EMPTY_FRAME };
  }
  if (!gamepadState.connected) {
    gamepadState.connected = true;
    gamepadState.name = gp.id;
  }

  const rawSteer = gp.axes[0] ?? 0;
  const steer = Math.abs(rawSteer) < STEER_DEADZONE ? 0 : rawSteer;
  const gas = gp.buttons[7]?.value ?? 0;
  const brake = gp.buttons[6]?.value ?? 0;

  return {
    connected: true,
    name: gamepadState.name,
    steer,
    gas,
    brake,
    a: gp.buttons[0]?.pressed ?? false,
    b: gp.buttons[1]?.pressed ?? false,
    x: gp.buttons[2]?.pressed ?? false,
    y: gp.buttons[3]?.pressed ?? false,
    start: gp.buttons[9]?.pressed ?? false,
    back: gp.buttons[8]?.pressed ?? false,
    dpadUp: gp.buttons[12]?.pressed ?? false,
    dpadDown: gp.buttons[13]?.pressed ?? false,
    dpadLeft: gp.buttons[14]?.pressed ?? false,
    dpadRight: gp.buttons[15]?.pressed ?? false,
    lb: gp.buttons[4]?.pressed ?? false,
    rb: gp.buttons[5]?.pressed ?? false,
    rightStickY: gp.axes[3] ?? 0,
  };
}

export function gpRumble(weakMag: number, strongMag: number, duration: number): void {
  if (!gamepadState.connected) return;
  let gamepads: ReadonlyArray<Gamepad | null>;
  try {
    gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
  } catch {
    return;
  }
  for (const gp of gamepads) {
    if (!gp || !gp.connected) continue;
    const va = (gp as Gamepad & { vibrationActuator?: { playEffect: (type: string, opts: object) => Promise<void> } })
      .vibrationActuator;
    if (va) {
      void va.playEffect('dual-rumble', {
        startDelay: 0,
        duration: duration || 100,
        weakMagnitude: Math.min(1, weakMag || 0),
        strongMagnitude: Math.min(1, strongMag || 0),
      }).catch(() => undefined);
    }
    break;
  }
}

export function isGamepadConnected(): boolean {
  return gamepadState.connected;
}

export function getGamepadName(): string {
  return gamepadState.name;
}
