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

export function getActiveMapId(): string {
  return activeMapId;
}
export function setActiveMapId(id: string): void {
  activeMapId = id;
  activeMapLots = id === 'city' ? [] : (getMapDef(id).source().overlay.parkingLots ?? []);
}
/** H1032: parking lots to render for the active non-city map (empty on city). */
export function getActiveMapLots(): readonly unknown[] {
  return activeMapLots;
}
/** H1031: true when the active map is a permanent-night venue (drag strip /
 *  oval). gameLoop reads this once per frame to derive an effective
 *  time-of-day for the light + tint passes without touching the real clock. */
export function getActiveMapForceNight(): boolean {
  return getMapDef(activeMapId).forceNight === true;
}
/** The source for the currently-active map. The city variant re-reads
 *  localStorage on each call, matching the pre-H1010 behavior exactly. */
export function getActiveMapSource(): MapSource {
  return getMapDef(activeMapId).source();
}
