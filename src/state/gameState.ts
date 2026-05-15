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

/** Output of rollStartingConditions — used by jobSelect to render
 *  player summary, then by LIFE init to seed money/housing/skills.
 *  Stubbed with sensible defaults in H4 until the real roller ports
 *  (it's part of the sim layer; touches RANDOM_NAMES + housing tier
 *  rolls + mech skill + fitness band). */
export interface StartingConditions {
  money: number;
  /** Housing tier key — e.g. 'apt1br', 'rentHouse'. */
  housingType: string;
  /** Display name pulled from HOUSING_TIERS[housingType].name. */
  housingName: string;
  mechSkill: number;
  fitness: number;
  skinTone: number;
}

/** Per-screen scroll state. */
export interface JobSelectState {
  scrollY: number;
}

/** Per-screen scroll state + computed choices for carSelect. The
 *  monolith stores choices on LIFE._carSelect at job-pick time; we
 *  build them on the jobSelect→carSelect transition in gameLoop and
 *  stash here. CarSelectChoices is intentionally any[] to avoid a
 *  circular import — the screen module owns the CarChoice / Header
 *  types. */
export interface CarSelectState {
  scrollY: number;
  /** Pre-built choices payload (header + cards), set on transition
   *  into 'carSelect'. Null in earlier states. */
  payload: {
    header: unknown;
    choices: unknown[];
  } | null;
}

// Re-export so GameContext consumers can import PlayerState / InputState
// from one place.
export type { PlayerState } from './player';
export type { InputState } from './input';

/** The root game context. Allocated once at boot; mutated by the loop
 *  and by every system that participates in dispatch. */
export interface GameContext {
  gameState: GameState;
  frame: FrameStats;
  title: TitleScreenState;
  /** Set by nameEntry's NEXT button. Null until the player commits. */
  character: CharacterCommit | null;
  /** Set when transitioning into jobSelect (stubbed by gameLoop until
   *  rollStartingConditions ports). Null in title/nameEntry. */
  startingConditions: StartingConditions | null;
  /** The job the player picked. Null until handleJobSelectClick fires. */
  playerJob: import('@/config/jobs').JobName | null;
  jobSelect: JobSelectState;
  carSelect: CarSelectState;
  player: import('./player').PlayerState;
  input: import('./input').InputState;
  tileMap: import('@/world/tileMap').TileMap;
  minimap: import('@/render/minimap').MinimapBake;
}

/** Build a fresh GameContext at boot. Caller supplies the title image
 *  element (allocated separately so the asset preload kicks off as
 *  early as possible during boot, before the loop even starts). */
import { createPlayerState } from './player';
import { createInputState } from './input';
import { createTileMap } from '@/world/tileMap';
import { buildBaselineMap } from '@/world/buildBaselineMap';
import { createMinimap } from '@/render/minimap';

export function createGameContext(titleImg: HTMLImageElement): GameContext {
  const tileMap = createTileMap();
  buildBaselineMap(tileMap);
  const minimap = createMinimap();
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
    startingConditions: null,
    playerJob: null,
    jobSelect: { scrollY: 0 },
    carSelect: { scrollY: 0, payload: null },
    player: createPlayerState(),
    input: createInputState(),
    tileMap,
    minimap,
  };
}
