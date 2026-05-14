/**
 * Shared physics types across vehicle / tire / steering / movement /
 * gear+RPM / trailer / collision / fuel.
 *
 * The runtime physics layer mutates module-level state (player px, py,
 * pAngle, pSpeed, pAngVel, pRPM, pGear, gearShiftTimer, etc.) on every
 * tick. The extracted modules thread this state through typed interfaces
 * so the cutover can choose to keep globals or move to a state object
 * without rewriting callers.
 */

/** Live player physics state — what update(dt) reads + mutates. */
export interface PlayerPhysicsState {
  /** World position (game units). */
  px: number;
  py: number;
  /** Heading angle (radians). */
  pAngle: number;
  /** Camera angle — decoupled from pAngle so the camera can lag during
   *  jackknife / reverse. */
  pCamAngle: number;
  /** Forward speed (game units / sec). Positive = forward, negative = reverse. */
  pSpeed: number;
  /** Angular velocity (rad / sec). */
  pAngVel: number;
  /** Velocity vector (separate from pAngle during drift). */
  vx: number;
  vy: number;
  /** Engine RPM. */
  pRPM: number;
  /** Selected gear (1..max). 0 = neutral. */
  pGear: number;
  /** Cooldown after a shift before next gas response fires. */
  gearShiftTimer: number;
  /** Driver-intent reverse flag (set when driver picks reverse gear,
   *  cleared otherwise — NOT velocity sign). */
  pRevIntent: boolean;
  /** Turbo spool 0..1. */
  turboBoost: number;
}

/** Combined fault effect multipliers (computeFaultEffects output). */
export interface FaultEffects {
  accelMult: number;
  fuelMult: number;
  gripMult: number;
  brakeMult: number;
  steerPull: number;
  shiftMult: number;
  engineWearMult: number;
  nightVisMult: number;
  rpmFlutter: boolean;
  steerSlow: boolean;
  hideGauges: boolean;
}

/** Per-frame input state (gas/brake/ebrk pedals + steering input + cruise). */
export interface FrameInputs {
  gas: boolean;
  brake: boolean;
  ebrk: boolean;
  /** Steering input -1..+1. */
  steerInput: number;
  /** Brake pedal position 0..1 (for trail-brake rotation). */
  brakePedal: number;
  /** Cruise control engaged + target speed. */
  cruiseOn: boolean;
  cruiseTarget: number;
}

/** Car spec snapshot (CAR() result). */
export interface CarSpec {
  /** Top speed in game units/sec. */
  topSpeed: number;
  /** RPM landmarks. */
  idleRPM: number;
  redline: number;
  maxRPM: number;
  /** Gear count. */
  gears: number;
  /** Per-gear top-speed fractions (gearSpeeds[1..gears]). */
  gearSpeeds: readonly number[];
  /** Torque-curve sample table (legacy). */
  torqueCurve: readonly number[];
  /** GT4 torque-curve mode flag. */
  useGT4TC: boolean;
  /** Turbo lag amount (0 = NA/SC, ~0.6 = laggy turbo). */
  turboLag: number;
  /** Drive-inertia multiplier. */
  inertiaMult: number;
  /** Traction (LSD) multiplier. */
  tractionMult: number;
  /** Downforce total. */
  dfTotal: number;
  /** Body type / class. */
  bodyType: string;
  isBike: boolean;
  /** Chassis-dim half-length, half-width. */
  size: readonly [number, number];
  /** Sprite color (for tint pickup in the renderers). */
  color: string;
  /** Display name. */
  name: string;
}
