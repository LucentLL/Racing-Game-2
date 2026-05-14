/**
 * Shared types for the carBody render subsystem (C19).
 *
 * The V2 system has two distinct render paths:
 *   - Legacy bodyType-keyed silhouettes (silhouette.ts) — generic shapes
 *     keyed on a small enum of body styles ('sedan' | 'rx7' | 'gtr' ...).
 *     Drawn with a tracePath callback that the caller passes to fill +
 *     stroke + ground-shadow helpers.
 *   - Per-car V2 generation renderers (generation.ts + GEN_DATA registry,
 *     populated in C19b) — full sprite-style render per chassis generation
 *     (e.g. 'rx7_fd', 'gtr_r34', 'nsx_na'). Selected via getCarGeneration()
 *     from the car's display name.
 *
 * X-ray geometry (xrayGeom.ts) reads GT4_SPECS to produce real-world tire
 * sizes / axle positions in game units, replacing the bodyType-uniform
 * placeholder rectangles when LIFE.gameplaySettings.xrayBody is on.
 */

/** Tracer callback — fills a closed path on `ctx` for a given body. The
 *  caller wraps this in ctx.fill() / ctx.stroke() / shadow passes. */
export type TraceCarBodyPath = (
  ctx: CanvasRenderingContext2D,
  bodyType: string,
  hl: number,
  hw: number,
  L: number,
  W: number,
) => void;

/** GT4 spec subset the X-ray geom path consumes. Lives in cfg/cars/gt4Database
 *  (Phase A). Trimmed here to the fields used. */
export interface GT4SpecLike {
  /** Wheelbase in mm. */
  wb: number;
  /** Overall length in mm. */
  lng: number;
  /** Overall width in mm. */
  wid: number;
  /** Front / rear track in mm. */
  trF: number;
  trR: number;
  /** Front / rear tire spec strings ('245/60 R15', '120/60 ZR17', etc.). */
  tsF: string;
  tsR: string;
}

/** Output of _parseTireSpec — tire diameter and section width in mm. */
export interface TireSpec {
  /** Tread width in mm (the first number in '245/60 R15'). */
  width: number;
  /** Overall tire diameter in mm — rim + 2 × sidewall. */
  diameter: number;
}

/** 4-wheel X-ray geometry derived from a GT4-style spec, in game units. */
export interface CarWheelGeom {
  /** Front tire length / width (game units). */
  fL: number;
  fW: number;
  /** Rear tire length / width. */
  rL: number;
  rW: number;
  /** Axle X positions in car-local coords (centered on origin). */
  fAxleX: number;
  rAxleX: number;
  /** Half-track (lateral half-distance between left/right tires). */
  fHalfTrack: number;
  rHalfTrack: number;
}

/** Single-track (bike) geometry — no lateral track since both wheels are
 *  on the centerline. */
export interface BikeWheelGeom {
  fL: number;
  fW: number;
  rL: number;
  rW: number;
  fAxleX: number;
  rAxleX: number;
}

/** GEN_DATA registry value. C19b will populate with per-chassis render fns;
 *  shape is established here so consumers can type the registry early. */
export interface GenerationRenderer {
  /** Per-generation key (e.g. 'rx7_fd'). Same as the registry index. */
  id: string;
  /** Renders the full car body (under-tint + paint + windows + mirrors +
   *  headlights + taillights + outline) at the given dimensions and color.
   *  The caller has already applied the camera + rotated to car-local. */
  render(
    ctx: CanvasRenderingContext2D,
    L: number,
    W: number,
    color: string,
    opts: GenerationRenderOpts,
  ): void;
}

/** Render options threaded to every per-gen renderer. */
export interface GenerationRenderOpts {
  /** Steering angle in radians (front wheels only). */
  steerAngle: number;
  /** True when LIFE.gameplaySettings.xrayBody is enabled. */
  xray: boolean;
  /** True when the brake pedal is held OR the e-brake is engaged — flips
   *  taillights to brighter red. */
  isBraking: boolean;
  /** True for the player's own car (gates per-side fault suppression). */
  isPlayer: boolean;
  /** Player car name — needed for X-ray GT4 spec lookup. */
  carName?: string;
}
