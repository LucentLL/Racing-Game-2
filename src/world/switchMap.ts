/**
 * H1011: runtime map switch (Phase 2 of the multi-map system).
 *
 * Swaps the live world to a different registry map, on the same fixed tile
 * grid: point the active-map source at the new map, rebuild the tile bitmap +
 * render entries + minimap + road-signal crossings from it, reseed traffic
 * (old cars hold stale road indices), and drop the player at the new map's
 * spawn with a full motion reset.
 *
 * Deliberately does NOT go through the editor's rebuildWorld() closure — that
 * one PERSISTS the editor overlay to localStorage before rebuilding, which is
 * correct for a city edit but wrong here (test maps are programmatic, not
 * editor-saved). This is the same rebuild sequence as the editor Ctrl+S
 * handler (gameLoop rebuildWorld: rebuildRenderEntries -> rebuildBaselineMap
 * -> rebuildMinimap -> rebuildRoadCrossings) minus the save.
 */
import { getMapDef } from './mapRegistry';
import { setActiveMapId, getActiveMapSource } from './mapRuntime';
import { rebuildBaselineMap } from './buildBaselineMap';
import { rebuildRoadCrossings, applyAuthoredIntersections } from './roadCrossings';
import { rebuildRenderEntries, RENDER_ENTRIES } from '@/render/worldMap';
import { rebuildMinimap } from '@/render/minimap';
import { createTraffic } from '@/state/traffic';
import { resetPlayerMotion } from '@/state/player';
import { TILE } from '@/config/world/tiles';
import { resetTrackRace } from '@/sim/trackRace';
import { resetTougeFall } from '@/sim/tougeFall';
import { resetWaterSubmerge } from '@/sim/waterSubmerge';
import { seedRivalAtMeet } from '@/sim/blacklistProgress';
import { rebuildParkedCars } from './parkedCars';
import { resetEngineAudio } from '@/engine/audio/proceduralEngine';
import type { GameContext } from '@/state/gameState';

export interface SwitchMapOpts {
  /** Blank the input pass so a held key/button doesn't carry into the new
   *  map (gameLoop passes resetInputState). */
  resetInput?: () => void;
}

export function switchMap(ctx: GameContext, mapId: string, opts: SwitchMapOpts = {}): void {
  const def = getMapDef(mapId);
  setActiveMapId(def.id);

  // World data — order matters: render entries first (the crossings + minimap
  // read RENDER_ENTRIES), tile bitmap for collision/on-road, then the
  // dependent bakes.
  rebuildRenderEntries();
  rebuildBaselineMap(ctx.tileMap);
  rebuildMinimap(ctx.minimap);
  rebuildRoadCrossings(RENDER_ENTRIES.map((e) => e.row));
  // H1042: overlay the new map's authored intersections onto the fresh
  // crossings (test maps carry none — the array is empty there).
  applyAuthoredIntersections(getActiveMapSource().overlay.intersections ?? []);

  // Traffic — reseed IN PLACE (keep the array identity; old cars reference
  // stale road indices / smoothed polylines from the previous map). Test
  // tracks opt out (def.traffic === false) so racing lines stay clean.
  // Emptying is safe: tickTraffic only repositions existing cars, it never
  // refills to TRAFFIC_COUNT.
  ctx.traffic.length = 0;
  if (def.traffic !== false) {
    for (const c of createTraffic()) ctx.traffic.push(c);
  }

  // Player — teleport to spawn + clear all motion / physics-carry state so
  // the car starts cleanly (H1027/H1028 gear+audio reset folded into the
  // shared resetPlayerMotion helper, H1034).
  resetPlayerMotion(
    ctx.player,
    (def.spawnTile[0] + 0.5) * TILE,
    (def.spawnTile[1] + 0.5) * TILE,
    def.spawnAngle,
  );
  // H1028: snap the engine note to silence so the end-of-race sound doesn't
  // stay stuck/looping through the teleport (updateAudio re-settles from idle).
  resetEngineAudio();

  // H1014: a fresh track starts with no armed/leftover run.
  resetTrackRace();
  // H1088: clear the touge canyon-fall debounce (resetPlayerMotion already
  // zeroed player.fallTimer) so the fresh map starts clean.
  resetTougeFall();
  // H1164: same for the water-submerge debounce/phase.
  resetWaterSubmerge();

  // H1033: rebuild the CAR MEET's parked cars from the new map's lot (empty on
  // any map without a lot, so this self-clears when returning to the city).
  rebuildParkedCars();
  // H1079 (BL-3): if the next blacklist rival's gate is open, park their
  // flagged signature car in the fresh lot (no-op off the meet).
  if (ctx.life) seedRivalAtMeet(ctx.life);

  opts.resetInput?.();
}
