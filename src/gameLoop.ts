/**
 * RAF loop + gameState dispatch.
 *
 * Mirrors monolith L50892-51020. The loop's responsibilities, in order:
 *   1. Update per-frame timing (lastTime → dt; clamp; FPS sample).
 *   2. [TODO H-followup] pollGamepad — runs in EVERY state for menu nav.
 *   3. [TODO H-followup] World Editor active short-circuit:
 *      if WORLD_EDITOR.active, _weTick() and return (game pauses).
 *   4. Branch on gameState:
 *        title / nameEntry / jobSelect / carSelect → draw UI flat on the
 *           HUD canvas (the main canvas gets cleared to black as backdrop)
 *        playing → full update + lifeSim + traffic systems + audio + render
 *
 * H1 status: skeleton wired end-to-end. Each branch calls a placeholder
 * that paints "STATE: <name>" plus FPS on the HUD canvas so the loop is
 * visibly running. Subsequent H commits replace each placeholder with
 * the real ported body (drawTitleScreen, update(), render(), etc.).
 *
 * A click anywhere on the HUD canvas advances to the next state — a
 * stop-gap so H1 demonstrably proves dispatch + state mutation work
 * before the real input handlers land.
 */

import type { GameContext, GameState } from '@/state/gameState';

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
  installClickToAdvance(deps);

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

/** Branch on gameState. Each case is a placeholder until its body
 *  ports in a subsequent H commit. */
function dispatch(deps: GameLoopDeps): void {
  switch (deps.ctx.gameState) {
    case 'title':
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

/** Paint a placeholder for the UI states (title/nameEntry/jobSelect/
 *  carSelect). Clears the main canvas to black as a backdrop, then
 *  paints the HUD canvas with the current state name + FPS + a
 *  tap-to-advance hint. */
function drawUiPlaceholder(deps: GameLoopDeps): void {
  const { mainCtx, hctx, hudCanvas, ctx } = deps;
  mainCtx.setTransform(1, 0, 0, 1, 0, 0);
  mainCtx.fillStyle = '#0a0a12';
  mainCtx.fillRect(0, 0, deps.mainCanvas.width, deps.mainCanvas.height);

  hctx.setTransform(1, 0, 0, 1, 0, 0);
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
  hctx.fillText('(tap / click to advance — H1 demo)', hudCanvas.width / 2, hudCanvas.height / 2 + 30);

  hctx.fillStyle = '#555';
  hctx.font = '10px monospace';
  hctx.fillText('Phase H body-porting in progress', hudCanvas.width / 2, hudCanvas.height - 12);
}

/** Playing-state placeholder. Subsequent ports fill this with the real
 *  update() + render() pipeline. */
function drawPlayingPlaceholder(deps: GameLoopDeps): void {
  const { mainCtx, hctx, hudCanvas, ctx } = deps;
  mainCtx.setTransform(1, 0, 0, 1, 0, 0);
  mainCtx.fillStyle = '#1a2818';
  mainCtx.fillRect(0, 0, deps.mainCanvas.width, deps.mainCanvas.height);

  hctx.setTransform(1, 0, 0, 1, 0, 0);
  hctx.clearRect(0, 0, hudCanvas.width, hudCanvas.height);
  hctx.fillStyle = '#fff';
  hctx.font = 'bold 14px monospace';
  hctx.textAlign = 'left';
  hctx.fillText(`STATE: playing — ${ctx.frame.fpsDisplay} FPS`, 12, 24);
  hctx.fillText('(no update/render bodies ported yet)', 12, 44);
}

/** Tap-to-advance: cycles gameState through every value so H1 can
 *  visibly demonstrate dispatch + mutation. Removed in a later commit
 *  once each state has real input wired in. */
function installClickToAdvance(deps: GameLoopDeps): void {
  const order: GameState[] = ['title', 'nameEntry', 'jobSelect', 'carSelect', 'playing'];
  const advance = (): void => {
    const i = order.indexOf(deps.ctx.gameState);
    deps.ctx.gameState = order[(i + 1) % order.length];
  };
  deps.hudCanvas.addEventListener('click', advance);
  deps.hudCanvas.addEventListener('touchend', (e) => {
    e.preventDefault();
    advance();
  }, { passive: false });
}
