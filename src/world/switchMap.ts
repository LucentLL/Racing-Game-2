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
import { setActiveMapId } from './mapRuntime';
import { rebuildBaselineMap } from './buildBaselineMap';
import { rebuildRoadCrossings } from './roadCrossings';
import { rebuildRenderEntries, RENDER_ENTRIES } from '@/render/worldMap';
import { rebuildMinimap } from '@/render/minimap';
import { createTraffic } from '@/state/traffic';
import { TILE } from '@/config/world/tiles';
import { resetTrackRace } from '@/sim/trackRace';
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
  // the car starts cleanly (no leftover velocity, drift, or integrator seed).
  const p = ctx.player;
  p.px = (def.spawnTile[0] + 0.5) * TILE;
  p.py = (def.spawnTile[1] + 0.5) * TILE;
  p.pAngle = def.spawnAngle;
  p.pCamAngle = def.spawnAngle;
  p.pSpeed = 0;
  p.layerZ = 0;
  p.collisionFlash = 0;
  p.drifting = false;
  p.slipAngle = 0;
  p.wheelspinRatio = 0;
  p.wheelGap = 0;
  p.pRevIntent = false;
  p.bikeVelAngle = def.spawnAngle;
  p.bikeVelAngleInit = false;
  p.bikeLeanPos = 0;
  p.bikeEbrakePrev = false;
  p.bikeEbrakeCooldown = 0;
  p.bikeEbrakeTimer = 0;
  // Force the Phase 0B bicycle integrator to re-seed from the fresh pose
  // (this is where the old world velocity pVx/pVy lives).
  p.phase0B = undefined;
  p.cruiseOn = false;
  // H1027: reset the transmission + engine revs so a fresh race starts in 1st
  // at idle — previously the gear (and RPM) carried over, so finishing in 6th
  // started the next race in 6th, and the engine note stayed pinned high.
  p.prevGear = 1;
  p.manualGear = null;
  p.manualGearTimer = 0;
  p.gearShiftTimer = 0;
  p.pRpm = 800;
  // H1028: snap the engine note to silence so the end-of-race sound doesn't
  // stay stuck/looping through the teleport (updateAudio re-settles from idle).
  resetEngineAudio();

  // H1014: a fresh track starts with no armed/leftover run.
  resetTrackRace();

  opts.resetInput?.();
}
