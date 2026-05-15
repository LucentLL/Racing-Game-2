/**
 * RAF loop + gameState dispatch.
 *
 * Mirrors monolith L50892-51020. The loop's responsibilities, in order:
 *   1. Update per-frame timing (lastTime → dt; clamp; FPS sample).
 *   2. [TODO H-followup] pollGamepad — runs in EVERY state for menu nav.
 *   3. [TODO H-followup] World Editor active short-circuit:
 *      if WORLD_EDITOR.active, _weTick() and return (game pauses).
 *   4. Branch on gameState:
 *        title          → drawTitleScreen (H2 — body ported)
 *        nameEntry / jobSelect / carSelect → placeholder (H3+)
 *        playing        → full update + lifeSim + traffic + audio + render (H<n>)
 *
 * H2 status: title state wired with real draw + click handler. Other
 * states still placeholders that cycle on tap.
 */

import type { GameContext, GameState } from '@/state/gameState';
import { drawTitleScreen, handleTitleClick, type TitleClickDeps } from '@/ui/screens/title';

const SAVE_STORAGE_KEY = 'driverCitySave';

/** Resources the loop needs handed to it once at boot. The loop never
 *  reads from DOM directly outside this struct, which makes it
 *  unit-testable with a stub canvas + 2d context. */
export interface GameLoopDeps {
  mainCanvas: HTMLCanvasElement;
  mainCtx: CanvasRenderingContext2D;
  hudCanvas: HTMLCanvasElement;
  hctx: CanvasRenderingContext2D;
  ctx: GameContext;
}

/** Boot the loop. Returns nothing — the loop drives itself via RAF
 *  recursion. Call once from main.ts after all state is allocated. */
export function startGameLoop(deps: GameLoopDeps): void {
  installClickRouter(deps);

  const tick = (ts: number): void => {
    updateFrameStats(deps.ctx, ts);
    dispatch(deps);
    requestAnimationFrame(tick);
  };

  requestAnimationFrame(tick);
}

/** Updates lastTime, dt, fpsCount, fpsTime, fpsDisplay. The dt clamp
 *  (50ms ceiling) mirrors the monolith's `Math.min(0.05, ...)` so a
 *  long tab-suspend doesn't produce a single huge dt that blows up
 *  whatever physics integrators come online in later commits. */
function updateFrameStats(ctx: GameContext, ts: number): void {
  const frame = ctx.frame;
  frame.dt = Math.min(0.05, (ts - frame.lastTime) / 1000 || 0.016);
  frame.lastTime = ts;
  frame.fpsCount++;
  frame.fpsTime += frame.dt;
  if (frame.fpsTime >= 0.5) {
    frame.fpsDisplay = Math.round(frame.fpsCount / frame.fpsTime);
    frame.fpsCount = 0;
    frame.fpsTime = 0;
  }
}

/** Branch on gameState. */
function dispatch(deps: GameLoopDeps): void {
  switch (deps.ctx.gameState) {
    case 'title':
      drawTitle(deps);
      return;
    case 'nameEntry':
    case 'jobSelect':
    case 'carSelect':
      drawUiPlaceholder(deps);
      return;
    case 'playing':
      drawPlayingPlaceholder(deps);
      return;
  }
}

/** Clears the main canvas (matches monolith's _drawUIStateFlat backdrop
 *  pattern) then calls the supplied draw function on the HUD context. */
function clearMainAndPaintHud(deps: GameLoopDeps, drawFn: () => void): void {
  const { mainCtx, mainCanvas, hctx } = deps;
  mainCtx.setTransform(1, 0, 0, 1, 0, 0);
  mainCtx.fillStyle = '#0a0a12';
  mainCtx.fillRect(0, 0, mainCanvas.width, mainCanvas.height);
  hctx.setTransform(1, 0, 0, 1, 0, 0);
  drawFn();
}

function drawTitle(deps: GameLoopDeps): void {
  const { hctx, hudCanvas, ctx } = deps;
  clearMainAndPaintHud(deps, () => {
    drawTitleScreen(hctx, {
      titleImg: ctx.title.img,
      hover: ctx.title.hover,
      confirmNewGame: ctx.title.confirmNewGame,
      hasSave: !!localStorage.getItem(SAVE_STORAGE_KEY),
      GW: hudCanvas.width,
      GH: hudCanvas.height,
    });
  });
}

/** Paint a placeholder for the not-yet-ported UI states (nameEntry,
 *  jobSelect, carSelect). Same shape as H1's drawUiPlaceholder but only
 *  used for the remaining unfinished states. */
