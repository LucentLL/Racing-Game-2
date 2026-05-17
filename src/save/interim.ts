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
import { isTauriRuntime, saveFileNative } from '@/platform/desktop';

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
   *  reload. fuel IS saved. */
  player: { px: number; py: number; pAngle: number; fuel?: number };
  /** H14: in-game clock state. Optional for back-compat with
   *  pre-H14 saves; loadGame defaults to a fresh morning if absent. */
  clock?: { timeOfDay: number; day: number };
  /** H21: full LIFE snapshot. Optional for back-compat with pre-H21
   *  saves (which had no LIFE — start-flow values rebuilt on reload).
   *  Captured via JSON.stringify so we don't have to enumerate every
   *  field; loadGame applies it back to ctx.life unconditionally.
   *
   *  Notable fields carried through this wholesale blob:
   *    - newspaper (H35) — classifieds array with per-listing isPinned
   *      flag (H36). Pinned listings round-trip across save/load.
   *    - newspaperSection (D29) — last-viewed 'cars' | 'homes' tab.
   *    - foodStock, ateToday, daysSinceEat (H34) — eat-loop state.
   *    - carLoans, bankLoans, mortgageBalance (H21-H22) — finance.
   *
   *  Pre-H35 saves are missing `newspaper` / `newspaperSection`;
   *  loadGame's normalizer fills them with defaults so reads in
   *  drawNewspaperTab + fillNewspaperListings stay safe. */
  life?: unknown;
}

/** H160: build the InterimSaveH payload from a context. Shared by
 *  saveGame (localStorage write) and exportSaveToFile (.json
 *  download). Centralizing the snapshot fields means a save-shape
 *  addition only edits one place and both paths pick it up. */
function buildSavePayload(ctx: GameContext): InterimSaveH {
  return {
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
      fuel: ctx.player.fuel,
    },
    clock: { timeOfDay: ctx.clock.timeOfDay, day: ctx.clock.day },
    life: ctx.life ?? undefined,
  };
}

/** Write the current ctx to localStorage. Swallows quota / SecurityError
 *  the same way the monolith does so a full localStorage doesn't crash
 *  the game. */
export function saveGame(ctx: GameContext, key: string = SAVE_KEY): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(buildSavePayload(ctx)));
    return true;
  } catch {
    return false;
  }
}

/** H160 / H228: export the current save as a .json file.
 *
 *  Browser path: blob URL + auto-download via a hidden anchor.
 *  Drops the file into the user's Downloads folder.
 *
 *  Tauri desktop path (H228): kicks off a native "save as" dialog
 *  asynchronously through src/platform/desktop.ts. The dialog UX
 *  reads more naturally than auto-downloads on Steam-distributed
 *  builds — players pick the folder themselves.
 *
 *  Filename defaults to driverCity_<alias>_d<day>.json so multiple
 *  exports for the same character don't auto-overwrite. Falls back
 *  to driverCity_save.json when alias is empty (pre-life flow).
 *
 *  Returns true when the export was initiated. The desktop path
 *  resolves asynchronously — the caller doesn't wait. */
export function exportSaveToFile(ctx: GameContext, filename?: string): boolean {
  try {
    const json = JSON.stringify(buildSavePayload(ctx), null, 2);
    const alias = ctx.life?.playerAlias ?? ctx.character?.playerAlias ?? '';
    const safeAlias = alias.replace(/[^A-Za-z0-9_-]+/g, '').slice(0, 24);
    const dayStr = `d${ctx.clock.day}`;
    const name = filename
      ?? (safeAlias ? `driverCity_${safeAlias}_${dayStr}.json` : 'driverCity_save.json');

    // H228: desktop bridge — async fire-and-forget. The browser
    // download path isn't even reached when running under Tauri,
    // so the player sees a single native picker (not double).
    if (isTauriRuntime()) {
      void saveFileNative(json, name);
      return true;
    }

    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoke on next tick — Chrome and Firefox both copy the URL into
    // the download stream synchronously, so the revoke is safe right
    // away, but the setTimeout keeps the URL alive a beat for any
    // older browser implementation we haven't tested.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  } catch {
    return false;
  }
}

