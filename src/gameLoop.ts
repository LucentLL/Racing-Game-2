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
 *        nameEntry      → DOM overlay (H3 — body ported, no canvas paint)
 *        jobSelect      → drawJobSelect (H4 — body ported, wheel scroll)
 *        carSelect      → drawCarSelect (H5 — body ported, wheel scroll;
 *                                        choices currently stubbed)
 *        playing        → full update + lifeSim + traffic + audio + render (H<n>)
 *
 * H5 status: full character-creation chain (title → name → job → car)
 * now wired end-to-end. carSelect's choice list is stubbed with 4 fixed
 * deals (no credit / used-price / lease math yet); real
 * generateStartingCarChoices port lands in a follow-up. onPick advances
 * to 'playing' placeholder.
 */

import type { GameContext, GameState, StartingConditions } from '@/state/gameState';
import { drawTitleScreen, handleTitleClick, type TitleClickDeps } from '@/ui/screens/title';
import { ensureNameOverlay, hideNameOverlay, type NameEntryDeps } from '@/ui/screens/nameEntry';
import { drawJobSelect, handleJobSelectClick, maxJobScroll, type JobSelectDeps, type JobSelectOpts } from '@/ui/screens/jobSelect';
import {
  drawCarSelect,
  handleCarSelectClick,
  maxCarScroll,
  type CarChoice,
  type CarSelectDeps,
  type CarSelectHeader,
  type CarSelectOpts,
} from '@/ui/screens/carSelect';

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
      // DOM overlay handles its own painting.
      return;
    case 'jobSelect':
      drawJobs(deps);
      return;
    case 'carSelect':
      drawCars(deps);
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

/** Build the JobSelectOpts payload from GameContext. character +
 *  startingConditions are non-null whenever gameState==='jobSelect'
 *  (the nameEntry→jobSelect transition seeds them). The non-null
 *  asserts here are the contract — they'd indicate a bug elsewhere
 *  if they fired. */
function buildJobSelectOpts(deps: GameLoopDeps): JobSelectOpts {
  const character = deps.ctx.character!;
  const conds = deps.ctx.startingConditions!;
  return {
    playerAlias: character.playerAlias,
    age: character.age,
    money: conds.money,
    gender: character.gender,
    fitness: conds.fitness,
    skinTone: conds.skinTone,
    housingName: conds.housingName,
    mechSkill: conds.mechSkill,
    scrollY: deps.ctx.jobSelect.scrollY,
    GW: deps.hudCanvas.width,
    GH: deps.hudCanvas.height,
  };
}

function drawJobs(deps: GameLoopDeps): void {
  const { hctx } = deps;
  clearMainAndPaintHud(deps, () => {
    drawJobSelect(hctx, buildJobSelectOpts(deps));
  });
}

function buildCarSelectOpts(deps: GameLoopDeps): CarSelectOpts {
  const payload = deps.ctx.carSelect.payload!;
  return {
    header: payload.header as CarSelectHeader,
    choices: payload.choices as CarChoice[],
    scrollY: deps.ctx.carSelect.scrollY,
    GW: deps.hudCanvas.width,
    GH: deps.hudCanvas.height,
  };
}

