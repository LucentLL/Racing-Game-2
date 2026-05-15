/**
 * Top-level state-machine + per-frame stats for the game loop.
 *
 * GameState is the discriminator that drives gameLoop's branch dispatch.
 * The monolith stores it as a plain `let gameState='title';` (L2476);
 * we keep it on a typed object so subsequent ports can grow related
 * fields (LIFE, WORLD_EDITOR, player pose, etc.) without growing the
 * global namespace.
 *
 * FrameStats mirrors the monolith's frame metrics (L43822-43823):
 *   lastTime, gDt, fpsCount, fpsTime, fpsDisplay.
 * The loop reads/writes these every frame; isolating them in their own
 * type means render code that wants FPS can grab a FrameStats slice
 * without dragging the rest of GameContext.
 */

export type GameState =
  | 'title'
  | 'nameEntry'
  | 'jobSelect'
  | 'carSelect'
  | 'playing';

/** Per-frame timing + FPS counter. Mutated by the loop each tick. */
export interface FrameStats {
  /** ts of the previous RAF callback (ms since page nav). 0 on first frame. */
  lastTime: number;
  /** Delta-seconds since last frame, clamped to 0.05 (50ms / ~20fps minimum).
   *  The clamp prevents physics blow-ups after tab-suspend resumes with a
   *  huge gap. */
  dt: number;
  /** Frames counted in the current half-second sampling window. */
  fpsCount: number;
  /** Seconds elapsed in the current sampling window. */
  fpsTime: number;
  /** Latest computed FPS (refreshed every 0.5s). */
  fpsDisplay: number;
}

/** The root game context. Allocated once at boot; mutated by the loop
 *  and by every system that participates in dispatch. */
export interface GameContext {
  gameState: GameState;
  frame: FrameStats;
}

/** Build a fresh GameContext at boot. */
export function createGameContext(): GameContext {
  return {
    gameState: 'title',
    frame: {
      lastTime: 0,
      dt: 0.016,
      fpsCount: 0,
      fpsTime: 0,
      fpsDisplay: 0,
    },
  };
}