function drawUiPlaceholder(deps: GameLoopDeps): void {
  const { hctx, hudCanvas, ctx } = deps;
  clearMainAndPaintHud(deps, () => {
    hctx.fillStyle = '#0a0a12';
    hctx.fillRect(0, 0, hudCanvas.width, hudCanvas.height);

    hctx.textAlign = 'center';
    hctx.fillStyle = '#0ff';
    hctx.font = 'bold 22px monospace';
    hctx.fillText('DRIVER CITY', hudCanvas.width / 2, hudCanvas.height / 2 - 60);

    hctx.fillStyle = '#fff';
    hctx.font = 'bold 16px monospace';
    hctx.fillText(`STATE: ${ctx.gameState}`, hudCanvas.width / 2, hudCanvas.height / 2 - 20);

    hctx.fillStyle = '#888';
    hctx.font = '12px monospace';
    hctx.fillText(`${ctx.frame.fpsDisplay} FPS`, hudCanvas.width / 2, hudCanvas.height / 2 + 10);
    hctx.fillText('(tap / click to advance — H placeholder)', hudCanvas.width / 2, hudCanvas.height / 2 + 30);

    hctx.fillStyle = '#555';
    hctx.font = '10px monospace';
    hctx.fillText('Phase H body-porting in progress', hudCanvas.width / 2, hudCanvas.height - 12);
  });
}

/** Playing-state placeholder. Subsequent ports fill this with the real
 *  update() + render() pipeline. */
function drawPlayingPlaceholder(deps: GameLoopDeps): void {
  const { mainCtx, hctx, mainCanvas, hudCanvas, ctx } = deps;
  mainCtx.setTransform(1, 0, 0, 1, 0, 0);
  mainCtx.fillStyle = '#1a2818';
  mainCtx.fillRect(0, 0, mainCanvas.width, mainCanvas.height);

  hctx.setTransform(1, 0, 0, 1, 0, 0);
  hctx.clearRect(0, 0, hudCanvas.width, hudCanvas.height);
  hctx.fillStyle = '#fff';
  hctx.font = 'bold 14px monospace';
  hctx.textAlign = 'left';
  hctx.fillText(`STATE: playing — ${ctx.frame.fpsDisplay} FPS`, 12, 24);
  hctx.fillText('(no update/render bodies ported yet)', 12, 44);
}

/** Click/tap dispatcher. Routes by gameState — wired-up states get
 *  their real handler; unfinished states still cycle for testing. */
function installClickRouter(deps: GameLoopDeps): void {
  const placeholderCycle: GameState[] = ['nameEntry', 'jobSelect', 'carSelect', 'playing', 'title'];

  const advancePlaceholder = (): void => {
    const i = placeholderCycle.indexOf(deps.ctx.gameState);
    deps.ctx.gameState = placeholderCycle[(i + 1) % placeholderCycle.length];
  };

  const titleDeps: TitleClickDeps = {
    setConfirmNewGame: (v) => { deps.ctx.title.confirmNewGame = v; },
    showNotif: (msg) => {
      if (__DEV__) console.log(`[notif] ${msg}`);
    },
    startNewGame: () => {
      localStorage.removeItem(SAVE_STORAGE_KEY);
      deps.ctx.gameState = 'nameEntry';
    },
    loadFromStorage: () => {
      // Save bodies aren't ported yet — always returns false so we fall
      // through to the file picker stub. Real loadGame() lands in a
      // later H commit (H<save>).
      return false;
    },
    openFileLoadPicker: () => {
      if (__DEV__) console.log('[title] file-picker fallback not wired yet (H<save> follow-up)');
    },
  };

  const screenCoords = (clientX: number, clientY: number): { tx: number; ty: number } => {
    const rect = deps.hudCanvas.getBoundingClientRect();
    const scaleX = deps.hudCanvas.width / rect.width;
    const scaleY = deps.hudCanvas.height / rect.height;
    return {
      tx: (clientX - rect.left) * scaleX,
      ty: (clientY - rect.top) * scaleY,
    };
  };

  const onTap = (clientX: number, clientY: number): void => {
    const { tx, ty } = screenCoords(clientX, clientY);
    const state = deps.ctx.gameState;
    if (state === 'title') {
      const consumed = handleTitleClick(tx, ty, {
        titleImg: deps.ctx.title.img,
        hover: deps.ctx.title.hover,
        confirmNewGame: deps.ctx.title.confirmNewGame,
        hasSave: !!localStorage.getItem(SAVE_STORAGE_KEY),
        GW: deps.hudCanvas.width,
        GH: deps.hudCanvas.height,
      }, titleDeps);
      if (consumed) return;
      // Tap missed the buttons — no state change.
      return;
    }
    // Placeholder states still cycle on tap.
    advancePlaceholder();
  };

  deps.hudCanvas.addEventListener('click', (e) => onTap(e.clientX, e.clientY));
  deps.hudCanvas.addEventListener('touchend', (e) => {
    if (e.changedTouches.length === 0) return;
    e.preventDefault();
    const t = e.changedTouches[0];
    onTap(t.clientX, t.clientY);
  }, { passive: false });
}
