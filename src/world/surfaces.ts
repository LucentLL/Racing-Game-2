/**
 * Surface registry — parking lots, plazas, and any non-road non-building
 * polygons drawn at the ground layer.
 *
 * Ported from monolith L17205+ (the `_surfaces` global array). Each
 * surface has a polygon outline + a paint color + an optional pattern.
 *
 * SCAFFOLD status: types + entry signatures; bodies stubbed.
 */

/** A single ground-painted surface — parking lot, plaza, etc. */
export interface Surface {
  /** Stable id. */
  id: string;
  /** Polygon outline in world pixels. */
  pts: ReadonlyArray<readonly [number, number]>;
  /** Fill color. */
  color: string;
  /** Optional named pattern (asphalt-new, asphalt-old, concrete-new, ...). */
  material?: string;
  /** Computed AABB for cull. */
  bbox: { minX: number; maxX: number; minY: number; maxY: number };
}

/** The global surface list. Populated at world preprocess time. */
export interface SurfaceRegistry {
  surfaces: ReadonlyArray<Surface>;
}

/** Renders all surfaces inside the camera frame. Called from the ground
 *  pass orchestrator before the road overlay.
 *  TODO(C24-followup): port from monolith L17205+. */
export function drawSurfaces(
  _ctx: CanvasRenderingContext2D,
  _registry: SurfaceRegistry,
  _camMinX: number,
  _camMinY: number,
  _camMaxX: number,
  _camMaxY: number,
): void {
  // TODO: L17205+.
}
