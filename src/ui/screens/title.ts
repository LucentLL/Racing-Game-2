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
 * Ported from monolith L43959-44088.
 *
 * H2: bodies live. Two simplifications vs the monolith pending later H
 * commits:
 *   - hasSave check reads localStorage.driverCitySave directly inline
 *     (matches monolith); save/persistence module wires the key
 *     constant in a later H commit.
 *   - LOAD GAME's file-picker fallback (the inp = createElement('input')
 *     block, monolith L44062-44083) is intentionally NOT ported here —
 *     it depends on loadGame() being callable, which needs save bodies
 *     ported first. Caller's onLoadFromFile dep is invoked with the
 *     file's text string; the UI hookup happens after H<save> lands.
 */

import { GT2_COLORS } from '@/ui/gt2Chrome';

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

/** Button geometry constants — used by both draw and hit-test so the
 *  click region stays exactly aligned with the visible button. */
const BTN_W = 160;
const BTN_H = 28;
/** Buttons sit in the bottom 35% of the canvas (gradient region). */
const BTN_Y1_FRAC = 0.73;
const BTN_Y2_FRAC = 0.86;

/** Draws the title scene + two buttons. Falls back to an animated
 *  "LOADING TITLE..." string when the image hasn't streamed in yet.
 *  Ported from monolith L43959-44016. */
export function drawTitleScreen(
  ctx: CanvasRenderingContext2D,
  opts: TitleScreenOpts,
): void {
  const { titleImg, hover, confirmNewGame, hasSave, GW, GH } = opts;

  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, GW, GH);

  // v8.99.124.11: object-fit:cover sizing pass. Pick the dimension that
  // makes the image larger than the viewport (so it never letterboxes)
  // and center the overflow.
  const ttNow = typeof performance !== 'undefined' ? performance.now() : Date.now();
  if (titleImg.complete && titleImg.naturalWidth > 0) {
    const imgR = titleImg.naturalWidth / titleImg.naturalHeight;
    const screenR = GW / GH;
    let dw: number;
    let dh: number;
    if (imgR > screenR) {
      dh = GH;
      dw = GH * imgR;
    } else {
      dw = GW;
      dh = GW / imgR;
    }
    const dx = (GW - dw) / 2;
    const dy = (GH - dh) / 2;
    ctx.drawImage(titleImg, dx, dy, dw, dh);

    // Bottom darkening gradient so New Game / Load Game stay readable
    // across all four day-cycle scenes (especially noon and sunset).
    const grad = ctx.createLinearGradient(0, GH * 0.55, 0, GH);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(1, 'rgba(0,0,0,0.65)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, GH * 0.55, GW, GH * 0.45);
  } else {
    // Loading dots animation — visible on slow connections.
    ctx.fillStyle = '#888';
    ctx.font = 'bold 12px monospace';
    ctx.textAlign = 'center';
    const dots = '.'.repeat(1 + (Math.floor(ttNow / 400) % 3));
    ctx.fillText('LOADING TITLE' + dots, GW / 2, GH * 0.45);
    ctx.textAlign = 'left';
  }

  // Buttons in bottom 35%. H763: GT2 amber palette — hovered button
  // uses the active orange (#ff7a18), idle uses dim amber, confirm
  // uses the bright amber for urgency. Background plate is the GT2
  // bgDeep with 0.8 alpha so the title image bleeds through.
  ctx.font = 'bold 14px monospace';
  ctx.textAlign = 'center';
  const bx = GW / 2 - BTN_W / 2;
  const btnY1 = GH * BTN_Y1_FRAC;
  const btnY2 = GH * BTN_Y2_FRAC;

  // New Game
  const h0 = hover === 0;
  ctx.fillStyle = 'rgba(20,20,20,0.8)';
  ctx.fillRect(bx, btnY1, BTN_W, BTN_H);
  ctx.strokeStyle = confirmNewGame ? GT2_COLORS.active : h0 ? GT2_COLORS.active : GT2_COLORS.amberDark;
  ctx.lineWidth = 2;
  ctx.strokeRect(bx, btnY1, BTN_W, BTN_H);
  ctx.fillStyle = confirmNewGame ? GT2_COLORS.active : h0 ? GT2_COLORS.active : GT2_COLORS.text;
  ctx.fillText(confirmNewGame ? '⚠ ARE YOU SURE?' : 'New Game', GW / 2, btnY1 + BTN_H / 2 + 5);

  // Load Game — visually active when a save exists OR when hovered.
  const h1 = hover === 1;
  ctx.fillStyle = 'rgba(20,20,20,0.8)';
  ctx.fillRect(bx, btnY2, BTN_W, BTN_H);
  ctx.strokeStyle = h1 ? GT2_COLORS.active : hasSave ? GT2_COLORS.amber : GT2_COLORS.amberDark;
  ctx.lineWidth = 2;
  ctx.strokeRect(bx, btnY2, BTN_W, BTN_H);
  ctx.fillStyle = h1 ? GT2_COLORS.active : hasSave ? GT2_COLORS.amber : GT2_COLORS.text;
  ctx.fillText('Load Game', GW / 2, btnY2 + BTN_H / 2 + 5);
  ctx.textAlign = 'left';
}

