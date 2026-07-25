/**
 * H1010: active-map runtime state.
 *
 * Holds which map (mapRegistry id) is currently loaded so the world-gen
 * entry points (buildBaselineMap, rebuildRenderEntries) can default to the
 * ACTIVE map's source without threading it through every call site (the
 * editor Ctrl+S rebuild and the worldMap module-init rebuild both call them
 * with no map context). Defaults to 'city', so nothing changes until
 * switchMap (H1011) sets a different id.
 */
import { getMapDef, type MapSource } from './mapRegistry';

let activeMapId = 'city';
/** H1032: the ACTIVE non-city map's parking lots, cached at switch time so the
 *  in-game lot renderer can paint them. The city keeps painting from the LIVE
 *  editor state (worldEditor.parkingLots), which stays editable, so we leave
 *  this empty there and skip the extra source()/localStorage read. */
let activeMapLots: readonly unknown[] = [];
/** H1239: the ACTIVE non-city map's building + surface rows, cached the same
 *  way and for the same reason as activeMapLots.
 *
 *  The TILE side of buildings was always map-aware — buildBaselineMap stamps
 *  `src.overlay.buildings` (solid tile 17 + the tile-19 garage notch) and hands
 *  them to rebuildPlacedBuildings on whatever map is loading. Only the RENDER
 *  side was not: drawDriveways/drawPlacedBuildings were fed
 *  worldEditor.buildings/.surfaces unconditionally, i.e. the CITY editor state,
 *  on every map. So a track map painted city roofs that had no collision under
 *  them (visible as floating structures near tile 1250,1250 on the test tracks)
 *  and could never show structures of its own. These two caches close that gap
 *  so a MapDef can ship buildings — which is what the track pit garages need. */
let activeMapBuildings: readonly unknown[] = [];
let activeMapSurfaces: readonly unknown[] = [];

export function getActiveMapId(): string {
  return activeMapId;
}
export function setActiveMapId(id: string): void {
  activeMapId = id;
  const overlay = id === 'city' ? null : getMapDef(id).source().overlay;
  activeMapLots = overlay?.parkingLots ?? [];
  activeMapBuildings = overlay?.buildings ?? [];
  activeMapSurfaces = overlay?.surfaces ?? [];
}
/** H1032: parking lots to render for the active non-city map (empty on city). */
export function getActiveMapLots(): readonly unknown[] {
  return activeMapLots;
}
/** H1239: building rows to render for the active non-city map (empty on city,
 *  which paints from the live editor state). */
export function getActiveMapBuildings(): readonly unknown[] {
  return activeMapBuildings;
}
/** H1239: surface rows (driveways) for the active non-city map. */
export function getActiveMapSurfaces(): readonly unknown[] {
  return activeMapSurfaces;
}
/** H1031: true when the active map is a permanent-night venue (drag strip /
 *  oval). gameLoop reads this once per frame to derive an effective
 *  time-of-day for the light + tint passes without touching the real clock. */
export function getActiveMapForceNight(): boolean {
  return getMapDef(activeMapId).forceNight === true;
}
/** H1088: true when the active map's edges are FATAL — driving off the road
 *  drops the car off a canyon (the touge passes). gameLoop reads this once per
 *  frame (after physics) to gate the fall check. */
export function getActiveMapOffTrackFatal(): boolean {
  return getMapDef(activeMapId).offTrackFatal === true;
}
/** The source for the currently-active map. The city variant re-reads
 *  localStorage on each call, matching the pre-H1010 behavior exactly. */
export function getActiveMapSource(): MapSource {
  return getMapDef(activeMapId).source();
}