function drawCars(deps: GameLoopDeps): void {
  const { hctx } = deps;
  clearMainAndPaintHud(deps, () => {
    drawCarSelect(hctx, buildCarSelectOpts(deps));
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

/** Stub starting conditions when transitioning name→job. Replaced by
 *  rollStartingConditions when that body ports (src/sim/startingConditions
 *  or similar). Default values mirror the loose v8.99.x ranges for a
 *  ~25yo Lean character so the screen reads sensibly. */
function stubStartingConditions(): StartingConditions {
  return {
    money: 500,
    housingType: 'apt1br',
    housingName: '1BR Apartment',
    mechSkill: 12,
    fitness: 50,
    skinTone: 1,
  };
}

/** Stub starting-car choices when transitioning job→car. Replaced by
 *  generateStartingCarChoices when that body ports. The 4 fixed deals
 *  here exercise all four kinds (BEATER / USED RELIABLE / NEW — LOAN /
 *  LEASE) so the renderer's color-by-kind branch is visibly correct.
 *  carId values match well-known IDs from monolith VEHICLE_IMAGE_MANIFEST
 *  but no CARS lookup happens here — carName is pre-resolved. */
function stubCarChoices(ctx: { character: NonNullable<GameContext['character']>; startingConditions: NonNullable<GameContext['startingConditions']>; playerJob: NonNullable<GameContext['playerJob']> }): { header: CarSelectHeader; choices: CarChoice[] } {
  const money = ctx.startingConditions.money;
  const header: CarSelectHeader = {
    playerAlias: ctx.character.playerAlias,
    playerJob: ctx.playerJob,
    money,
    gender: ctx.character.gender,
    fitness: ctx.startingConditions.fitness,
    skinTone: ctx.startingConditions.skinTone,
    credit: { tier: 'FAIR', color: '#ff0' },
    creditScore: 640,
    jobMo: 2000,
  };
  const choices: CarChoice[] = [
    {
      kind: 'BEATER',
      carId: 'sedan',
      carName: 'Ford Taurus (1993)',
      transType: 'AUTO',
      price: 450,
      cond: 32,
      mileage: 187_000,
      tagline: 'Runs. Probably.',
      canAfford: money >= 450,
      locked: false,
      financeType: 'cash',
    },
    {
      kind: 'USED RELIABLE',
      carId: 'civic99',
      carName: 'Honda Civic (1996)',
      transType: 'AUTO',
      price: 3200,
      cond: 78,
      mileage: 62_000,
      tagline: 'Boring. Bulletproof.',
      canAfford: money >= 500,
      locked: false,
      financeType: 'loan',
      down: 500,
      monthly: 95,
      term: 36,
    },
    {
      kind: 'NEW — LOAN',
      carId: 'accord99',
      carName: 'Honda Accord (1999)',
      transType: 'AUTO',
      price: 18_500,
      cond: 100,
      mileage: 12,
      tagline: 'Showroom floor. Smells like new.',
      canAfford: money >= 1850,
      locked: false,
      financeType: 'loan',
      down: 1850,
      monthly: 365,
      term: 60,
    },
    {
      kind: 'LEASE',
      carId: 'accord99',
      carName: 'Honda Accord (1999) — Lease',
      transType: 'AUTO',
      price: 18_500,
      cond: 100,
      mileage: 12,
      tagline: 'Walk-away after 36 months.',
      blockReason: 'Credit below 650 (stub)',
      canAfford: true,
      locked: true,
      financeType: 'lease',
      down: 1500,
      monthly: 280,
      term: 36,
    },
  ];
  return { header, choices };
}

/** Click/tap dispatcher. Routes by gameState — wired-up states get
 *  their real handler; unfinished states still cycle for testing. */
function installClickRouter(deps: GameLoopDeps): void {
  const placeholderCycle: GameState[] = ['carSelect', 'playing', 'title'];

  const advancePlaceholder = (): void => {
    const i = placeholderCycle.indexOf(deps.ctx.gameState);
    deps.ctx.gameState = placeholderCycle[(i + 1) % placeholderCycle.length];
  };

  const notif = (msg: string): void => {
    if (__DEV__) console.log(`[notif] ${msg}`);
  };

  const nameEntryDeps: NameEntryDeps = {
    showNotif: notif,
    onCommit: (commit) => {
      deps.ctx.character = commit;
      // Stub starting conditions until rollStartingConditions ports.
      deps.ctx.startingConditions = stubStartingConditions();
      deps.ctx.jobSelect.scrollY = 0;
      hideNameOverlay();
      deps.ctx.gameState = 'jobSelect';
    },
  };

  const jobSelectDeps: JobSelectDeps = {
    onPick: (jobName) => {
      deps.ctx.playerJob = jobName;
      // Stub car choices until generateStartingCarChoices ports.
      const ctxRef = deps.ctx;
      deps.ctx.carSelect.payload = stubCarChoices({
        character: ctxRef.character!,
        startingConditions: ctxRef.startingConditions!,
        playerJob: jobName,
      });
      deps.ctx.carSelect.scrollY = 0;
      deps.ctx.gameState = 'carSelect';
    },
  };

  const carSelectDeps: CarSelectDeps = {
    showNotif: notif,
    onPick: (_choice) => {
      // Game-start wiring (applyCssTilt, dayPhase='home', newspaper,
      // availJobs, initAudio, monthly-bills trigger if day===1) lives
      // in subsequent H commits. For now: advance to 'playing'
      // placeholder. The chosen car is dropped on the floor temporarily;
      // applyStartingCarChoice port wires LIFE.ownedCars etc.
      deps.ctx.gameState = 'playing';
    },
  };

  const titleDeps: TitleClickDeps = {
    setConfirmNewGame: (v) => { deps.ctx.title.confirmNewGame = v; },
    showNotif: notif,
    startNewGame: () => {
      localStorage.removeItem(SAVE_STORAGE_KEY);
      deps.ctx.gameState = 'nameEntry';
      ensureNameOverlay(nameEntryDeps);
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
    if (state === 'jobSelect') {
      handleJobSelectClick(tx, ty, buildJobSelectOpts(deps), jobSelectDeps);
      return;
    }
    if (state === 'carSelect') {
      handleCarSelectClick(tx, ty, buildCarSelectOpts(deps), carSelectDeps);
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

  // Wheel scrolling for jobSelect / carSelect (mobile touch scroll lands
  // in the input pipeline port).
  deps.hudCanvas.addEventListener('wheel', (e) => {
    const state = deps.ctx.gameState;
    if (state === 'jobSelect') {
      e.preventDefault();
      const max = maxJobScroll(deps.hudCanvas.height);
      deps.ctx.jobSelect.scrollY = Math.max(0, Math.min(max, deps.ctx.jobSelect.scrollY + e.deltaY));
    } else if (state === 'carSelect') {
      e.preventDefault();
      const choiceCount = deps.ctx.carSelect.payload?.choices.length ?? 0;
      const max = maxCarScroll(deps.hudCanvas.height, choiceCount);
      deps.ctx.carSelect.scrollY = Math.max(0, Math.min(max, deps.ctx.carSelect.scrollY + e.deltaY));
    }
  }, { passive: false });
}
