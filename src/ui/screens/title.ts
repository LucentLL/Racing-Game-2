/**
 * Title screen — first thing the player sees.
 *
 * Renders a single random day-cycle title image (night / sunrise / day /
 * sunset, picked once at module init in v8.99.124.11 — no crossfade) with
 * an object-fit:cover sizing pass + a bottom darkening gradient so the
 * NEW GAME / LOAD GAME buttons stay legible across all four scenes.
 *
 * NEW GAME confirms before overwriting an existing save (two-tap
 * pattern). LOAD GAME first tries localStorage, then falls back to a
 * file-picker for imported .json saves.
 *
 * Ported from monolith L44040-44170.
 *
 * SCAFFOLD status: type contract + entry points stubbed with TODO line
 * refs. Image preload + scene picker stay external (assets module).
 */

/** Per-frame inputs for the title-screen draw pass. */
export interface TitleScreenOpts {
  /** Preloaded title image (one of CLT-Title-{Day,Night,Sunrise,Sunset}.png). */
  titleImg: HTMLImageElement;
  /** Hovered button index for keyboard/gamepad highlight. -1 if none. */
  hover: number;
  /** True when NEW GAME has been tapped once with a save present (the
   *  ⚠ ARE YOU SURE? state). Caller resets to false on second tap or any
   *  other interaction. */
  confirmNewGame: boolean;
  /** True when localStorage.driverCitySave exists — drives LOAD GAME color. */
  hasSave: boolean;
  /** Canvas internal width / height. */
  GW: number;
  GH: number;
}

/** Buttons return value: -1 = miss, 0 = NEW GAME, 1 = LOAD GAME. */
export type TitleHit = -1 | 0 | 1;

/** Draws the title scene + two buttons. Falls back to an animated
 *  "LOADING TITLE..." string when the image hasn't streamed in yet.
 *  TODO(D28-followup): port from L44041-44098. */
export function drawTitleScreen(
  _ctx: CanvasRenderingContext2D,
  _opts: TitleScreenOpts,
): void {
  // TODO: L44041-44098.
}

/** Hit-tests the two buttons. Hit-box uses GH_BASE (HUD canvas height)
 *  not GH so click-coords map correctly via hcanvas rect (v8.98.30).
 *  TODO(D28-followup): port from L44099-44110. */
export function titleBtnHit(
  _tx: number,
  _ty: number,
  _GW: number,
  _GH_BASE: number,
): TitleHit {
  // TODO: L44099-44110.
  return -1;
}

/** Routes a button hit. Returns true if the tap was consumed.
 *  Side effects (caller-supplied callbacks):
 *    - onNewGame() — clears localStorage.driverCitySave, starts name entry.
 *    - onLoadFromStorage() — attempts loadGame(), returns success.
 *    - onLoadFromFile(jsonText) — called with file contents from picker.
 *  TODO(D28-followup): port from L44111-44170. */
export interface TitleClickDeps {
  /** Confirm-overwrite tracker — caller flips to true on first tap, false
   *  on success. */
  setConfirmNewGame(value: boolean): void;
  showNotif(msg: string): void;
  startNewGame(): void;
  loadFromStorage(): boolean;
  loadFromFile(jsonText: string): boolean;
}

export function handleTitleClick(
  _tx: number,
  _ty: number,
  _opts: TitleScreenOpts,
  _deps: TitleClickDeps,
): boolean {
  // TODO: L44111-44170.
  return false;
}