/** Hit-tests the two buttons. Hit-box uses the supplied GH_BASE (the
 *  HUD canvas height) NOT the tilted main-canvas GH — click coords come
 *  in from the hcanvas rect, so the buttons need to be tested against
 *  hcanvas dimensions (v8.98.30 fix). Ported from monolith L44017-44028. */
export function titleBtnHit(
  tx: number,
  ty: number,
  GW: number,
  GH_BASE: number,
): TitleHit {
  const bx = GW / 2 - BTN_W / 2;
  const btnY1 = GH_BASE * BTN_Y1_FRAC;
  const btnY2 = GH_BASE * BTN_Y2_FRAC;
  if (tx >= bx && tx <= bx + BTN_W) {
    if (ty >= btnY1 && ty <= btnY1 + BTN_H) return 0;
    if (ty >= btnY2 && ty <= btnY2 + BTN_H) return 1;
  }
  return -1;
}

/** Dependencies the click handler invokes for state-mutating side
 *  effects. Caller wires these to the right modules at boot. */
export interface TitleClickDeps {
  /** Confirm-overwrite tracker — caller flips to true on first tap, false
   *  on success / non-matching tap. */
  setConfirmNewGame(value: boolean): void;
  /** User-visible notification (e.g. "Save exists, tap again to overwrite"). */
  showNotif(msg: string): void;
  /** Clears localStorage save + transitions to nameEntry. */
  startNewGame(): void;
  /** Returns true if a save loaded successfully (transitions to playing). */
  loadFromStorage(): boolean;
  /** Triggers the file-picker fallback when no localStorage save is
   *  present. Called with the file's text contents once the user picks
   *  one; returns true on successful load. The picker UI itself is
   *  caller-owned so this module stays free of DOM. */
  openFileLoadPicker(): void;
}

/** Routes a button hit. Returns true if the tap was consumed (caller
 *  uses this to clear any other selection state). Ported from monolith
 *  L44029-44087. */
export function handleTitleClick(
  tx: number,
  ty: number,
  opts: TitleScreenOpts,
  deps: TitleClickDeps,
): boolean {
  const hit = titleBtnHit(tx, ty, opts.GW, opts.GH);
  if (hit === 0) {
    // NEW GAME — confirm before overwriting existing save.
    if (opts.hasSave && !opts.confirmNewGame) {
      deps.setConfirmNewGame(true);
      deps.showNotif('⚠ Save data exists! Tap NEW GAME again to overwrite.');
      return true;
    }
    deps.setConfirmNewGame(false);
    deps.startNewGame();
    return true;
  }
  // Any non-NEW-GAME tap clears the confirm latch.
  deps.setConfirmNewGame(false);
  if (hit === 1) {
    if (!deps.loadFromStorage()) {
      // No localStorage save — fall back to file-picker.
      deps.openFileLoadPicker();
    }
    return true;
  }
  return false;
}
