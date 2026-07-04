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

export function getActiveMapId(): string {
  return activeMapId;
}
export function setActiveMapId(id: string): void {
  activeMapId = id;
}
/** The source for the currently-active map. The city variant re-reads
 *  localStorage on each call, matching the pre-H1010 behavior exactly. */
export function getActiveMapSource(): MapSource {
  return getMapDef(activeMapId).source();
}