/** Read localStorage and apply to ctx in place. Returns true on
 *  success. Tolerates missing keys (fields default to whatever's
 *  already on ctx); bails on parse error or non-H-shape payload.
 *  H159 split: shared parse + apply lives in loadGameFromText below. */
export function loadGame(ctx: GameContext, key: string = SAVE_KEY): boolean {
  const raw = localStorage.getItem(key);
  if (!raw) return false;
  return loadGameFromText(ctx, raw);
}

/** H159: parse a JSON save string + apply to ctx. Used by the title
 *  screen's file-import fallback (openFileLoadPicker) when no
 *  localStorage save exists. 1:1 port of monolith L44062-44083 — same
 *  permissive parser as loadGame, same field-by-field copy, same
 *  cleared transient state on success. Caller is responsible for the
 *  gameState transition (typically → 'playing' so the loaded save
 *  resumes where it left off). */
export function loadGameFromText(ctx: GameContext, raw: string): boolean {
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
      if (typeof data.player.fuel === 'number') {
        ctx.player.fuel = Math.max(0, Math.min(1, data.player.fuel));
      }
    }
    if (data.clock) {
      if (typeof data.clock.timeOfDay === 'number') {
        ctx.clock.timeOfDay = ((data.clock.timeOfDay % 1) + 1) % 1;
      }
      if (typeof data.clock.day === 'number' && data.clock.day >= 1) {
        ctx.clock.day = data.clock.day;
      }
    }
    if (data.life && typeof data.life === 'object') {
      ctx.life = data.life as GameContext['life'];
      // H37 back-compat: pre-H35 saves don't carry newspaper /
      // newspaperSection. Fill in safe defaults so reads in the
      // home overlay and the daily refresh tick don't crash.
      normalizeLoadedLife(ctx.life);
    }
    // Reset speed + collision flash regardless of saved state — see
    // InterimSaveH doc.
    ctx.player.pSpeed = 0;
    ctx.player.collisionFlash = 0;

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
    ctx.input.steerAxis = 0;
    // H139: also clear the held-state source so the per-frame merge
    // doesn't immediately reinstate a stale "keyboard down" from
    // before the load.
    ctx.inputHeld.gas = false;
    ctx.inputHeld.brake = false;
    ctx.inputHeld.steerLeft = false;
    ctx.inputHeld.steerRight = false;
    ctx.inputHeld.ebrk = false;
    ctx.inputHeld.steerAxis = 0;

    // Caller (title screen) decides the gameState transition.
    return true;
  } catch {
    return false;
  }
}

/** H37 — normalize a loaded LIFE blob. Walks fields that newer H
 *  commits added (and so older saves are missing) and fills in safe
 *  defaults in place. Currently covers H35/H36 newspaper state; future
 *  H commits append their own back-compat slots here.
 *
 *  Each entry in the newspaper is also sanitized: rows missing required
 *  fields are dropped, isPinned is coerced to boolean, and the array
 *  type itself is replaced if it isn't actually an array. */
function normalizeLoadedLife(life: GameContext['life']): void {
  if (!life) return;
  if (!Array.isArray(life.newspaper)) {
    life.newspaper = [];
  } else {
    life.newspaper = life.newspaper.filter((row): row is typeof life.newspaper[number] => {
      if (!row || typeof row !== 'object') return false;
      const r = row as { type?: unknown };
      return r.type === 'car' || r.type === 'house';
    });
    for (const row of life.newspaper) {
      // Coerce isPinned to a real boolean (JSON undefined survives,
      // truthy other values shouldn't be in here, but be defensive).
      (row as { isPinned?: unknown }).isPinned = !!(row as { isPinned?: unknown }).isPinned;
    }
  }
  if (life.newspaperSection !== 'cars' && life.newspaperSection !== 'homes') {
    life.newspaperSection = 'cars';
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
