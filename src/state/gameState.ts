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

/** Title screen per-frame state. Survives across frames so the
 *  ⚠ ARE YOU SURE? confirm-overwrite flag persists between taps. */
export interface TitleScreenState {
  /** Preloaded scene image (one of the 4 CLT-Title-* PNGs). */
  img: HTMLImageElement;
  /** Hover index for keyboard/gamepad highlight (-1 / 0 / 1). */
  hover: number;
  /** First-tap latch for NEW GAME when a save already exists. */
  confirmNewGame: boolean;
}

/** Player character committed by the name-entry screen. Null before
 *  commit; populated when the player taps NEXT. Used by jobSelect /
 *  carSelect / starting-conditions math in later H commits. */
export interface CharacterCommit {
  playerName: string;
  playerAlias: string;
  age: number;
  gender: 'M' | 'F';
  testMode: boolean;
}

/** The root game context. Allocated once at boot; mutated by the loop
 *  and by every system that participates in dispatch. */
export interface GameContext {
  gameState: GameState;
  frame: FrameStats;
  title: TitleScreenState;
  /** Set by nameEntry's NEXT button. Null until the player commits. */
  character: CharacterCommit | null;
}

/** Build a fresh GameContext at boot. Caller supplies the title image
 *  element (allocated separately so the asset preload kicks off as
 *  early as possible during boot, before the loop even starts). */
export function createGameContext(titleImg: HTMLImageElement): GameContext {
  return {
    gameState: 'title',
    frame: {
      lastTime: 0,
      dt: 0.016,
      fpsCount: 0,
      fpsTime: 0,
      fpsDisplay: 0,
    },
    title: {
      img: titleImg,
      hover: -1,
      confirmNewGame: false,
    },
    character: null,
  };
}
