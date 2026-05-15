/**
 * Shared types for the world/traffic subsystem (C25).
 *
 * Traffic cars are spawned on roads at fixed densities, follow lanes via
 * GTA-style AI (lane-keep + T-junction yield + cop pursuit), and despawn
 * when far off-camera. A single global `traffic[]` array is the canonical
 * source.
 */

export interface TrafficCar {
  /** World position. */
  x: number;
  y: number;
  /** Heading angle (radians). */
  angle: number;
  /** Forward speed (game units / sec). */
  speed: number;
  /** Speed cap based on road class + traffic flow. */
  maxSpeed: number;
  /** Per-frame steering angle (used by V2 wheel renderer). */
  steerAngle: number;
  /** Body class — 'sedan' / 'civic99' / 'accord99' / 'semi' / etc. */
  bodyType: string;
  /** Hex paint color. */
  color: string;
  /** True for parked/stopped cars (no per-frame movement integration). */
  stopped: boolean;
  /** True after a despawn — kept in array briefly for animation lifetime. */
  _despawned?: boolean;
  /** Bike sprite key (kawasaki_ninja / honda_cb500 / suzuki_bandit /
   *  suzuki_katana) when bodyType === 'bike'. */
  bikeSpriteKey?: string;
  /** True when this car is a traffic cop. */
  isCop?: boolean;
  /** 'highway' or 'city'. */
  copType?: 'highway' | 'city' | string;
  /** Articulated trailer payload (semis only). */
  tTrailer?: TrafficTrailerState | null;
  /** The road this car is currently on (cached for per-frame lane lookup). */
  roadRef?: { z?: number };
}

export interface TrafficTrailerState {
  /** Articulated trailer heading. Null = follow tractor's angle. */
  angle: number | null;
  /** Trailer length / width in game units. */
  length: number;
  width: number;
  /** Trailer body kind. */
  type: 'tanker' | 'box' | string;
  /** Tractor color (for the leading frame rail). */
  color: string;
}
