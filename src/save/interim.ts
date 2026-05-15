/**
 * Interim H-era save format.
 *
 * The full SaveDataV1 schema in src/save/schema.ts assumes a LifeState
 * that we haven't built yet (40+ fields: housing, jobs, faults, cars,
 * etc.). Until LIFE init ports, we ship a smaller "H" save shape that
 * only persists what currently exists in GameContext.
 *
 * When LifeState ports, the H-shape import becomes a fallback in
 * loadGame (alongside SaveDataV1) so existing saves migrate forward.
 * That's why the version sentinel `'H'` is explicit — the future loader
 * branches on it.
 *
 * Saves go to localStorage.driverCitySave (same key the monolith uses
 * and the title screen's hasSave check looks for). The monolith and
 * the H-era src/ are intentionally not save-compatible during the
 * migration; either side overwrites the other on save.
 */

import type { GameContext } from '@/state/gameState';

export const SAVE_KEY = 'driverCitySave';

export interface InterimSaveH {
  /** Sentinel — the future LifeState loader uses this to branch
   *  between H-shape and full-SaveDataV1. */
  version: 'H';
  /** When the save was written (epoch ms). Informational. */
  savedAt: number;
  /** The gameState the player was in when saved. Almost always
   *  'playing'; carry it through so a reload lands them where they
   *  left off. Title / nameEntry / jobSelect / carSelect saves
   *  wouldn't normally happen (no real persistence intent there)
   *  but we don't forbid them. */
  gameState: GameContext['gameState'];
  character: GameContext['character'];
  startingConditions: GameContext['startingConditions'];
  playerJob: GameContext['playerJob'];
  /** Player pose. pSpeed deliberately NOT saved — load resumes
   *  parked so the player isn't hurtled into the nearest wall on
   *  reload. */
  player: { px: number; py: number; pAngle: number };
}

/** Write the current ctx to localStorage. Swallows quota / SecurityError
 *  the same way the monolith does so a full localStorage doesn't crash
 *  the game. */
export function saveGame(ctx: GameContext, key: string = SAVE_KEY): boolean {
  try {
    const payload: InterimSaveH = {
      version: 'H',
      savedAt: Date.now(),
      gameState: ctx.gameState,
      character: ctx.character,
      startingConditions: ctx.startingConditions,
      playerJob: ctx.playerJob,
      player: {
        px: ctx.player.px,
        py: ctx.player.py,
        pAngle: ctx.player.pAngle,
      },
    };
    localStorage.setItem(key, JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

/** Read localStorage and apply to ctx in place. Returns true on
 *  success. Tolerates missing keys (fields default to whatever's
 *  already on ctx); bails on parse error or non-H-shape payload. */
export function loadGame(ctx: GameContext, key: string = SAVE_KEY): boolean {
  const raw = localStorage.getItem(key);
  if (!raw) return false;
  try {
    const data = JSON.parse(raw) as Partial<InterimSaveH>;
    if (data.version !== 'H') return false;

    if (data.character !== undefined) ctx.character = data.character;
    if (data.startingConditions !== undefined) ctx.startingConditions = data.startingConditions;
    if (data.playerJob !== undefined) ctx.playerJob = data.playerJob;
    if (data.player) {
      if (typeof data.player.px === 'number') ctx.player.px = data.player.px;
      if (typeof data.player.py === 'number') ctx.player.py = data.player.py;
      if (typeof data.player.pAngle === 'number') ctx.player.pAngle = data.player.pAngle;
    }
    // Reset speed regardless of saved state — see InterimSaveH doc.
    ctx.player.pSpeed = 0;

    // Wipe transient screen state so the load doesn't land on a
    // stale carSelect or jobSelect view.
    ctx.title.confirmNewGame = false;
    ctx.jobSelect.scrollY = 0;
    ctx.carSelect.scrollY = 0;
    ctx.carSelect.payload = null;
    ctx.input.gas = false;
    ctx.input.brake = false;
    ctx.input.steerLeft = false;
    ctx.input.steerRight = false;
    ctx.input.ebrk = false;

    // Caller (title screen) decides the gameState transition.
    return true;
  } catch {
    return false;
  }
}

/** True when a save payload exists in localStorage. The title screen
 *  uses this to color the LOAD GAME button. */
export function hasSave(key: string = SAVE_KEY): boolean {
  return !!localStorage.getItem(key);
}

/** Removes the save key. Called when the user picks NEW GAME and
 *  confirms overwrite. */
export function clearSave(key: string = SAVE_KEY): void {
  localStorage.removeItem(key);
}
