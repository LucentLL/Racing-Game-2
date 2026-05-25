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
 *  Real roller lives at src/sim/startingConditions.ts (housing tier,
 *  mech skill, fitness band); the H4-era "stubbed defaults" caveat is
 *  no longer accurate. */
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
  /** EFFECTIVE input read by arcadeUpdate. Recomputed each frame in
   *  dispatch from inputHeld | gamepad-derived booleans (H139). Direct
   *  mutation only happens for hard resets (T-key state flush). */
  input: import('./input').InputState;
  /** H139: digital held-state, the write target for the keyboard
   *  listeners AND the on-screen mobile buttons (both are binary
   *  press/release sources). Dispatch ORs this with the gamepad-
   *  derived booleans each frame to produce the effective `input`
   *  field above. Splitting the two lets gamepad release cleanly drop
   *  the effective bit instead of getting stuck on the last keyboard
   *  / touch value. */
  inputHeld: import('./input').InputState;
  /** H136: latest gamepad snapshot, refreshed every RAF tick by
   *  pollGamepad() before dispatch. Mirrors monolith L50904 — polled
   *  in ALL states (not just 'playing') so menu code can read D-pad /
   *  start / A-button without writing its own poll. Always present;
   *  `.connected` flags whether a pad is actually attached. */
  gamepad: import('@/input/gamepad').GamepadFrame;
  tileMap: import('@/world/tileMap').TileMap;
  minimap: import('@/render/minimap').MinimapBake;
  clock: import('./clock').Clock;
  audio: import('@/audio/arcadeAudio').ArcadeAudio;
  traffic: import('./traffic').TrafficCar[];
  /** H48 — persistent tire-mark trail. */
  skidMarks: import('./skidMarks').SkidMarkState;
  /** H50 — drift smoke + crash spark particle pool. */
  particles: import('@/render/particles').ParticleState;
  /** H56 — Akira-style taillight trail (high-speed night driving). */
  speedTrail: import('./speedTrail').SpeedTrailState;
  /** Set on entry to 'playing' by applyStartingConditions + apply
   *  starting car. Null in earlier states (so save/load knows the
   *  player hasn't committed yet). */
  life: import('./life').LifeState | null;
  /** H30: home-screen overlay state. Always allocated; `open` gates
   *  visibility, `tab` selects the active sub-view. */
  home: {
    open: boolean;
    tab: import('@/ui/screens/home/overlay').HomeTab;
  };
  /** H115: world-editor state. Always allocated so F9 can flip it on
   *  without re-checking. `active` gates whether the game loop short-
   *  circuits into _weTick. Dev-gated at the input layer via Vite's
   *  import.meta.env.DEV. */
  worldEditor: import('@/editor').WorldEditorState;
  /** H192: main pause menu overlay state. Opened by tapping the top-
   *  right HUD corner (tx > GW-82, ty < 64) or gamepad START / Y.
   *  Mirrors the monolith's `menuOpen`/`menuTab` globals; using a
   *  nested struct here to keep top-level GameContext tidy. */
  menu: {
    open: boolean;
    tab: import('@/ui/screens/pauseMenu').MenuTab;
  };
  /** H237: persistent marker for the most recent day we fired the
   *  day-rollover hooks (monthly pay / bills / newspaper refresh /
   *  daily health update / job-latch clears). Without this, doSleep
   *  bumping `clock.day++` between frames silently skipped the
   *  hooks because the in-frame `prevDay` capture was already at
   *  the new value. Each frame: if (clock.day > lastProcessedDay)
   *  fire the hooks + update lastProcessedDay. */
  lastProcessedDay: number;
  /** H178: full-screen city-map overlay flag — F key toggle. When
   *  true, drawPlaying paints a black backdrop + city-centered road
   *  network + legend on top of the regular HUD. The world keeps
   *  ticking underneath; this is purely a visual overlay. Tap
   *  anywhere on the map area to close, or press F again. */
  fullMapOpen: boolean;
  /** H248: aggregated fault-effect multipliers. Recomputed each
   *  frame (gameLoop drawPlaying) from life.faults via
   *  computeFaultEffects. Read by physics (accelMult / brakeMult /
   *  gripMult / fuelMult / steerPull) + render (nightVisMult / etc.)
   *  + HUD (hideGauges / rpmFlutter). Mirrors monolith _faultFX
   *  global at L43179. Initialized to the identity record so
   *  pre-life frames + frames with no active faults skip the loop. */
  faultEffects: import('@/sim/faultEffects').FaultEffects;
  /** H244: per-car condition snapshot map. Keyed by car catalog id;
   *  each entry carries the engine/tires/HP/paint/fuel/faults/RHD/
   *  manual snapshot taken when the player last drove that car. The
   *  active car's live values still live on `life.engine` etc. — they
   *  flush into this map on the next switchCar / saveGame call via
   *  saveCarCondition. Empty until the player owns more than one
   *  car (or until switchCar lands in H245); pre-seeded here so the
   *  H245 switchCar core has somewhere to write/read without a
   *  ctx-shape change. Mirrors the monolith `carConditions` global
   *  (L8975). */
  carConditions: Record<string, import('@/save/carCondition').CarConditionData>;
}

/** Build a fresh GameContext at boot. Caller supplies the title image
 *  element (allocated separately so the asset preload kicks off as
 *  early as possible during boot, before the loop even starts). */
import { createPlayerState } from './player';
import { createInputState } from './input';
import { createClock } from './clock';
import { createTileMap } from '@/world/tileMap';
import { buildBaselineMap } from '@/world/buildBaselineMap';
import { createMinimap } from '@/render/minimap';
import { createArcadeAudio } from '@/audio/arcadeAudio';
import { createTraffic } from './traffic';
import { createSkidMarkState } from './skidMarks';
import { createParticleState } from '@/render/particles';
import { createSpeedTrailState } from './speedTrail';
import { createWorldEditorState } from '@/editor';
import { createEmptyGamepadFrame } from '@/input/gamepad';
import { makeIdentityFaultEffects } from '@/sim/faultEffects';

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
    inputHeld: createInputState(),
    gamepad: createEmptyGamepadFrame(),
    tileMap,
    minimap,
    clock: createClock(),
    audio: createArcadeAudio(),
    traffic: createTraffic(),
    skidMarks: createSkidMarkState(),
    particles: createParticleState(),
    speedTrail: createSpeedTrailState(),
    life: null,
    home: { open: false, tab: 'main' },
    menu: { open: false, tab: 'car' },
    // H237: initialized to whatever clock.day starts at so the first
    // frame's rollover check sees no diff.
    lastProcessedDay: 1,
    worldEditor: createWorldEditorState(),
    fullMapOpen: false,
    carConditions: {},
    faultEffects: makeIdentityFaultEffects(),
  };
}
