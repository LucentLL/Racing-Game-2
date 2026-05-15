/**
 * SVG minimap widget — top-left mobile dial.
 *
 * Renders a player-centered minimap inside #mobileMinimapGroup (the
 * top-left container that took over from the wheel-interior site in
 * v8.99.124.13). Three layers, each updated on a different cadence to
 * cap per-frame SVG parse cost:
 *
 *   - heading line (player facing) — every frame, cheap (two attrs).
 *   - roads polylines — throttled to ~10 Hz via _MINIMAP_REBUILD_INTERVAL_MS.
 *   - markers (gas G, home H, job A/B, race F) — same throttle as roads.
 *
 * Mobile-only on the per-frame update path: v8.99.123.74 reverted PC to
 * the canvas minimap (the SVG version cost ~12.65 ms/frame at 1080p).
 *
 * Ported from monolith L22791-22895.
 *
 * SCAFFOLD status: type contract + public entry point. Layer assembly +
 * coordinate transforms + throttle bookkeeping stubbed with TODO line refs.
 */

/** Static map data the minimap needs to project. */
export interface MinimapWorld {
  /** Major roads (filtered/styled by name in the body — interstates, ramps). */
  majorRoads: Array<{ pts: number[][]; name?: string; maj?: boolean }>;
  /** Gas-station markers. */
  gasStations: Array<{ cx: number; cy: number }> | null;
  /** TILE size in world units (one tile = TILE px). */
  TILE: number;
}

/** Per-frame state — player position + heading + active markers. */
export interface MinimapOpts {
  /** Player world position (px / py). */
  playerX: number;
  playerY: number;
  /** Player facing in radians (drives the heading line). */
  playerAngle: number;
  /** Home tile, if known (drives the H marker). */
  homeTileX: number | null;
  homeTileY: number | null;
  /** Active job pickup (A) + dropoff (B) tiles, if any. */
  jobPickupTileX: number | null;
  jobPickupTileY: number | null;
  jobDropoffTileX: number | null;
  jobDropoffTileY: number | null;
  /** True after the player has picked up the job parcel — A marker greys out. */
  jobPickedUp: boolean;
  /** Active race destination world coords, if RACE.phase==='active'. */
  raceFx: number | null;
  raceFy: number | null;
}

/** Per-frame entry point. Mobile-only — bails on body.pc. Updates the
 *  heading line every call, throttles roads + markers to ~10 Hz.
 *  TODO(D27-followup): port from L22791-22895. */
export function updateMobileMinimapSvg(
  _world: MinimapWorld,
  _opts: MinimapOpts,
): void {
  // TODO: L22791-22895. Constants: mScale=0.116, viewR=78. Road colors:
  // I-485=#0af/1.5, I-77/I-85/US-74/Brookshire=#f80/1.5, I-277=#fa0/1.5,
  // major=#888/1.5, ramps=#0f0/1.2, default=#444/0.6.
}
