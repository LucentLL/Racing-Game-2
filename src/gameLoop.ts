/**
 * RAF loop + gameState dispatch.
 *
 * Mirrors monolith L50892-51020. The loop's responsibilities, in order:
 *   1. Update per-frame timing (lastTime → dt; clamp; FPS sample).
 *   2. pollGamepad (H136) — runs in EVERY state so the menu screens
 *      (title / jobSelect / carSelect / home) can read D-pad and A/B
 *      without owning their own polling.
 *   3. [TODO H-followup] World Editor active short-circuit:
 *      if WORLD_EDITOR.active, _weTick() and return (game pauses).
 *   4. Branch on gameState:
 *        title          → drawTitleScreen (H2 — body ported)
 *        nameEntry      → DOM overlay (H3 — body ported, no canvas paint)
 *        jobSelect      → drawJobSelect (H4 — body ported, wheel scroll)
 *        carSelect      → drawCarSelect (H5 — body ported, wheel scroll;
 *                                        choices currently stubbed)
 *        playing        → arcadeUpdate + drawBaselineRoads + drawPlayerCar
 *                         (H6/H8 — arcade physics + Charlotte road
 *                         network; real update + render pipelines port
 *                         later)
 *
 * H36 status: NEWSPAPER classifieds now refresh daily via
 * fillNewspaperListings on every day rollover (real-clock tick AND
 * dev N-key skip). Expired rows roll off; pool tops up to 5 cars +
 * 3 houses. Tap-a-row in the newspaper tab toggles isPinned — pinned
 * listings survive daily refresh until unpinned. Map / minimap pin
 * rendering still deferred (worldX/Y + PlacedPin port land with the
 * map-pin subsystem).
 */

import type { GameContext, StartingConditions } from '@/state/gameState';
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
import { arcadeUpdate } from '@/physics/arcadeUpdate';
import { tickGearAndRpm } from '@/physics/gearAndRpm';
import { getTorqueAtRPM } from '@/physics/torqueCurve';
import { tickCameraAngle } from '@/state/player';
import { tickTrafficCollisions } from '@/physics/trafficCollision';
import { drawPlayerCar, drawPlayerCarV2, drawHeadlights } from '@/render/playerCar';
import { spriteForCarName } from '@/render/carSprites';
import { CAR_CATALOG } from '@/config/cars/catalog';
import { drawBaselineRoads } from '@/render/worldMap';
import { drawBuildings } from '@/render/buildings';
import { drawGrass } from '@/render/grass';
import { spawnSkidMarksIfNeeded, drawSkidMarks } from '@/state/skidMarks';
import { drawExitSigns, drawInterstateShields } from '@/render/highwaySigns';
import { drawStreetlights } from '@/render/streetlights';
import { drawCrosswalks } from '@/render/crosswalks';
import { tickSpeedTrail, drawSpeedTrail } from '@/state/speedTrail';
import {
  spawnDriftSmoke,
  spawnCrashSparks,
  spawnOffRoadDust,
  updateParticles,
  drawParticles,
} from '@/render/particles';
import { drawMinimap } from '@/render/minimap';
import { drawFullMap } from '@/render/fullMap';
import { drawGaugeCluster, type GaugeOpts } from '@/render/hud/gauges';
import { getGaugePreset } from '@/config/cars/gaugePresets';
import { getCarGeneration } from '@/render/carBody/generation';
import { getEffectiveUnit } from '@/state/effectiveRhd';
import { drawGasStations, tickRefuel } from '@/render/gasStations';
import { drawJobMarkers } from '@/render/jobMarkers';
import { drawHomeMarker, drawCarPinsWorld } from '@/render/worldMarkers';
import { drawTraffic, drawTrafficHeadlights, drawTrafficTailLights } from '@/render/traffic';
import { drawTrafficSignals } from '@/render/trafficSignals';
import { ROAD_CROSSINGS } from '@/world/roadCrossings';
import { tickTraffic } from '@/state/traffic';
import { applyDayNightTint } from '@/render/dayNightTint';
import { tickClock, formatClockTime, nightIntensity } from '@/state/clock';
import { isOnRoad, getTile } from '@/world/tileMap';
import { generateJobListings, generateDailyJob } from '@/sim/jobsRoller';
import { tickJobArrival } from '@/sim/jobArrival';
import { swapToJobVehicle, swapBackToPersonalCar } from '@/sim/jobVehicleSwap';
import { skipWork as runSkipWork } from '@/sim/skipWork';
import { switchCar as runSwitchCar } from '@/sim/switchCar';
import { computeFaultEffects, type FaultLike } from '@/sim/faultEffects';
import { newRaceSetup, generateRaceFinish, tickRace, applyRaceResult, type RaceFinishCandidate } from '@/sim/race';
import { drawRaceHud, handleRaceHudTap, type RaceHudRects, type RaceHudDeps } from '@/ui/overlays/raceHud';
import type { JobName } from '@/config/jobs';
import { unlockAudio } from '@/audio/arcadeAudio';
import {
  initAudio as initEngineAudio,
  updateAudio as updateEngineAudio,
  playCrashSound,
  playRefuelDing,
  playLowFuelBeep,
} from '@/engine/audio';
import { drawHomeOverlay, handleHomeOverlayClick, type HomeOverlayDeps } from '@/ui/screens/home/overlay';
import { fillNewspaperListings } from '@/sim/newspaperGenerator';
import { rollStartingConditions, rollStartingSavingsForJob } from '@/sim/startingConditions';
import { generateStartingCarChoices } from '@/sim/startingCars';
import { applyStartingConditions, applyStartingJob } from '@/sim/applyStartingConditions';
import { applyStartingCarChoice } from '@/sim/applyStartingCarChoice';
import { fireMonthlyBills, isMonthBoundary } from '@/sim/monthlyBills';
import { updateDailyHealth } from '@/sim/health';
import { fireMonthlyPay } from '@/sim/monthlyPay';
import { createDefaultLife } from '@/state/life';
import { setMobileControlsVisible } from '@/ui/mobileControls';
import { drawNotif, showNotif as setNotifState, tickNotif } from '@/ui/notif';
import { drawConfirmPrompt, handleConfirmPromptTap } from '@/ui/modals/confirm';
import { tickHomeHint, drawHomeHint, isHomeHintHit } from '@/ui/hud/homeHint';
import {
  checkNearPin,
  drawNearPinPrompt,
  isNearPinHit,
  getNearPin,
} from '@/ui/hud/nearPinPrompt';
import { drawBreakdownIndicator, isCallTowHit } from '@/ui/hud/breakdown';
import {
  drawPauseMenu,
  handlePauseMenuClick,
  isMenuOpenCornerHit,
  type PauseMenuDeps,
} from '@/ui/screens/pauseMenu';
import {
  drawSellerOverlay,
  handleSellerClick,
  checkSellerArrival,
  openSellerVisitFromPin,
  inspectSellerCar,
  haggleWithSeller,
  type CatalogLookup,
  type SellerDeps,
  type SellerVisitState,
} from '@/ui/modals/seller';
import {
  drawPurchaseMenu,
  handlePurchaseMenuClick,
  completePurchase,
  type PurchaseDeps,
} from '@/ui/modals/purchase';
import {
  openRealtorVisit,
  checkRealtorArrival,
  drawRealtorOverlay,
  handleRealtorTap,
  completeHomePurchase,
  type RealtorListing,
  type RealtorDeps,
} from '@/ui/modals/realtor';
import {
  drawOfficeMenu,
  handleOfficeMenuClick,
} from '@/ui/modals/officeMenu';
import { evaluateHomeOffer } from '@/sim/finance';
import { monthlyHousing } from '@/sim/billsCalc';
import { getCreditTier } from '@/sim/credit';
import { JOB_SALARY as JOB_SALARY_FOR_INCOME } from '@/config/jobs';
import { getFinanceOptions } from '@/sim/finance';
import { getTotalCarPayments } from '@/sim/finance';
import { TILE, WORLD_W, WORLD_H } from '@/config/world/tiles';
import { startTestDrive, endTestDrive, tickTestDrive } from '@/sim/sellerTestDrive';
import { saveGame, loadGame, loadGameFromText, exportSaveToFile, clearSave } from '@/save/interim';
import { isTauriRuntime, openFileNative } from '@/platform/desktop';
import { pollGamepad, gpPressed } from '@/input/gamepad';
import { playRumble } from '@/input/rumble';
import { tickRumbleStrip } from '@/input/rumbleStrip';
import { _weTick, _weToggle, _weExit, _weResizeCanvas, type EditorLifecycleDeps } from '@/editor';
import { _weCanvasMouseDown, _weCanvasMouseMove, _weCanvasMouseUp, _weCanvasWheel, _weCanvasContextMenu, _weDeleteSelected, WHEEL_ZOOM_FACTOR, ZOOM_MIN, ZOOM_MAX, type InputDeps as EditorInputDeps } from '@/editor/input';
import { _weScreenToTile } from '@/editor/render';
import { _weBeginDraft, _weCommitDraft, _weCancelDraft } from '@/editor/draft';
import { _weSaveOverlayToStorage, _weSaveBaselineEdits } from '@/editor/storage';
import { _weDetectAngleRefDirection, type AngleRefRoad } from '@/editor/angleRef';
import { _weCurrentRelativeAngleDeg } from '@/editor/select';
import { _weFindRiverSnap, _weFindSnap, type SnapDeps as EditorSnapDeps } from '@/editor/snap';
import { camYRatioForTilt } from '@/render/camera';
import { tiltState, effectiveTiltDeg, TILT_PERSPECTIVE_PX, CANVAS_OVERSCAN } from '@/engine/tilt';
import { rebuildRenderEntries, RENDER_ENTRIES, playerLayerZAt, playerSpeedLimitWpx, playerRoadInfoAt, MPH_TO_WPX, drawBridgeOverlays } from '@/render/worldMap';
import { rebuildBaselineMap } from '@/world/buildBaselineMap';
import { rebuildMinimap } from '@/render/minimap';
import { rebuildRoadCrossings } from '@/world/roadCrossings';

import { SAVE_KEY as SAVE_STORAGE_KEY } from '@/save/interim';

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
  installKeyboard(deps);
  installAudioUnlock(deps);
  installEditorBindings(deps);

  const tick = (ts: number): void => {
    updateFrameStats(deps.ctx, ts);
    // H136: 1:1 port of monolith L50904 (`pollGamepad(); // poll in
    // all states for menu navigation`). Runs BEFORE the editor short-
    // circuit and BEFORE dispatch so menu screens, the world-editor,
    // and the playing state all read the same fresh frame from
    // ctx.gamepad. The poll itself is cheap (one navigator.getGamepads
    // walk) and no-ops to a disconnected frame when no pad is present.
    deps.ctx.gamepad = pollGamepad();
    // H115: world-editor short-circuit. When active, the editor owns
    // the frame — game render + physics ticks pause until the user
    // exits via F9. Same pattern monolith uses at the top of its
    // main loop (gameLoop early-return on WORLD_EDITOR.active).
    if (deps.ctx.worldEditor.active) {
      _weTick(deps.ctx.worldEditor, editorDeps(deps));
      requestAnimationFrame(tick);
      return;
    }
    dispatch(deps);
    requestAnimationFrame(tick);
  };

  requestAnimationFrame(tick);
}

/** H115: build the editor's lifecycle-deps adapter from gameLoop's
 *  GameLoopDeps. Resolves DOM queries lazily so the editor can re-
 *  pick up canvas size changes on window resize. */
function editorDeps(deps: GameLoopDeps): EditorLifecycleDeps {
  return {
    isDevToolsEnabled: () => import.meta.env.DEV,
    getCanvas: () => document.getElementById('weCanvas') as HTMLCanvasElement | null,
    getOverlay: () => document.getElementById('weOverlay'),
    confirm: (msg: string) => window.confirm(msg),
    scheduleRedraw: (state) => { state.needsRedraw = true; },
  };
}

/** H115: F9 key + window-resize bindings for the editor. Dev-gated
 *  on import.meta.env.DEV — production builds never install these so
 *  store-cert reviewers and screenshot capture don't see the editor.
 *  The LIFE.devToolsEnabled gate the editor's index.ts header
 *  describes ports later when Options→Advanced lands.
 *
 *  H117 adds the canvas-level pan/zoom listeners + keyboard pan/zoom
 *  while the editor is active. All gated on worldEditor.active so the
 *  game-mode keyboard handler (W/A/S/D drive) keeps owning input when
 *  the editor is off. */
function installEditorBindings(deps: GameLoopDeps): void {
  if (!import.meta.env.DEV) return;
  const eDeps = editorDeps(deps);
  // H117: minimal InputDeps for input.ts — only the hooks pan/zoom
  // need are populated. Tool / draft / snap / angle-ref hooks land
  // when their modules port.
  // H118 draft-deps stub — the draft commit dispatcher needs merge
  // bonding + auto-driveway + rebuild hooks, none of which port yet.
  // The mergeBondEndpoints no-op returns the input verbatim so non-
  // merge roads commit cleanly; makeDriveway returns null so no
  // building auto-driveway fires; rebuildWorld is a no-op (modular
  // doesn't have a parallel rebuild yet).
  const dDeps = {
    mergeBondEndpoints: (pts: [number, number][]) => pts,
    makeDriveway: () => null,
    rebuildWorld: () => {},
  };
  const iDeps: EditorInputDeps = {
    getCanvas: () => document.getElementById('weCanvas') as HTMLCanvasElement | null,
    screenToTile: (sx, sy) => {
      const c = document.getElementById('weCanvas') as HTMLCanvasElement | null;
      const cs = c ? { w: c.width, h: c.height } : { w: window.innerWidth, h: window.innerHeight };
      return _weScreenToTile(sx, sy, deps.ctx.worldEditor, cs);
    },
    // H316: non-merge road snap (endpoint + segment passes). The merge
    // / lane-edge-stripe branch (v8.99.126.26) is the H317 follow-up;
    // until it lands, the modular wiring threads getRoadProfile/TILE/
    // rebuildWorld as no-op stubs since H316 doesn't call them.
    // RENDER_ENTRIES is the modular equivalent of monolith majorRoads;
    // the row format encodes width at row[0] and polyline points at
    // row[4..], so the adapter pairs them into {pts, w}.
    findSnap: (tx, ty) => {
      const sDeps: EditorSnapDeps = {
        getMajorRoads: () => RENDER_ENTRIES.map((e) => {
          const row = e.row;
          const pts: number[][] = [];
          for (let i = 4; i + 1 < row.length; i += 2) {
            pts.push([row[i] as number, row[i + 1] as number]);
          }
          return { pts, w: row[0] as number };
        }),
        getRoadProfile: () => null,
        TILE: 18,
        rebuildWorld: () => {},
      };
      return _weFindSnap(tx, ty, deps.ctx.worldEditor, sDeps);
    },
    // H315: river-to-river snap (v8.99.124.28). Reads state.rivers
    // directly — no extra adapter shim needed since the river row
    // format in modular state matches the monolith (`[w, name, x1, y1,
    // ...]`).
    findRiverSnap: (tx, ty) => _weFindRiverSnap(tx, ty, deps.ctx.worldEditor),
    beginDraft: (kind) => _weBeginDraft(deps.ctx.worldEditor, kind),
    commitDraft: () => _weCommitDraft(deps.ctx.worldEditor, dDeps),
    // H314: angle-ref pick consumes the next canvas tap to record the
    // signed tangent of the nearest road at click. RENDER_ENTRIES is
    // the modular equivalent of the monolith's runtime `majorRoads` —
    // adapted here into the {pts} shape angleRef.ts expects.
    detectAngleRefDirection: (tx, ty) =>
      _weDetectAngleRefDirection(tx, ty, {
        getRoads: (): AngleRefRoad[] => {
          const out: AngleRefRoad[] = [];
          for (const e of RENDER_ENTRIES) {
            const row = e.row;
            const pts: Array<[number, number]> = [];
            for (let i = 4; i + 1 < row.length; i += 2) {
              pts.push([row[i] as number, row[i + 1] as number]);
            }
            out.push({ pts });
          }
          return out;
        },
      }),
    currentRelativeAngleDeg: () => _weCurrentRelativeAngleDeg(deps.ctx.worldEditor),
    getAngleInputEl: () => document.getElementById('wePropAngle') as HTMLInputElement | null,
  };

  window.addEventListener('keydown', (e) => {
    if (e.key === 'F9') {
      e.preventDefault();
      _weToggle(deps.ctx.worldEditor, eDeps);
      return;
    }
    // H120: Ctrl+S (or Cmd+S on macOS) saves the editor's overlay to
    // localStorage. Only fires while the editor is active so it
    // doesn't conflict with browser Save Page in game mode. The save
    // is explicit-only — auto-save on every commit was rejected in
    // favor of "user controls when their work persists".
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && deps.ctx.worldEditor.active) {
      e.preventDefault();
      const we = deps.ctx.worldEditor;
      _weSaveOverlayToStorage(
        {
          roads:             we.overlay,
          surfaces:          we.surfaces,
          buildings:         we.buildings,
          rivers:            we.rivers,
          lakes:             we.lakes,
          roadProps:         we.overlayRoadProps ?? {},
          materialOverrides: we.overlayMaterialOverrides ?? {},
        },
        we,
      );
      // H121: also persist baseline-road vertex edits to the separate
      // WE_BASELINE_EDITS_KEY. Both saves happen on the same Ctrl+S so
      // the user has one "Save Map" interaction covering both layers.
      _weSaveBaselineEdits(we);
      // H127: live re-render — rebuild the game-side road list AND the
      // tile bitmap so the just-saved geometry takes effect this
      // session without a page reload. Without these calls, the user
      // would have to refresh to see the new roads in-game.
      rebuildRenderEntries();
      rebuildBaselineMap(deps.ctx.tileMap);
      // H128: also repaint the minimap from the freshly-rebuilt
      // RENDER_ENTRIES. Order matters — rebuildRenderEntries runs
      // first so the minimap reads current data.
      rebuildMinimap(deps.ctx.minimap);
      // H129: recompute road crossings from the post-rebuild entry
      // list. Traffic-light signals (H113 AI + H114 cones) read
      // ROAD_CROSSINGS each frame, so this refresh makes new
      // intersections immediately live — drawing two crossing roads
      // in the editor + Ctrl+S = traffic signal appears + traffic
      // brakes for it.
      rebuildRoadCrossings(RENDER_ENTRIES.map((e) => e.row));
      we.lastSaveAtMs = Date.now();
      we.needsRedraw = true;
      return;
    }
    if (e.key === 'Escape' && deps.ctx.worldEditor.active) {
      // H118: ESC cancels an active draft first; only exits the editor
      // when no draft is in flight. Matches CAD/GIS conventions where
      // ESC progressively backs out of nested modal states.
      if (deps.ctx.worldEditor.draft) {
        _weCancelDraft(deps.ctx.worldEditor);
      } else {
        _weExit(deps.ctx.worldEditor, eDeps);
      }
      return;
    }
    // H122: Delete / Backspace removes the selected baseline road or
    // (when the cursor is over one of its vertices) just that vertex.
    // Gated on no-active-draft so Delete during a road draft doesn't
    // unexpectedly nuke a baseline road the user previously selected.
    if (
      (e.key === 'Delete' || e.key === 'Backspace')
      && deps.ctx.worldEditor.active
      && !deps.ctx.worldEditor.draft
    ) {
      e.preventDefault();
      _weDeleteSelected(deps.ctx.worldEditor);
      return;
    }
    // H117: arrow-key pan + +/- zoom while editor active. Step size
    // is proportional to view zoom so a single key tap moves the
    // camera by ~10% of the visible window regardless of zoom level.
    if (!deps.ctx.worldEditor.active) return;
    const we = deps.ctx.worldEditor;
    const panStep = Math.max(2, 60 / we.view.zoom);
    if (e.key === 'ArrowLeft')        { we.view.cx -= panStep; we.needsRedraw = true; e.preventDefault(); }
    else if (e.key === 'ArrowRight')  { we.view.cx += panStep; we.needsRedraw = true; e.preventDefault(); }
    else if (e.key === 'ArrowUp')     { we.view.cy -= panStep; we.needsRedraw = true; e.preventDefault(); }
    else if (e.key === 'ArrowDown')   { we.view.cy += panStep; we.needsRedraw = true; e.preventDefault(); }
    else if (e.key === '=' || e.key === '+') {
      we.view.zoom = Math.min(ZOOM_MAX, we.view.zoom * WHEEL_ZOOM_FACTOR);
      we.needsRedraw = true;
      e.preventDefault();
    }
    else if (e.key === '-' || e.key === '_') {
      we.view.zoom = Math.max(ZOOM_MIN, we.view.zoom / WHEEL_ZOOM_FACTOR);
      we.needsRedraw = true;
      e.preventDefault();
    }
  });
  window.addEventListener('resize', () => {
    if (deps.ctx.worldEditor.active) {
      _weResizeCanvas(deps.ctx.worldEditor, eDeps);
    }
  });

  // H117: canvas-level mouse handlers. Bound to window so they fire
  // even when the cursor drifts off the overlay div. Each handler
  // bails early when the editor is inactive so game-mode mouse clicks
  // (e.g. car-select taps) don't get hijacked.
  window.addEventListener('mousedown', (e) => {
    if (!deps.ctx.worldEditor.active) return;
    _weCanvasMouseDown(e, deps.ctx.worldEditor, iDeps);
  });
  window.addEventListener('mousemove', (e) => {
    if (!deps.ctx.worldEditor.active) return;
    _weCanvasMouseMove(e, deps.ctx.worldEditor, iDeps);
  });
  window.addEventListener('mouseup', (e) => {
    if (!deps.ctx.worldEditor.active) return;
    _weCanvasMouseUp(e, deps.ctx.worldEditor);
  });
  window.addEventListener('wheel', (e) => {
    if (!deps.ctx.worldEditor.active) return;
    _weCanvasWheel(e, deps.ctx.worldEditor, iDeps);
  }, { passive: false });
  window.addEventListener('contextmenu', (e) => {
    if (!deps.ctx.worldEditor.active) return;
    _weCanvasContextMenu(e);
  });
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
  // H139 / H140: combine inputHeld (keyboard + touch) with gamepad
  // each frame so a controller release cleanly drops the effective
  // bit, and so the analog steering blend on the gamepad's left
  // stick gets a fresh dt. Runs before the state branch so any
  // future menu state that reads ctx.input also sees the merged
  // values.
  mergeInputs(deps.ctx, deps.ctx.frame.dt);
  const isPlaying = deps.ctx.gameState === 'playing';
  // H138: hide mobile controls when a gamepad is connected — 1:1 port
  // of monolith L51002 ("Hide mobile controls if gamepad connected
  // (cleaner screen)"). The isPlaying gate keeps menus quiet either
  // way; the gamepad gate keeps the steering wheel + pedals off-screen
  // for couch-play even in the playing state.
  setMobileControlsVisible(isPlaying && !deps.ctx.gamepad.connected);
  // H153: arcadeAudio's engine voice retired in H152; the
  // setEngineActive call here was a no-op and is removed. The
  // engine/audio proceduralEngine handles its own activation via
  // uiOpen gating inside updateAudio.
  switch (deps.ctx.gameState) {
    case 'title':
      tickTitleGamepad(deps);
      drawTitle(deps);
      return;
    case 'nameEntry':
      // DOM overlay handles its own painting + input (no monolith
      // canvas-gamepad path — name entry uses the DOM portrait/name
      // picker).
      return;
    case 'jobSelect':
      tickJobSelectGamepad(deps);
      drawJobs(deps);
      return;
    case 'carSelect':
      tickCarSelectGamepad(deps);
      drawCars(deps);
      return;
    case 'playing':
      drawPlaying(deps);
      return;
  }
}

/** Window-level keydown/keyup listeners. Mutates ctx.input directly.
 *  T key (key === 't' or 'T') saves + returns to title from any
 *  state — a developer convenience for testing flow without re-running
 *  the full start-flow chain. N key skips one in-game day (firing the
 *  monthly bill/pay cycle if it crosses a month boundary). */
function installKeyboard(deps: GameLoopDeps): void {
  const onDown = (e: KeyboardEvent): void => {
    // Bail if focus is on an input — same v8.99.124.32 rule the
    // monolith uses everywhere else for keyboard shortcuts.
    const ae = document.activeElement;
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || (ae as HTMLElement).isContentEditable)) return;

    // H192: Escape closes the pause menu. Checked before the T-key
    // exit so a "close menu" intent doesn't accidentally drop the
    // player back to title. Also gates input-reset so the player
    // doesn't coast on resume.
    if (e.key === 'Escape' && deps.ctx.menu.open) {
      deps.ctx.menu.open = false;
      resetInputState(deps.ctx);
      return;
    }
    if (e.key === 't' || e.key === 'T') {
      // Snapshot before exiting so LOAD GAME picks up where we left
      // off. Only saves from 'playing' — other states have nothing
      // meaningful to persist yet.
      if (deps.ctx.gameState === 'playing') saveGame(deps.ctx);
      deps.ctx.gameState = 'title';
      resetInputState(deps.ctx);
      return;
    }

    if ((e.key === 'h' || e.key === 'H') && deps.ctx.gameState === 'playing') {
      // H30: toggle home-screen overlay. Pauses input pass-through to
      // arcadeUpdate by zeroing held buttons so the player doesn't
      // coast across town while the menu is up.
      deps.ctx.home.open = !deps.ctx.home.open;
      if (deps.ctx.home.open) {
        resetInputState(deps.ctx);
        // H35: lazy-fill the newspaper on first open. H36 swapped the
        // one-shot generate for fillNewspaperListings — idempotent, so
        // an open mid-day after the auto-refresh still hits this path
        // as a no-op when the paper is already full.
        const life = deps.ctx.life;
        if (life) {
          fillNewspaperListings(life, deps.ctx.clock.day);
        }
      } else {
        // Reset to main tab on close so next open starts from the
        // tab picker.
        deps.ctx.home.tab = 'main';
      }
      return;
    }

    // H160: Ctrl+S exports the current save as a JSON download.
    // preventDefault swallows the browser's "Save Page As..." dialog
    // so the game's downloader fires alone. Edge-triggered so holding
    // Ctrl+S doesn't spam downloads. Only fires during 'playing' —
    // pre-life flow has no meaningful state to export.
    if (
      (e.key === 's' || e.key === 'S')
      && (e.ctrlKey || e.metaKey)
      && deps.ctx.gameState === 'playing'
      && !e.repeat
    ) {
      e.preventDefault();
      exportSaveToFile(deps.ctx);
      return;
    }

    // H178: F key toggles the full-screen city-map overlay. Edge-
    // triggered. Only fires during 'playing' state (no map overlay
    // on title / menus). F9 lower in this handler is the editor
    // toggle, not aliased — checking e.key directly so F doesn't
    // race against the editor binding installed by H115.
    if ((e.key === 'f' || e.key === 'F') && deps.ctx.gameState === 'playing' && !e.repeat) {
      deps.ctx.fullMapOpen = !deps.ctx.fullMapOpen;
      return;
    }

    // H154: X key toggles X-Ray body mode on the player. Edge-triggered
    // (skips auto-repeat). Requires an active LIFE — without one,
    // gameplaySettings hasn't been allocated yet (start-flow path).
    if ((e.key === 'x' || e.key === 'X') && deps.ctx.gameState === 'playing' && !e.repeat) {
      const life = deps.ctx.life;
      if (life) {
        const cur = life.gameplaySettings.xrayBody === true;
        life.gameplaySettings.xrayBody = !cur;
      }
      return;
    }

    if ((e.key === 'n' || e.key === 'N') && deps.ctx.gameState === 'playing') {
      // H24 dev: advance the clock by one in-game day. H237 routes
      // all day-rollover hooks through ctx.lastProcessedDay — the
      // per-frame block in drawPlaying catches the bump automatically
      // (monthly pay/bills, newspaper refresh, daily health update,
      // job + slot latch clears). This handler used to duplicate
      // those calls inline; the deduplication landed in H237.
      deps.ctx.clock.day++;
      // Reset timeOfDay to morning so the world lighting matches "next
      // day" rather than carrying the previous time. Reads more like
      // a sleep / fast-forward than a teleport mid-evening.
      deps.ctx.clock.timeOfDay = 7 / 24;
      return;
    }

    // H99: manual shift bump. 'e' = upshift, 'q' = downshift. Edge-
    // triggered (skip auto-repeat) so holding the key doesn't rapid-
    // fire shifts past the gear cap. Bumps player.manualGear ±1
    // clamped to [1, car.gears] and refreshes manualGearTimer to 4
    // seconds — tickGearAndRpm applies the override and ticks the
    // timer down each frame. Only fires in 'playing' state; cars
    // without an active LIFE entry (pre-life start-flow) are skipped.
    if (
      (e.key === 'e' || e.key === 'E' || e.key === 'q' || e.key === 'Q')
      && deps.ctx.gameState === 'playing'
      && !e.repeat
    ) {
      const carId = deps.ctx.life?.ownedCars[0];
      const car = carId ? CAR_CATALOG[carId] : undefined;
      if (car) {
        const up = e.key === 'e' || e.key === 'E';
        const cur = deps.ctx.player.manualGear ?? deps.ctx.player.prevGear;
        const next = Math.max(1, Math.min(car.gears, cur + (up ? 1 : -1)));
        deps.ctx.player.manualGear = next;
        deps.ctx.player.manualGearTimer = 4;
      }
      return;
    }

    setInputFromKey(deps.ctx.inputHeld, e.key, true);
  };
  const onUp = (e: KeyboardEvent): void => {
    setInputFromKey(deps.ctx.inputHeld, e.key, false);
  };
  window.addEventListener('keydown', onDown);
  window.addEventListener('keyup', onUp);
}

/** Browsers block AudioContext until a user gesture. Hook to first
 *  click / touchend / keydown anywhere, then remove the listeners so
 *  we don't keep re-unlocking. */
function installAudioUnlock(deps: GameLoopDeps): void {
  const unlock = (): void => {
    unlockAudio(deps.ctx.audio);
    // H151: also kick the engine/audio scaffold on the same gesture
    // so the V8 sampled gear loops (Muscle_Car_Gear*.wav) start
    // decoding alongside arcadeAudio. initAudio is idempotent — the
    // audioStarted flag short-circuits repeat calls. Runs every
    // gesture until both systems are up, then the listener clears.
    initEngineAudio();
    if (deps.ctx.audio.unlocked) {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('touchend', unlock);
      window.removeEventListener('keydown', unlock);
    }
  };
  window.addEventListener('pointerdown', unlock);
  window.addEventListener('touchend', unlock);
  window.addEventListener('keydown', unlock);
}

/** H139: clear both the held-state source (keyboard/touch) and the
 *  effective input. Used by the T-key state flush and the H-key
 *  home-overlay pause so a stuck button doesn't carry across the
 *  state transition. */
function resetInputState(ctx: GameContext): void {
  ctx.input.gas = false;
  ctx.input.brake = false;
  ctx.input.steerLeft = false;
  ctx.input.steerRight = false;
  ctx.input.ebrk = false;
  ctx.input.steerAxis = 0;
  ctx.inputHeld.gas = false;
  ctx.inputHeld.brake = false;
  ctx.inputHeld.steerLeft = false;
  ctx.inputHeld.steerRight = false;
  ctx.inputHeld.ebrk = false;
  ctx.inputHeld.steerAxis = 0;
}

/** H139: gamepad analog deadzones — 1:1 port of monolith L23806 (steer
 *  > 0.01) and L23851-23852 (gas/brake > 0.02). The keep-in-sync helper
 *  below ORs the inputHeld booleans with these deadzone-thresholded
 *  reads to produce the effective ctx.input field. */
const GP_STEER_DEADZONE_DRIVE = 0.01;
const GP_TRIGGER_DEADZONE = 0.02;

/** H140: analog steering smoothing exponent. Monolith L23808:
 *      gpSteerCurved = sign(gp.steer) * pow(|gp.steer|, 1.3)
 *  Powers above 1 give a softer center (more precision near the
 *  detent) and a faster fall-off near the rails. 1.3 is the value the
 *  monolith landed on after physics tuning. */
const GP_STEER_CURVE = 1.3;
/** H140: smoothing rate for the gamepad stick → steerAxis blend.
 *  Monolith L23809: `steerInput += (gpSteerCurved - steerInput) * 6 * dt`.
 *  At 60fps with dt = 1/60, 6 * dt = 0.1 so the axis closes ~10% of
 *  the gap each frame — under 0.1s to a new full lock. */
const GP_STEER_BLEND_RATE = 6;

/** H139 / H140: produce ctx.input from inputHeld + gamepad each frame.
 *  1:1 port of monolith L23801-23855:
 *    gas   = inputHeld.gas   || (gpConnected && gpGas   > 0.02)   [L23853]
 *    brake = inputHeld.brake || (gpConnected && gpBrake > 0.02)   [L23854]
 *    ebrk  = inputHeld.ebrk  || (gpConnected && (gpA || gpLB))    [L23855]
 *
 *    Steering (L23801-23815):
 *      kbSteer = (held.right ? 1 : 0) - (held.left ? 1 : 0)
 *      if (gpConnected && |gp.steer| > 0.01):
 *        curved   = sign(gp.steer) * pow(|gp.steer|, 1.3)
 *        steerAxis += (curved - steerAxis) * 6 * dt          [smoothed]
 *      else:
 *        steerAxis = kbSteer                                  [no smooth]
 *
 *    The boolean steerLeft / steerRight fields are kept in sync from the
 *    final steerAxis so any reader that hasn't migrated to analog still
 *    sees the right pressed/released semantics. */
function mergeInputs(ctx: GameContext, dt: number): void {
  const held = ctx.inputHeld;
  const gp = ctx.gamepad;
  const gpOn = gp.connected;

  ctx.input.gas   = held.gas   || (gpOn && gp.gas   > GP_TRIGGER_DEADZONE);
  ctx.input.brake = held.brake || (gpOn && gp.brake > GP_TRIGGER_DEADZONE);
  ctx.input.ebrk  = held.ebrk  || (gpOn && (gp.a || gp.lb));

  const kbSteer = (held.steerRight ? 1 : 0) - (held.steerLeft ? 1 : 0);
  if (gpOn && Math.abs(gp.steer) > GP_STEER_DEADZONE_DRIVE) {
    const curved = Math.sign(gp.steer) * Math.pow(Math.abs(gp.steer), GP_STEER_CURVE);
    ctx.input.steerAxis += (curved - ctx.input.steerAxis) * GP_STEER_BLEND_RATE * dt;
  } else {
    ctx.input.steerAxis = kbSteer;
  }
  // Keep boolean shadows in sync with steerAxis so legacy readers
  // (anything not yet ported to the analog field) still see a
  // consistent state. Threshold at 0.05 so a barely-twitched stick
  // doesn't latch the boolean.
  ctx.input.steerLeft  = ctx.input.steerAxis < -0.05;
  ctx.input.steerRight = ctx.input.steerAxis >  0.05;
}

function setInputFromKey(input: GameContext['input'], key: string, held: boolean): void {
  switch (key) {
    case 'ArrowUp':
    case 'w':
    case 'W':
      input.gas = held;
      return;
    case 'ArrowDown':
    case 's':
    case 'S':
      input.brake = held;
      return;
    case 'ArrowLeft':
    case 'a':
    case 'A':
      input.steerLeft = held;
      return;
    case 'ArrowRight':
    case 'd':
    case 'D':
      input.steerRight = held;
      return;
    case ' ':
      input.ebrk = held;
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

/** H137: shared title TitleScreenOpts builder. Used by drawTitle, the
 *  tap router, and the gamepad handler so all three see the same hover /
 *  confirmNewGame / hasSave snapshot each frame and the button geometry
 *  can't drift between paint and hit-test. */
function buildTitleOpts(deps: GameLoopDeps) {
  return {
    titleImg: deps.ctx.title.img,
    hover: deps.ctx.title.hover,
    confirmNewGame: deps.ctx.title.confirmNewGame,
    hasSave: !!localStorage.getItem(SAVE_STORAGE_KEY),
    GW: deps.hudCanvas.width,
    GH: deps.hudCanvas.height,
  };
}

function drawTitle(deps: GameLoopDeps): void {
  const { hctx } = deps;
  clearMainAndPaintHud(deps, () => {
    drawTitleScreen(hctx, buildTitleOpts(deps));
  });
}

/** H137: title-screen gamepad handler. 1:1 port of monolith L50941-50944:
 *      if (gpConnected) {
 *        if (gpPressed(0, gpA))    handleTitleClick(GW/2, GH_BASE*0.86); // Load
 *        if (gpPressed(9, gpStart)) handleTitleClick(GW/2, GH_BASE*0.73); // New
 *      }
 *  Title has no D-pad hover cycling — direct button-to-button mapping
 *  (the cycling pattern lives in jobSelect / carSelect / options).
 *  _titleClickRouterRef is populated once at boot by installClickRouter
 *  so the titleDeps closure (with its access to startNewGame /
 *  loadFromStorage etc.) is reachable from this per-frame call. */
let _titleClickRouterRef: TitleClickDeps | null = null;

function tickTitleGamepad(deps: GameLoopDeps): void {
  if (!deps.ctx.gamepad.connected) return;
  if (!_titleClickRouterRef) return;
  const opts = buildTitleOpts(deps);
  // L50942: A = Load (button index 0). Y position must match BTN_Y2_FRAC
  // (0.86) so titleBtnHit returns 1 (LOAD).
  if (gpPressed(0, deps.ctx.gamepad.a)) {
    handleTitleClick(opts.GW / 2, opts.GH * 0.86, opts, _titleClickRouterRef);
  }
  // L50943: Start = New (button index 9). Y position must match
  // BTN_Y1_FRAC (0.73) so titleBtnHit returns 0 (NEW).
  if (gpPressed(9, deps.ctx.gamepad.start)) {
    handleTitleClick(opts.GW / 2, opts.GH * 0.73, opts, _titleClickRouterRef);
  }
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

/** H138: jobSelect gamepad handler. 1:1 port of monolith L50958-50970:
 *      if (gpConnected) {
 *        if (gpPressed(12, gpDpadUp))   jobSelectScroll = max(0, scroll - 46);
 *        if (gpPressed(13, gpDpadDown)) jobSelectScroll += 46;
 *        if (gpPressed(0, gpA)) { // pick row closest to screen center
 *          for (i in 0..9)
 *            yy = JOB_LIST_TOP + i*50 - scroll + 23;
 *            d = abs(yy - GH_BASE/2);  track bestIdx ...
 *          handleJobSelectClick(GW/2, JOB_LIST_TOP + bestIdx*50 - scroll + 5);
 *        }
 *      }
 *  Scroll clamps to maxJobScroll (the screen module's helper) so D-pad
 *  down on the last row no-ops instead of letting the list drift off-
 *  screen.  _jobSelectDepsRef is populated once by installClickRouter
 *  (mirrors the H137 _titleClickRouterRef pattern). */
let _jobSelectDepsRef: JobSelectDeps | null = null;

function tickJobSelectGamepad(deps: GameLoopDeps): void {
  if (!deps.ctx.gamepad.connected) return;
  if (!_jobSelectDepsRef) return;
  const opts = buildJobSelectOpts(deps);
  if (gpPressed(12, deps.ctx.gamepad.dpadUp)) {
    deps.ctx.jobSelect.scrollY = Math.max(0, deps.ctx.jobSelect.scrollY - 46);
  }
  if (gpPressed(13, deps.ctx.gamepad.dpadDown)) {
    const maxY = maxJobScroll(opts.GH);
    deps.ctx.jobSelect.scrollY = Math.min(maxY, deps.ctx.jobSelect.scrollY + 46);
  }
  if (gpPressed(0, deps.ctx.gamepad.a)) {
    // 9 jobs hardcoded (mirrors monolith — JOB_NAMES length lives in
    // jobSelect.ts and isn't exported). rowH=50 + JOB_LIST_TOP=84 +
    // y-bias 23 from monolith L50967.
    const centerY = opts.GH / 2;
    const rowH = 50;
    const listTop = 84;
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < 9; i++) {
      const yy = listTop + i * rowH - opts.scrollY + 23;
      const d = Math.abs(yy - centerY);
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    }
    handleJobSelectClick(
      opts.GW / 2,
      listTop + bestIdx * rowH - opts.scrollY + 5,
      opts,
      _jobSelectDepsRef,
    );
  }
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

/** H138: carSelect gamepad handler. 1:1 port of monolith L50979-50996.
 *  Same shape as tickJobSelectGamepad but with cardH=70 + gap=6 from
 *  carSelect.ts (CAR_CARD_H + CAR_CARD_GAP) and choice count read
 *  dynamically from opts.choices.length instead of the monolith's
 *  LIFE._carSelect.choices. */
let _carSelectDepsRef: CarSelectDeps | null = null;

function tickCarSelectGamepad(deps: GameLoopDeps): void {
  if (!deps.ctx.gamepad.connected) return;
  if (!_carSelectDepsRef) return;
  if (!deps.ctx.carSelect.payload) return;
  const opts = buildCarSelectOpts(deps);
  if (gpPressed(12, deps.ctx.gamepad.dpadUp)) {
    deps.ctx.carSelect.scrollY = Math.max(0, deps.ctx.carSelect.scrollY - 40);
  }
  if (gpPressed(13, deps.ctx.gamepad.dpadDown)) {
    const maxY = maxCarScroll(opts.GH, opts.choices.length);
    deps.ctx.carSelect.scrollY = Math.min(maxY, deps.ctx.carSelect.scrollY + 40);
  }
  if (gpPressed(0, deps.ctx.gamepad.a)) {
    // CAR_LIST_TOP=100, CAR_CARD_H=70, gap=6 — kept inline to match
    // monolith L50985-50993 literally; the constants live in
    // carSelect.ts but aren't re-imported here on purpose (the values
    // belong to the layout, not this handler).
    const centerY = opts.GH / 2;
    const cardH = 70;
    const gap = 6;
    const listTop = 100;
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < opts.choices.length; i++) {
      const yy = listTop + i * (cardH + gap) - opts.scrollY + cardH / 2;
      const d = Math.abs(yy - centerY);
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    }
    handleCarSelectClick(
      opts.GW / 2,
      listTop + bestIdx * (cardH + gap) - opts.scrollY + cardH / 2,
      opts,
      _carSelectDepsRef,
    );
  }
}

function drawCars(deps: GameLoopDeps): void {
  const { hctx } = deps;
  clearMainAndPaintHud(deps, () => {
    drawCarSelect(hctx, buildCarSelectOpts(deps));
  });
}

/** First-playable 'playing' state. Updates arcade physics with the
 *  current input, paints the world (grass + baseline-road network as
 *  of H8), draws the player triangle, and overlays a small HUD with
 *  FPS + driver alias + speed. Real update + render + HUD pipelines
 *  replace this when their bodies port. */
/** H223: race-HUD button rect cache, written by drawRaceHud each
 *  frame + read by the onTap router. Module-level so the tap
 *  handler can read the latest layout without extra plumbing
 *  through GameContext. */
const _raceHudRects: RaceHudRects = {
  startCountdown: null,
  forfeit: null,
  dismiss: null,
};

/** H185: CAR_CATALOG → SellerOpts.getCar adapter. CatalogCar carries
 *  every field SellerOpts.CatalogLookup needs (color, hp, drv) except
 *  `origin`, which doesn't land in CatalogCar yet — the overlay's
 *  flag-emoji line falls through to no-flag in that case (mirrors
 *  monolith L49503's `||''` fallback). Module-level so the closure
 *  doesn't allocate per frame. */
const catalogLookupAdapter = (id: string): CatalogLookup | null => {
  const c = CAR_CATALOG[id];
  if (!c) return null;
  return { color: c.color, hp: c.hp, drv: c.drv };
};

function drawPlaying(deps: GameLoopDeps): void {
  const { mainCtx, hctx, mainCanvas, hudCanvas, ctx } = deps;
  const player = ctx.player;
  // Active car resolved up front so arcadeUpdate (H104 rev-limiter
  // cut) and downstream blocks (camera color / sprite / cluster /
  // gear+RPM tick) all read the same value. Falls through to
  // undefined in the pre-life start-flow path; consumers each
  // handle the missing-car case independently.
  const activeCarId = ctx.life?.ownedCars[0];
  const activeCar = activeCarId ? CAR_CATALOG[activeCarId] : undefined;

  // H248: per-frame fault-effect aggregation. Recomputed each frame
  // (faults rarely change mid-frame, but they DO change on the seller
  // purchase commit, on test-drive symptom diagnosis, and on impact
  // damage zone thresholds — all of which run mid-frame, so a cache
  // invalidator would have to track too many call sites). The
  // computeFaultEffects loop is O(n) over active faults — typically
  // 0-5 entries — so the per-frame allocation is negligible. The
  // ctx slot replaces what the monolith stores as the `_faultFX`
  // global at L43179. Pre-life frames + frames with empty
  // life.faults still set ctx.faultEffects so downstream readers
  // don't need a null check.
  ctx.faultEffects = computeFaultEffects(
    (ctx.life?.faults as readonly FaultLike[] | undefined) ?? [],
  );

  const onRoad = isOnRoad(ctx.tileMap, player.px, player.py);
  // H142: refresh player.layerZ each frame from the elevated-road
  // proximity test. Used downstream by tickTrafficCollisions to skip
  // collisions with traffic on a different z-level (don't hit a car
  // on I-485 from the ground; don't hit a ground-street car from
  // I-485). Mirrors monolith `playerZ` global at L23941, set inline
  // alongside the nearest-road cache.
  player.layerZ = playerLayerZAt(player.px, player.py);
  // H104: pass activeCar.redline so the rev-limiter acceleration cut
  // (monolith L24011) fires when pRpm sits at the limiter. Undefined
  // car → Infinity sentinel → cut disabled (Math comparison falls
  // through to multiplier=1).
  // H105: pass torqueMult from the active car's torque curve looked
  // up at last-frame pRpm. Cars without GT4 data get a flat 0.75
  // multiplier (getTorqueAtRPM's no-curve fallback, matching monolith
  // L6801). No-active-car path skips the lookup entirely (default 1).
  const _torqueMult = activeCar
    ? getTorqueAtRPM(activeCar.tcRPMs, activeCar.tcNorm, player.pRpm)
    : 1;
  // H106: gear-spread torque multiplier. 1:1 port of monolith L24014-
  // 24020:
  //   if (gears>0 && gearSpeeds[gears]>0 && gearSpeeds[pGear]>0):
  //     ratioSpread = gearSpeeds[gears] / gearSpeeds[pGear]
  //     gearMult    = 1.0 + (ratioSpread - 1) * 0.1
  //   else if (gears>0):
  //     gearMult = 1.0 + 0.6 * (1 - pGear/gears)
  // pGear comes from last-frame player.prevGear (16 ms lag below
  // perception). 1st gear in a 5-speed gets ratioSpread = 1/0.20 = 5
  // → gearMult = 1.4 (40% bonus); top gear is 1:1. Trucks with deep
  // first ratios (0.04) get much bigger bonuses (gearMult ≈ 3.4) —
  // matches the "semi launching loaded" feel the monolith documents.
  let _gearMult = 1;
  if (activeCar) {
    const _gs = activeCar.gearSpeeds;
    const _pg = player.prevGear;
    if (_gs[activeCar.gears] > 0 && _gs[_pg] > 0) {
      const ratioSpread = _gs[activeCar.gears] / _gs[_pg];
      _gearMult = 1.0 + (ratioSpread - 1) * 0.1;
    } else {
      _gearMult = 1.0 + 0.6 * (1 - _pg / activeCar.gears);
    }
  }
  arcadeUpdate(
    player,
    ctx.input,
    ctx.frame.dt,
    onRoad,
    activeCar?.redline ?? Infinity,
    _torqueMult,
    _gearMult,
    activeCar?.topSpeed ?? Infinity,
    activeCar?.engineBrake ?? 0,
    activeCar?.rollingFriction ?? 0,
    activeCar?.aeroFactor ?? 0,
    activeCar?.brakePower ?? undefined,
    // H248: fault-system acceleration multiplier from this frame's
    // aggregated effects. Always 1 when life.faults is empty (the
    // identity FaultEffects above), so no behavioral change for
    // fault-free play.
    ctx.faultEffects.accelMult,
    // H249: fault-system grip multiplier — scales turn authority.
    // Worn struts / bushings / tires / suspension all stack here.
    ctx.faultEffects.gripMult,
    // H250: fault-system brake multiplier. rotor_warp +
    // sport_brake_wear are the only contributors today.
    ctx.faultEffects.brakeMult,
    // H251: fault-system fuel multiplier. Six engine-side faults
    // push burn rate up; identity (1.0) for fault-free play.
    ctx.faultEffects.fuelMult,
    // H252: fault-system steer pull — signed yaw bias on top of
    // player steering input. alignment / control-arm / ball-joint
    // faults add here with per-fault stable ±1 direction.
    ctx.faultEffects.steerPull,
    // H254: ps_leak — heavy steering at low speed (lost power
    // assist). Scales turnInput down most at standstill, no effect
    // above ~60 wpx/s.
    ctx.faultEffects.steerSlow,
  );
  // H76: per-car odometer accumulation. 1:1 port of monolith L26314-
  // 26316 — distUnits = |pSpeed| * dt is the game-units distance
  // covered this frame. miles = raw * 0.0001278 (1 unit = 0.2056m).
  // The active car's carOdometers entry climbs whenever the car is
  // moving in either direction.
  {
    const _activeCarId = ctx.life?.ownedCars[0];
    if (ctx.life && _activeCarId) {
      const distUnits = Math.abs(player.pSpeed) * ctx.frame.dt;
      if (distUnits > 0) {
        const _odos = ctx.life.carOdometers ?? (ctx.life.carOdometers = {});
        _odos[_activeCarId] = (_odos[_activeCarId] ?? 0) + distUnits;
      }
      // H78: per-frame wear tick. 1:1 port of monolith L42029-42037,
      // BASE wear only — skips the pDrifting bonus (drift state not
      // modeled in arcadeUpdate) and the _faultFX.engineWearMult
      // multiplier (fault system not ported). H184 tightened the
      // guard to `spd>5 && !broken` now that LIFE.broken is on the
      // type (still dormant until the fault system ports, but the
      // gate is structurally correct). wearMult ramps: new car
      // (0mi)=1×, 100k=2×, 200k=3× — accelerates wear on used cars
      // so a high-mileage beater eats stats faster.
      const _spd = Math.abs(player.pSpeed);
      if (_spd > 5 && !ctx.life.broken) {
        const _odoMi = ((ctx.life.carOdometers?.[_activeCarId] ?? 0)) * 0.0001278;
        const _wearMult = 1 + _odoMi / 100000;
        const _dt = ctx.frame.dt;
        ctx.life.tires  = Math.max(0, ctx.life.tires  - 0.001  * _spd * _dt * _wearMult);
        ctx.life.engine = Math.max(0, ctx.life.engine - 0.0005 * _spd * _dt * _wearMult);
        ctx.life.paint  = Math.max(0, ctx.life.paint  - 0.0001 * _spd * _dt * _wearMult);
      }
    }
  }
  // H181: notification toast countdown. Mirrors the monolith's
  // lifeSimTick L42243 — `if(notifTimer>0)notifTimer--`. Only runs
  // when LIFE exists (toast is a LIFE-tied piece of state).
  if (ctx.life) tickNotif(ctx.life);

  // H182: home-entry hint. 1:1 port of monolith L42228-42234 — set
  // _homeHint true when the player is within ~44px of home and no
  // modal is up; clear otherwise. The flag drives the cyan ENTER HOME
  // button drawn in the HUD pass below.
  if (ctx.life) {
    tickHomeHint(ctx.life, player.px, player.py, ctx.home.open, ctx.fullMapOpen);
  }

  // H187: per-frame test-drive timer decrement + auto-end. Mirrors
  // monolith L49710-49734 (updateTestDrive). No-op unless
  // life.sellerVisit.phase === 'testdrive'. Runs before drawPlaying's
  // HUD pass so the bar reads the freshly-decremented value the same
  // frame, and before checkNearPin so the near-pin gate sees the
  // post-endTestDrive phase if the timer just expired.
  if (ctx.life && ctx.life.sellerVisit) {
    tickTestDrive(
      ctx.life,
      ctx.life.sellerVisit,
      player,
      ctx.frame.dt,
      (msg) => setNotifState(ctx.life!, msg),
    );
  }

  // H188: seller-arrival check. When sellerVisit.phase === 'driving'
  // and the player parks within 2 tiles of the marker, flip to
  // 'menu'. 1:1 port of monolith L49467-49476 (checkSellerArrival).
  // No-op for any non-'driving' phase.
  if (ctx.life?.sellerVisit) {
    checkSellerArrival(
      ctx.life.sellerVisit,
      player,
      {
        tilePx: TILE,
        showNotif: (msg) => setNotifState(ctx.life!, msg),
      },
    );
  }

  // H224/H225/H226: race tick. Countdown decrements per-second;
  // racing branch ticks opponent AI + finishline check; result
  // transition (one-shot per race) applies the payout / pink-slip
  // handover via applyRaceResult. The outcome is cached on
  // life._raceOutcome so the H226 result HUD can render the
  // won-car / lost-car names.
  if (ctx.life?.race) {
    const wasResult = ctx.life.race.phase === 'result';
    const msg = tickRace(
      ctx.life.race,
      ctx.frame.dt,
      player.px,
      player.py,
      WORLD_W,
      WORLD_H,
    );
    if (msg) setNotifState(ctx.life, msg);
    // First frame of 'result' — apply side effects exactly once.
    if (!wasResult && ctx.life.race.phase === 'result') {
      const outcome = applyRaceResult(ctx.life, ctx.clock.day);
      (ctx.life as { _raceOutcome?: typeof outcome })._raceOutcome = outcome;
    }
  }

  // H209: realtor-arrival check. Mirror of the seller-arrival
  // pattern — no-ops in steady state since the house-pin tap path
  // jumps straight to phase='menu'. Wired for symmetry + future
  // startRealtorVisit-style entries.
  if (ctx.life?.realtorVisit) {
    checkRealtorArrival(
      ctx.life.realtorVisit,
      player,
      {
        tilePx: TILE,
        showNotif: (msg) => setNotifState(ctx.life!, msg),
      },
    );
  }

  // H202: job-arrival check. Flips life.job.pickedUp at pickup,
  // adds pay to money + clears life.job + sets jobDoneToday at
  // delivery. 1:1 with monolith L42140-42211 mainline branch
  // (TOW / TRUCK / TANKER / OFFICE deferred — those need extra
  // state plumbing).
  if (ctx.life) {
    tickJobArrival(ctx.life, player, (msg) => setNotifState(ctx.life!, msg));
  }

  // H183: near-pin prompt. Refresh the module-level _nearPin cache
  // from LIFE.carPins. Gated to skip while any blocking modal is up
  // — mirrors the monolith's L34498 draw guards by short-circuiting
  // the recompute (drawNearPinPrompt also reads _nearPin so clearing
  // it here is sufficient). carPins is dormant until the pin-picker
  // ports, so this is effectively a no-op for now but lights up
  // automatically once pins can land in LIFE.
  // H185: also skip while sellerVisit is in menu/testdrive phase —
  // 1:1 restore of monolith L50406. The flag was dropped in H183
  // because sellerVisit wasn't typed yet; now it is.
  const _svActive = !!ctx.life?.sellerVisit && ctx.life.sellerVisit.phase !== 'driving';
  if (ctx.life && !ctx.home.open && !ctx.fullMapOpen && !_svActive) {
    checkNearPin(ctx.life.carPins, player.px, player.py, player.pSpeed);
  } else {
    checkNearPin(undefined, 0, 0, 0); // clear the cache
  }

  // H61: smooth camera angle toward player heading. Render reads
  // player.pCamAngle for the camera rotate; the car body itself
  // still reacts crisply via player.pAngle.
  tickCameraAngle(player, ctx.frame.dt);
  // H48: spawn skid marks on brake-at-speed or burnout-from-stop.
  // H50: pair with drift-smoke puffs at the same axle position so the
  // visual reads as "smoking the tires" rather than just streaks.
  const _nowMs = Date.now();
  const _skidBefore = ctx.skidMarks.marks.length;
  // H258: pass the active car's real footprint so skid marks spawn at
  // the actual rear-tire positions (the legacy 22×14 placeholder put
  // marks at ±7 lateral, well outside every GT4-derived chassis).
  spawnSkidMarksIfNeeded(ctx.skidMarks, player, ctx.input, onRoad, _nowMs, activeCar?.size);
  if (ctx.skidMarks.marks.length > _skidBefore) {
    // skidMarks pushes 2 entries per spawn (left + right rear tire).
    // Co-locate smoke at each new mark.
    const added = ctx.skidMarks.marks.slice(_skidBefore);
    for (const m of added) spawnDriftSmoke(ctx.particles, m.x, m.y);
  }
  // H55: off-road dust trail. Tires kick up dirt when driving off-
  // road above a threshold speed. Throttled to 25 Hz.
  if (!onRoad && player.pSpeed > 30 && _nowMs - ctx.skidMarks.lastDustMs > 40) {
    ctx.skidMarks.lastDustMs = _nowMs;
    // Rear-axle position, same math as the skid spawn.
    const axleX = -8;
    const halfTrack = 7;
    const cos = Math.cos(player.pAngle);
    const sin = Math.sin(player.pAngle);
    const baseX = player.px + cos * axleX;
    const baseY = player.py + sin * axleX;
    const pcos = -sin;
    const psin = cos;
    for (const side of [-1, 1] as const) {
      spawnOffRoadDust(
        ctx.particles,
        baseX + pcos * halfTrack * side,
        baseY + psin * halfTrack * side,
      );
    }
  }
  const refuelingAt = tickRefuel(player, ctx.frame.dt);
  // H29 refuel ding: fire once on the null → station edge. H153
  // routes through engine/audio.uiGain instead of arcadeAudio's
  // separate AudioContext. ctx.audio (ArcadeAudio struct) still
  // holds the edge-detect state until LIFE grows replacement fields.
  if (refuelingAt && !ctx.audio.wasRefuelingLast) {
    playRefuelDing();
  }
  ctx.audio.wasRefuelingLast = !!refuelingAt;
  // H29 low-fuel beep: throttled to every 2 seconds while fuel ∈
  // (0, 0.15). Runs out of fuel = silence (no point telling them).
  if (player.fuel > 0 && player.fuel < 0.15) {
    const now = Date.now();
    if (now - ctx.audio.lastLowFuelBeepAtMs > 2000) {
      playLowFuelBeep();
      ctx.audio.lastLowFuelBeepAtMs = now;
    }
  }
  tickClock(ctx.clock, ctx.frame.dt);
  // H237: persistent prevDay tracking via ctx.lastProcessedDay.
  // Catches day rollovers from ANY source — tickClock's natural
  // midnight crossing, doSleep's clock.day++, N-key dev skip.
  // Previously we used an in-frame `const prevDay = ctx.clock.day`
  // captured BEFORE tickClock, which silently missed all the
  // doSleep-bumped rollovers because the bump happened between
  // frames (after the previous frame's capture, before this
  // frame's). Now we compare against a sticky marker that only
  // updates after the hooks fire.
  const prevDay = ctx.lastProcessedDay;
  // H22 / H23: fire monthly pay THEN bills when day rolls over a
  // 30-day boundary. Pay-first so the salary sits in money when bills
  // draw it down.
  if (ctx.life && isMonthBoundary(prevDay, ctx.clock.day)) {
    fireMonthlyPay(ctx.life, ctx.clock.day);
    fireMonthlyBills(ctx.life, ctx.clock.day);
  }
  // H36: refresh the classifieds when the day rolls over via the real
  // clock tick (not just the dev N-key path).
  if (ctx.life && prevDay !== ctx.clock.day) {
    // H215: per-day health/fitness update fires BEFORE we clear
    // the daily latches — it reads ateToday / daysSinceEat /
    // slotsActiveToday / gymVisitedToday / daysSinceSleep before
    // they get reset. Mirrors monolith's lifeSimTick day-rollover
    // ordering (health-update before latch-clears at L42xxx).
    updateDailyHealth(ctx.life);
    fillNewspaperListings(ctx.life, ctx.clock.day);
    // H201: also clear yesterday's job state so the JOBS tab
    // re-rolls fresh on the new day. _jobListings and _availJobs
    // re-fill on next JOBS-tab entry (lazy-fill path from H200).
    // jobDoneToday + gymVisitedToday + ateToday are once-per-day
    // latches that need to flip off so the player can act today.
    ctx.life._jobListings = [];
    ctx.life._availJobs = [];
    ctx.life.jobDoneToday = false;
    ctx.life.gymVisitedToday = false;
    ctx.life.ateToday = false;
    // H214: also clear the time-slot used latches + reset to
    // morning so the new day starts cleanly. doSleep already does
    // this on its day-roll branch; this catches the case where
    // clock.day++ fires from elsewhere (real-clock tick at
    // midnight, dev N-key skip).
    ctx.life.slotsUsed = { morning: false, afternoon: false, night: false };
    ctx.life.timeSlot = 'morning';
    ctx.life.slotsActiveToday = 0;
  }
  // H237: update the sticky marker AFTER the hooks fire so the
  // next frame's comparison won't re-fire them. Also covers the
  // pre-life path (this whole block ran inside `if (ctx.life)` —
  // but the marker should advance regardless so pre-spawn ticks
  // don't accumulate a phantom "owe rollover" debt).
  ctx.lastProcessedDay = ctx.clock.day;
  // H166: compute per-road speed limit once per frame at the player's
  // current position (35 mph residential / 45 mph arterial / 55 mph
  // I-277 / 65 mph US-/I- / 70 mph I-85/I-485). Threaded into
  // tickTraffic so cop radar checks honor the actual road's limit
  // instead of the H164 global 100 wpx/s; HUD warning below reads
  // the same number for consistency.
  const speedLimitWpxNow = playerSpeedLimitWpx(player.px, player.py);
  // H110: pass player so traffic AI can brake when the player blocks
  // their forward cone (intersection waits, slow lead-up). Other
  // traffic cars are checked against each other inside tickTraffic.
  // H166: also pass the active speed limit so cops use the right
  // threshold for radar detection.
  tickTraffic(ctx.traffic, ctx.frame.dt, {
    px: player.px,
    py: player.py,
    pSpeed: player.pSpeed,
    speedLimit: speedLimitWpxNow,
  });
  // H168: ticket issuance. After tickTraffic updated all pursuit
  // state, walk cops one more time — any pursuing cop within
  // ~50 wpx of a slowed player (|pSpeed| < 60 wpx/s ≈ 27 mph) gets
  // to write a ticket. Fine = $150 base + $10/mph over the limit,
  // scaled by the clocked speed (captured when pursuit started, not
  // the now-slow speed). Ends pursuit immediately and locks the cop
  // to 60s cooldown so they don't instant-re-engage. Stamps the
  // amount + ms on LIFE so the HUD overlay below reads it for the
  // fade-out display.
  if (ctx.life) {
    const _lifeRef = ctx.life;
    const TICKET_RANGE_R2 = 50 * 50;
    const TICKET_SLOW_WPX = 60;
    for (const c of ctx.traffic) {
      if (!c.isCop || !c.isPursuing) continue;
      const dx = c.px - player.px;
      const dy = c.py - player.py;
      if (dx * dx + dy * dy < TICKET_RANGE_R2 && Math.abs(player.pSpeed) < TICKET_SLOW_WPX) {
        const mphOver = Math.max(0, (c.pursuitClockedSpeed - speedLimitWpxNow) / MPH_TO_WPX);
        const amount = Math.round(150 + mphOver * 10);
        _lifeRef.money = Math.max(0, _lifeRef.money - amount);
        _lifeRef._lastTicketAtMs = Date.now();
        _lifeRef._lastTicketAmount = amount;
        c.isPursuing = false;
        c.pursuitSlowTime = 0;
        c.pursuitCooldown = 60;
        c.pursuitClockedSpeed = 0;
        break; // one ticket per frame max — multi-cop pile-on feels griefy
      }
    }
  }
  const collision = tickTrafficCollisions(player, ctx.traffic);
  if (collision) {
    // H153: sample-backed crash (Crash_Hard-001..004.wav, picked at
    // random with playbackRate jitter inside playCrashSound). Severity
    // 0..1 maps directly to crash gain. Replaces arcadeAudio's
    // procedural noise-burst.
    playCrashSound(collision.impact);
    // H50: spark burst at the player position when we hit traffic.
    spawnCrashSparks(ctx.particles, player.px, player.py, collision.impact);
    // H229: gamepad rumble proportional to impact. Strong rumble
    // 0.4..0.9 (low motor) + weak rumble 0.3..0.7 (high motor)
    // scaled by impact 0..1. 250ms duration so the bump feels
    // like a thump rather than a buzz.
    playRumble(0.4 + 0.5 * collision.impact, 0.3 + 0.4 * collision.impact, 250);
  }

  // H229: rumble-strip detection. Light pulses at ~10 Hz when the
  // player drifts off the road line but the road is still a few
  // pixels away — like real highway rumble strips. Skips when
  // parked-ish (low pSpeed). Uses Date.now() for the cadence
  // clock so the pulses fire at wall-clock rate regardless of
  // frame variation.
  tickRumbleStrip(ctx.tileMap, player.px, player.py, player.pSpeed, Date.now());
  // H50: tick particle ages + drift toward the visible viewport.
  updateParticles(ctx.particles, ctx.frame.dt);
  // H56: tick the Akira taillight trail — push a point if above
  // threshold, shift off otherwise.
  tickSpeedTrail(ctx.speedTrail, player, ctx.input.brake);
  // H87: engine pitch is wired to player.pRpm further down, after the
  // pRpm integrator has stepped this frame's value. See setEngineSpeed
  // call near the gauge cluster setup.

  // World pass: solid grass + baseline road network.
  // H135: reverted H60's ZOOM 3.0 hack now that main.ts sizes the main
  // canvas at GBC-aspect internal (GH ~500-640) with CSS upscale to
  // vw × vh*tiltMul (monolith resize() parity). At the correct internal
  // size the monolith's stock ZOOM 2.2 lands the car at the on-screen
  // size shown in driver_city_charlotte_v8_99_126_89.html.
  // Mobile (portrait) uses the monolith's static-speed mobile ZOOM 2.9.
  const _isLandscape = window.innerWidth >= window.innerHeight;
  const ZOOM = _isLandscape ? 2.2 : 2.9;
  // H135: derive CAM_Y_RATIO via the inverse-perspective adjustment so
  // the player anchor lands at viewport-y = vh*0.58 AFTER the CSS
  // perspective+rotateX fold (the monolith's screen target). Without
  // this, raw `0.58 * mainCanvas.height` lands the car at ~50% of the
  // viewport instead of ~58% because the tilted canvas's bottom-anchored
  // origin biases the projection. Mirrors monolith render() L29907-29950.
  const _vw = window.innerWidth;
  const _vh = window.innerHeight;
  let CAM_Y_RATIO = 0.58;
  if (tiltState.mode !== 0) {
    CAM_Y_RATIO = camYRatioForTilt(
      CAM_Y_RATIO,
      effectiveTiltDeg(_vh, _vw),
      TILT_PERSPECTIVE_PX,
      { vw: _vw, vh: _vh, GH: mainCanvas.height },
      CANVAS_OVERSCAN,
    );
  }
  mainCtx.setTransform(1, 0, 0, 1, 0, 0);
  mainCtx.fillStyle = '#1a2818';
  mainCtx.fillRect(0, 0, mainCanvas.width, mainCanvas.height);

  const night = nightIntensity(ctx.clock.timeOfDay);
  // H253: fault-system night-vision multiplier. alternator (0.5),
  // battery_drain (0.6), and electrical_gremlin (0.6) dim the
  // player's perception of the world at night. Only the player's
  // OWN systems are dimmed (headlight cone + streetlight ambient
  // glow — both representing "what the player sees lit up"),
  // matching the monolith's _nvm punch at L32898-99 which dimmed
  // the destination-out brightness contribution from street-light
  // pools. Traffic signals + other vehicles' headlights stay at
  // full intensity — those are external electrical systems
  // unaffected by the player's bad alternator.
  const nightVis = night * ctx.faultEffects.nightVisMult;

  mainCtx.save();
  // Camera composite: place player at (W/2, H*ratio) on screen, scale
  // by ZOOM, rotate so heading-up = screen-up, then move player to
  // origin. The world is drawn in world coords; this transform handles
  // the projection.
  mainCtx.translate(mainCanvas.width / 2, mainCanvas.height * CAM_Y_RATIO);
  mainCtx.scale(ZOOM, ZOOM);
  // H61: camera reads the SMOOTHED angle. Player body / headlights /
  // tails all still use player.pAngle so the car points crisp; only
  // the world rotation lags by ~6 frames.
  mainCtx.rotate(-player.pCamAngle - Math.PI / 2);
  mainCtx.translate(-player.px, -player.py);

  // Tile culling — visible region after rotate/scale is at most a
  // square of side canvasH / ZOOM centered on the player. H135 restored
  // the 0.75 padding multiplier (monolith default) now that ZOOM is back
  // to 2.2 — the canvas is small (GBC-aspect, ~640×500 internal) so the
  // tile-pass count stays modest even with the larger factor, and the
  // tighter 0.55 from H60 was a perf hack that no longer applies.
  const cullRadius = Math.ceil((Math.max(mainCanvas.width, mainCanvas.height) / ZOOM) * 0.75);

  // H46: grass variants tile pass — paint non-city tiles with 8
  // pre-baked GBC-aesthetic variants (standard / dry / lush / dirt /
  // clay / rocks / flowers / tall). Runs BEFORE buildings so the
  // suburban edge of I-277 paints grass under any building tiles that
  // happen to overlap during classification.
  drawGrass(mainCtx, ctx.tileMap, player.px, player.py, cullRadius);
  // H41: buildings tile pass — paint city blocks before the road
  // overlay so roads/lane stripes sit on top of the buildings (matches
  // monolith z-order).
  drawBuildings(mainCtx, ctx.tileMap, player.px, player.py, cullRadius);
  drawBaselineRoads(mainCtx, player.px, player.py, cullRadius);
  // H282 (replaces the reverted H277 whole-intersection overpaint):
  // tee-junction edge-stripe erase is now part of drawBaselineRoads's
  // marking pass. Each road's solid white fog line gaps over every
  // side-street's pavement at T-junctions using the per-stripe
  // _teeEdgeErasePaths geometry (monolith L31378-L31405) — the
  // approach the H280 comment said to re-introduce "when that lands."
  // H57: crosswalk zebra stripes at intersections. Paints over the
  // road surface but under skid marks / traffic / player. H288 skips
  // bridge overlaps (z>1 on either road) so no zebra paints mid-air.
  drawCrosswalks(mainCtx, player.px, player.py);
  // H114: traffic-signal light cones at each intersection. Green /
  // yellow / red colored cones project from each crossing along
  // both approach axes (4 cones per crossing). Paints over crosswalks
  // and under skid marks so the signal wash colors the pavement but
  // tire marks still read on top. Alpha scales with nightIntensity
  // so daytime is subtle, midnight is vivid.
  drawTrafficSignals(mainCtx, ROAD_CROSSINGS, player.px, player.py, night);
  // H48: tire marks paint on top of roads but under traffic + player.
  drawSkidMarks(mainCtx, ctx.skidMarks, player.px, player.py, cullRadius);
  // H49: highway signs + interstate shields. Drawn over the road
  // surface so the green plaques and blue shields read clearly.
  drawExitSigns(mainCtx, player.px, player.py);
  drawInterstateShields(mainCtx, player.px, player.py);
  // H50: smoke + sparks ride above road furniture but under traffic.
  drawParticles(mainCtx, ctx.particles, player.px, player.py, cullRadius);
  // H51: streetlight glow — only paints at dusk/night (night > 0).
  // Below traffic so cars drive through the glow, not under it.
  // H253: nightVis (= night * faultEffects.nightVisMult) so a weak
  // alternator dims the perceived city lighting.
  drawStreetlights(mainCtx, player.px, player.py, nightVis);
  drawGasStations(mainCtx);
  // H204: in-world navigation markers — home disc + per-pin car
  // silhouettes with color-coded label discs floating above. Same
  // render layer as the H203 job markers; home paints first so its
  // disc sits behind any A/B markers that happen to overlap.
  // Painted before headlights so the player car renders over the
  // marker discs when standing on them.
  if (ctx.life) {
    drawHomeMarker(mainCtx, ctx.life, player.px, player.py);
    drawCarPinsWorld(mainCtx, ctx.life, player.px, player.py);
  }
  // H203: in-world A (pickup) / B (delivery) markers for the active
  // job. Painted AFTER the home/pin markers so a job destination
  // marker draws on top when it happens to land near home.
  if (ctx.life) drawJobMarkers(mainCtx, ctx.life, player.px, player.py);
  // Headlights drawn under the car body. The cone gets darkened by
  // the day/night tint along with the rest of the world; the gradient
  // is bright enough that even after a 55% alpha night overlay, the
  // cone reads as illumination.
  // H145: traffic cars in front of the player cast shadows into the
  // headlight cone. Passing ctx.traffic lets drawHeadlights clip to
  // the cone and darken polygons extending away from the apex past
  // each occluder. No-op during daytime since intensity gates the
  // whole pass.
  // H253: player's own cone scaled by nightVis so a weak alternator
  // produces a visibly dimmer headlight beam.
  // H258: pass the active car's HALF-length so the headlight cone apex
  // lands at the actual front bumper. Without this, the cone started at
  // the placeholder CAR_LEN=22 offset (i.e., 22 units forward from the
  // player center — well past the nose of any GT4-derived chassis).
  // Falls through to CAR_LEN/2 when activeCar is null (pre-life flow).
  const _carHalfLen = (activeCar?.size[0] ?? 22) / 2;
  // H260: thread half-width + isBike so the headlight pass emits two
  // amber cones offset to the lamp positions (not one cone at center).
  const _carHalfW = (activeCar?.size[1] ?? 8) / 2;
  const _carIsBike = activeCar?.isBike ?? false;
  drawHeadlights(mainCtx, player, nightVis, ctx.traffic, _carHalfLen, _carHalfW, _carIsBike);
  // H53/H242: traffic NPC headlight cones at night — GROUND pass.
  // Elevated traffic paints AFTER drawBridgeOverlays so the bridge
  // concrete doesn't cover them. 1:1 with the monolith's z-pass
  // render at L29957+ where elevated and ground layers interleave.
  drawTrafficHeadlights(mainCtx, ctx.traffic, player.px, player.py, night, 'ground');
  // H98: pass night so traffic gets warm-white bulb pixels at the
  // front corners of each car when dark — visible source for the
  // H53 headlight cones (the cones rendered above sit under each
  // car, but the cone's apex point was previously over dark sprite
  // pixels; the bulbs give it a lit-up source).
  drawTraffic(mainCtx, ctx.traffic, night, 'ground');
  // H54: tail-light pixels on top of each traffic sprite.
  drawTrafficTailLights(mainCtx, ctx.traffic, player.px, player.py, night, 'ground');
  // H26: resolve the active car's body color from CAR_CATALOG.
  // H27: also resolve a sprite PNG from the catalog's car name —
  // drawPlayerCar uses the sprite when available + loaded, else
  // falls back to the silhouette colored by playerColor.
  // ownedCars[0] is the spawn car; falls back to default if undefined.
  // (activeCar / activeCarId already resolved at the top of drawPlaying
  // for the H104 rev-limiter cut; same values used here.)
  const playerColor = activeCar?.color;
  const playerSprite = spriteForCarName(activeCar?.name);
  // H92: rear-lamp gate reads the real pRevIntent flag — matches
  // monolith L41007 (`_revV2 = isPlayer && pRevIntent`). Replaces the
  // H90 pSpeed<-0.5 threshold proxy; flag is set/cleared by arcadeUpdate
  // at the 5 monolith transition points.
  // H93: brake-lamp gate exclude reverse-engagement. The arcade control
  // scheme overloads the brake button as the reverse "pedal" (H89), so
  // a player holding brake to back up was firing the red brake lamps
  // alongside the white reverse lamps. Real cars use a separate gas
  // pedal for reverse motion, so the brake bulb never lights while
  // intentionally reversing. Effective braking = brake input AND not
  // in reverse-intent — fires only when brake is genuinely slowing
  // forward motion (or holding the car at a stop).
  const _braking = ctx.input.brake && !player.pRevIntent;
  // H143: bridge concrete deck is now a separate render pass that
  // sequences relative to the player. When the player is on the
  // elevated road (layerZ >= 2), paint the concrete FIRST so the
  // player car sits on top of the deck. When the player is on the
  // ground / off-road (layerZ < 2), defer the concrete until AFTER
  // the player draw so the player visually slides UNDER the bridge.
  // Mirrors the monolith's z-pass render at L29957+ where elevated
  // and ground layers paint in interleaved order.
  if (player.layerZ >= 2) {
    drawBridgeOverlays(mainCtx, player.px, player.py, cullRadius);
  }
  // H146/H148: V2 carBody dispatcher with PNG-then-vector-then-X-Ray
  // fallback. H149 threads `night` through so paintTailLights can
  // re-add the H94/H95/H96 bloom + reverse-halo + running-light
  // brighten on top of whichever body branch rendered. H154 reads
  // the LIFE.gameplaySettings.xrayBody toggle so the X key flip
  // forces the X-Ray branch regardless of sprite availability.
  const _xrayBody = !!ctx.life?.gameplaySettings?.xrayBody;
  drawPlayerCarV2(mainCtx, player, activeCar ?? null, _braking, player.pRevIntent, night, _xrayBody);
  // Suppress unused-import warnings on the legacy placeholder + sprite
  // resolver — they remain reachable for the carSelect preview and
  // any port that wants the H6 silhouette back. Removal lands when
  // the V2 path is the only consumer.
  void drawPlayerCar; void playerColor; void playerSprite;
  if (player.layerZ < 2) {
    // Player driving below — bridge paints over the player car so the
    // car visually disappears under the overpass.
    drawBridgeOverlays(mainCtx, player.px, player.py, cullRadius);
  }
  // H242: ELEVATED traffic pass — paints AFTER drawBridgeOverlays so
  // I-485 / I-77 / I-85 traffic appears ON TOP of the bridge concrete
  // when the player is on the ground (which is the only time the
  // bridge concrete is between them visually). When player is also
  // on the bridge (layerZ >= 2) it stacks alongside in the natural
  // single-layer way. Matches the monolith's interleaved z-pass at
  // L29957+.
  drawTrafficHeadlights(mainCtx, ctx.traffic, player.px, player.py, night, 'elevated');
  drawTraffic(mainCtx, ctx.traffic, night, 'elevated');
  drawTrafficTailLights(mainCtx, ctx.traffic, player.px, player.py, night, 'elevated');
  // H56: Akira taillight trail — paints on top of player so the
  // newest segment connects to the brake-light bloom.
  drawSpeedTrail(mainCtx, ctx.speedTrail, night);
  mainCtx.restore();

  // Day/night tint as a final composite over the world. The HUD
  // canvas is separate, so HUD text reads at full brightness.
  applyDayNightTint(mainCtx, ctx.clock.timeOfDay, mainCanvas.width, mainCanvas.height);

  // HUD overlay.
  hctx.setTransform(1, 0, 0, 1, 0, 0);
  hctx.clearRect(0, 0, hudCanvas.width, hudCanvas.height);
  hctx.fillStyle = '#0ff';
  hctx.font = 'bold 12px monospace';
  hctx.textAlign = 'left';
  const life = ctx.life;
  const alias = life?.playerAlias ?? ctx.character?.playerAlias ?? '—';
  const job = life?.playerJob ?? ctx.playerJob ?? '—';
  hctx.fillText(`${alias} • ${job}`, 12, 22);
  hctx.fillStyle = '#fff';
  hctx.font = '11px monospace';
  // H64: analog speedometer now owns the speed readout; the HUD
  // header keeps just FPS + day/time.
  hctx.fillText(`${ctx.frame.fpsDisplay} FPS   Day ${ctx.clock.day} ${formatClockTime(ctx.clock)}`, 12, 38);
  // H155: keybind hint strip in the top-right corner. Dim so it
  // doesn't compete with active HUD elements; always visible during
  // 'playing' so the user doesn't have to read source to discover
  // the keys. Two lines because one line wraps at narrow viewport
  // widths. setTextAlign restored to 'left' afterward so subsequent
  // HUD passes (money, loans, month-rollover receipt) keep their
  // anchor.
  {
    hctx.fillStyle = 'rgba(200,200,200,0.55)';
    hctx.font = '10px monospace';
    hctx.textAlign = 'right';
    const rx = hudCanvas.width - 12;
    hctx.fillText('W/A/S/D drive · Q/E shift · SPACE e-brake', rx, 22);
    hctx.fillText('H home · F map · N day · X X-Ray · T title · Ctrl+S export · F9 editor', rx, 36);
    hctx.textAlign = 'left';
  }
  // H21: real LIFE.money on screen + active car name + loan count.
  if (life) {
    hctx.fillStyle = life.money < 0 ? '#f44' : '#0f0';
    hctx.font = 'bold 11px monospace';
    hctx.fillText(`$${life.money.toLocaleString()}`, 12, hudCanvas.height - 28);
    if (life.carLoans.length > 0) {
      const totalMo = life.carLoans.reduce((s, l) => s + (l.monthlyPayment || 0), 0);
      hctx.fillStyle = '#fa0';
      hctx.font = '10px monospace';
      hctx.fillText(`${life.carLoans.length} loan${life.carLoans.length > 1 ? 's' : ''} • $${totalMo}/mo`, 80, hudCanvas.height - 28);
    }
    // H22 / H23: brief month-rollover receipt for 5 seconds after
    // the tick — combines pay and bills into one fading line.
    const lastBillsAt = (life._lastBillsAtMs as number | undefined) || 0;
    const lastPayAt = (life._lastPayAtMs as number | undefined) || 0;
    const lastAt = Math.max(lastBillsAt, lastPayAt);
    if (lastAt > 0) {
      const ageMs = Date.now() - lastAt;
      if (ageMs < 5000) {
        const fade = 1 - ageMs / 5000;
        const month = (life._lastBillsMonth as number | undefined) || (life._lastPayMonth as number | undefined) || 0;
        const pay = (life._lastPayTotal as number | undefined) || 0;
        const bills = (life._lastBillsTotal as number | undefined) || 0;
        const net = pay - bills;
        const netColor = net >= 0 ? '#7fff5a' : '#ff6644';
        hctx.font = 'bold 11px monospace';
        hctx.textAlign = 'left';
        hctx.fillStyle = `rgba(127, 255, 90, ${fade})`;
        hctx.fillText(`MONTH ${month}:  +$${pay.toLocaleString()}`, 12, hudCanvas.height - 60);
        hctx.fillStyle = `rgba(255, 102, 68, ${fade})`;
        hctx.fillText(`           -$${bills.toLocaleString()}`, 12, hudCanvas.height - 48);
        hctx.fillStyle = `rgba(${netColor === '#7fff5a' ? '127, 255, 90' : '255, 102, 68'}, ${fade})`;
        hctx.fillText(`         = ${net >= 0 ? '+' : ''}$${net.toLocaleString()}`, 12, hudCanvas.height - 36);
      }
    }
    if ((life.missedPayments || 0) > 0) {
      hctx.fillStyle = '#f66';
      hctx.font = '10px monospace';
      hctx.fillText(`${life.missedPayments} missed`, 200, hudCanvas.height - 28);
    }
  }
  hctx.fillStyle = onRoad ? '#0f0' : '#f80';
  hctx.font = '10px monospace';
  hctx.fillText(onRoad ? 'ON ROAD' : 'OFF ROAD — 50% cap', 12, 54);

  // H175: highway shield + road name plate. 1:1 port of monolith
  // L33881-33901 — Interstate routes get the blue-with-red-stripe
  // shield (US Interstate badge shape: hexagonal-ish with rounded
  // top), US- routes get the white square with black number, named
  // arterials (Brookshire / Independence) and other major roads
  // get a simple white name tag. Off-road shows nothing.
  {
    const _road = playerRoadInfoAt(player.px, player.py);
    if (_road) {
      const isInterstate = _road.name.startsWith('I-');
      const isUS = _road.name.startsWith('US-');
      const shX = 90;
      const shY = 44;
      if (isInterstate) {
        // Blue shield body — heptagonal-ish outline approximating the
        // US Interstate Highway shield. Red top band with the number
        // in white below. Monolith path at L33887.
        hctx.fillStyle = '#00c';
        hctx.beginPath();
        hctx.moveTo(shX,     shY + 1);
        hctx.lineTo(shX + 10, shY + 1);
        hctx.lineTo(shX + 11, shY + 3);
        hctx.lineTo(shX + 9,  shY + 10);
        hctx.lineTo(shX + 5,  shY + 12);
        hctx.lineTo(shX + 1,  shY + 10);
        hctx.lineTo(shX - 1,  shY + 3);
        hctx.closePath();
        hctx.fill();
        hctx.fillStyle = '#c00';
        hctx.fillRect(shX + 1, shY + 1, 9, 3);
        hctx.fillStyle = '#fff';
        hctx.font = 'bold 5px monospace';
        hctx.textAlign = 'center';
        hctx.fillText(_road.name.replace('I-', '').replace(/\s+[NS]$/, ''), shX + 5, shY + 9);
      } else if (isUS) {
        hctx.fillStyle = '#fff';
        hctx.fillRect(shX, shY + 1, 12, 10);
        hctx.fillStyle = '#000';
        hctx.font = 'bold 5px monospace';
        hctx.textAlign = 'center';
        hctx.fillText(_road.name.replace('US-', ''), shX + 6, shY + 8);
      }
      // Road name to the right of the shield (or alone for named
      // arterials with no shield). Truncated to keep the row tidy.
      const _nm = _road.name.length > 18 ? _road.name.slice(0, 17) + '…' : _road.name;
      hctx.fillStyle = '#fff';
      hctx.font = 'bold 9px monospace';
      hctx.textAlign = 'left';
      hctx.fillText(_nm, (isInterstate || isUS) ? shX + 14 : shX, 54);
    }
  }

  // H167: speed-limit readout. Reads the per-road limit
  // (speedLimitWpxNow from H166) and the active car's RHD flag for
  // unit choice. Colored by overage tier so the player can see at a
  // glance whether they're legal / tolerant / speeding:
  //   green:  under limit
  //   orange: over limit but within +10 tolerance (no radar trigger)
  //   red:    over +10 — radar fires when a cop is in range
  // Active car may be undefined during the start-flow before LIFE
  // is built — fall back to mph in that case (default U.S. unit).
  {
    const _limitWpx = speedLimitWpxNow;
    const _absWpx = Math.abs(player.pSpeed);
    const _useKm = activeCar?.rhd === true;
    const _factor = _useKm ? (3.6 / 4.864) : (1 / MPH_TO_WPX);
    const _limitN = Math.round(_limitWpx * _factor);
    const _curN = Math.round(_absWpx * _factor);
    let _color = '#0f0';
    if (_absWpx > _limitWpx + 10) _color = '#f44';
    else if (_absWpx > _limitWpx) _color = '#fa0';
    hctx.fillStyle = _color;
    hctx.font = 'bold 10px monospace';
    hctx.fillText(`LIMIT ${_limitN} ${_useKm ? 'KM/H' : 'MPH'}`, 170, 54);
    // Player's current speed in the same units to the right — handy
    // for the player to compare against the limit without reading
    // the analog gauge.
    hctx.fillStyle = '#aaa';
    hctx.font = '10px monospace';
    hctx.fillText(`(now ${_curN})`, 280, 54);
  }

  // H164/H165/H166: cop alert tier. Same per-road limit + 10 wpx/s
  // tolerance the tickTraffic radar uses (computed once per frame
  // above via playerSpeedLimitWpx).
  //   tier 2 — any cop.isPursuing            → "🚨 PURSUIT — LOSE THEM"
  //   tier 1 — speeding + cop in radar range → "⚠ COP DETECTED"
  //   tier 0 — silent
  // Pulse alpha ~2Hz on both so they read as URGENT without strobing.
  const COP_RADAR_R2 = 250 * 250;
  const _radarLimit = speedLimitWpxNow + 10;
  let _pursuing = false;
  let _radarHit = false;
  for (const c of ctx.traffic) {
    if (!c.isCop) continue;
    if (c.isPursuing) { _pursuing = true; break; }
    const dx = c.px - player.px;
    const dy = c.py - player.py;
    if (Math.abs(player.pSpeed) > _radarLimit && dx * dx + dy * dy < COP_RADAR_R2) {
      _radarHit = true;
    }
  }
  if (_pursuing || _radarHit) {
    const _pulse = 0.6 + 0.4 * Math.abs(Math.sin(Date.now() * 0.006));
    hctx.fillStyle = _pursuing
      ? `rgba(255, 30, 30, ${_pulse})`
      : `rgba(255, 140, 80, ${_pulse})`;
    hctx.font = 'bold 14px monospace';
    hctx.textAlign = 'center';
    hctx.fillText(
      _pursuing ? '🚨 PURSUIT — LOSE THEM' : '⚠ COP DETECTED — SLOW DOWN',
      hudCanvas.width / 2,
      90,
    );
    hctx.textAlign = 'left';
  }

  // H168: ticket fade-in/out overlay. After a cop writes a ticket
  // life._lastTicketAtMs + life._lastTicketAmount get stamped; we
  // draw the receipt for 3 seconds with a 500ms fade-in / 500ms
  // fade-out so it doesn't snap on and off. Yellow-on-black plate
  // with a citation icon — reads as official, not as the urgent
  // red pursuit warning the same area was just showing.
  if (life) {
    const _ticketAt = (life._lastTicketAtMs as number | undefined) ?? 0;
    if (_ticketAt > 0) {
      const _ageMs = Date.now() - _ticketAt;
      if (_ageMs < 3000) {
        let _alpha = 1;
        if (_ageMs < 500) _alpha = _ageMs / 500;
        else if (_ageMs > 2500) _alpha = (3000 - _ageMs) / 500;
        const _amount = (life._lastTicketAmount as number | undefined) ?? 0;
        const _x = hudCanvas.width / 2;
        const _y = 110;
        hctx.fillStyle = `rgba(0, 0, 0, ${0.75 * _alpha})`;
        hctx.fillRect(_x - 140, _y - 18, 280, 28);
        hctx.strokeStyle = `rgba(255, 220, 0, ${_alpha})`;
        hctx.lineWidth = 2;
        hctx.strokeRect(_x - 140, _y - 18, 280, 28);
        hctx.fillStyle = `rgba(255, 220, 0, ${_alpha})`;
        hctx.font = 'bold 14px monospace';
        hctx.textAlign = 'center';
        hctx.fillText(`🚔 TICKET — $${_amount.toLocaleString()}`, _x, _y);
        hctx.textAlign = 'left';
      }
    }
  }

  // H91: REVERSE indicator. 1:1 port of monolith L34367-34373.
  // H92: gate switched from pSpeed<-0.5 to player.pRevIntent — matches
  // the monolith verbatim (L34367 `if(pRevIntent)`). Centered at 44%
  // canvas height matches the monolith's `GH*0.44` placement so the
  // label sits below the speedometer and above the gear pill area.
  if (player.pRevIntent) {
    hctx.fillStyle = '#f44';
    hctx.font = 'bold 14px monospace';
    hctx.textAlign = 'center';
    hctx.fillText('REVERSE', hudCanvas.width / 2, hudCanvas.height * 0.44);
    hctx.textAlign = 'left';
  }

  // H13: fuel gauge. Horizontal bar with color shift as it depletes.
  const FUEL_W = 120;
  const FUEL_H = 8;
  const FUEL_X = 12;
  const FUEL_Y = 64;
  hctx.strokeStyle = '#666';
  hctx.lineWidth = 1;
  hctx.strokeRect(FUEL_X, FUEL_Y, FUEL_W, FUEL_H);
  const fuelColor = player.fuel < 0.15 ? '#f44' : player.fuel < 0.35 ? '#fa0' : '#0f0';
  hctx.fillStyle = fuelColor;
  hctx.fillRect(FUEL_X + 1, FUEL_Y + 1, (FUEL_W - 2) * player.fuel, FUEL_H - 2);
  hctx.fillStyle = '#ccc';
  hctx.font = '9px monospace';
  hctx.fillText(`FUEL ${Math.round(player.fuel * 100)}%`, FUEL_X + FUEL_W + 8, FUEL_Y + FUEL_H);
  if (player.fuel <= 0) {
    hctx.fillStyle = '#f44';
    hctx.font = 'bold 10px monospace';
    hctx.fillText('OUT OF FUEL — coast to a pump', FUEL_X, FUEL_Y + FUEL_H + 14);
  } else if (refuelingAt) {
    hctx.fillStyle = '#0f0';
    hctx.font = 'bold 10px monospace';
    hctx.fillText(`REFUELING — ${refuelingAt.name}`, FUEL_X, FUEL_Y + FUEL_H + 14);
  } else if (player.collisionFlash > 0) {
    hctx.fillStyle = `rgba(255, 200, 60, ${player.collisionFlash})`;
    hctx.font = 'bold 11px monospace';
    hctx.fillText('BUMP!', FUEL_X, FUEL_Y + FUEL_H + 14);
  }

  hctx.fillStyle = '#666';
  hctx.font = '9px monospace';
  hctx.fillText('WASD drive — H home — N skip day — T title', 12, hudCanvas.height - 10);

  // H12: top-right minimap overlay.
  drawMinimap(hctx, ctx.minimap, player, hudCanvas.width, ctx.life);
  // H75: real PC canvas gauge cluster (1:1 port of monolith
  // _drawGaugeCluster). Replaces the H64 standalone speedometer and
  // H65 standalone fuel gauge — drawGaugeCluster renders speedo +
  // inner RPM + gas/temp rim arcs + odometer + MENU button as a
  // single integrated widget.
  // SPEED_MAX_UPS is the arcadeUpdate gameplay cap (player.pSpeed never
  // exceeds this). The cluster dial max comes from the car's catalog
  // topSpeed below — they're different concepts and the monolith treats
  // them separately too.
  const SPEED_MAX_UPS = 200;             // matches arcadeUpdate MAX_SPEED
  // H77: monolith physics convention — 1 world-pixel = 0.2056m, so
  // SCALE_MS = 4.864 is the wpx/sec → m/s divisor used everywhere in
  // the monolith (camera zoom, steering rate, fuel burn). With pSpeed
  // measured in wpx/sec, mph = pSpeed / SCALE_MS * 2.237 — same formula
  // monolith L42011 and src/render/camera.ts L90 use.
  const SCALE_MS = 4.864;
  const _mph = (wpxs: number): number => (wpxs / SCALE_MS) * 2.237;
  // H80: km/h variant — monolith L33724 uses pSpeed/SCALE_MS*3.6 for
  // RHD/KM-H display. 3.6 = m/s × 3.6 → km/h.
  const _kmh = (wpxs: number): number => (wpxs / SCALE_MS) * 3.6;
  // H82: dial max comes from the active car's catalog topSpeed, not the
  // arcade cap. 1:1 port of monolith L34261-34263:
  //   _topSpdDisp = isMph
  //     ? Math.ceil((hc.topSpeed/SCALE_MS*2.237)*1.10/20)*20
  //     : Math.ceil((hc.topSpeed/SCALE_MS*3.6)*1.10/20)*20;
  // Fallback to SPEED_MAX_UPS only when no active car is resolved (the
  // pre-life start-flow path; should never happen in 'playing' state).
  const _dialTopUps = activeCar?.topSpeed ?? SPEED_MAX_UPS;
  const SPEED_MAX_MPH = Math.ceil((_mph(_dialTopUps) * 1.10) / 20) * 20;
  const SPEED_MAX_KMH = Math.ceil((_kmh(_dialTopUps) * 1.10) / 20) * 20;
  // H81: per-car redline + idleRPM from the catalog. Falls back to the
  // monolith's default fallback (7000 redline, 800 idle, same path the
  // RPM display in the monolith uses at L22573 + L23024 when CAR()
  // lacks a value: `(car && car.redline) || 7000`).
  const RPM_IDLE = activeCar?.idleRPM ?? 800;
  const RPM_MAX = activeCar?.redline ?? 7000;
  // H83: per-car gear bracket lookup. 1:1 port of monolith L26388-26391
  // (the automatic-transmission gear picker):
  //   pGear = C.gears;                  // top gear default
  //   for (let g=1; g<C.gears; g++) {
  //     if (aSpd < GS[g]) { pGear = g; break; }
  //   }
  // GS = activeCar.gearSpeeds (length gears+1, GS[0]=0). The monolith
  // displays pGear as a number ('1'..'gears') with no separate 'N' for
  // forward-direction at-rest — pSpeed=0 walks into GS[1] and lands on
  // pGear=1. Reverse (pGear=0, displayed 'R') triggers when pSpeed<0,
  // which arcadeUpdate can't currently produce (Math.max(0,...) clamps).
  // Falls back to the H75 speed-bracket proxy only when there's no
  // active car (pre-life start-flow path).
  // H88: gear bracket walk + shift timer + RPM target + integrator all
  // live in physics/gearAndRpm.ts now. Mutates player.prevGear,
  // player.gearShiftTimer, player.pRpm in place. See the file header
  // for the full monolith-line mapping. No-car fallback (pre-life
  // start-flow path) keeps the H75-era speed-bracket gear string +
  // H85 linear-proxy integrator inline.
  let _gearProxy: string;
  if (activeCar) {
    // H254: rpmFlutter — spark_plugs / intake_manifold / cam_sensor /
    // electrical_sensor / electrical_gremlin add sin-wave noise to
    // the tach needle target. Visible as misfire chatter on the
    // gauge cluster (silent when hideGauges is also active).
    // H256: shiftMult — trans_slip (3.0) and trans_hesitation (2.5)
    // stretch the upshift dip from 150ms up to 450ms / 375ms.
    tickGearAndRpm(
      player,
      activeCar,
      ctx.input.gas,
      ctx.frame.dt,
      ctx.faultEffects.rpmFlutter,
      ctx.faultEffects.shiftMult,
    );
    // H100: gear-pill string. 1:1 port of monolith L34256:
    //   _gearStr = pGear===0 ? 'R'
    //            : (manualGearTimer>0 && manualGear!=null ? 'M'+pGear
    //                                                     : pGear.toString())
    // The 'M' prefix is the visible cue that a manual shift bump is
    // active — the driver sees their q/e press take effect on the
    // gauge cluster, and once manualGearTimer expires the prefix
    // disappears as the bracket walk resumes auto-pick.
    _gearProxy = player.pSpeed < 0
      ? 'R'
      : (player.manualGearTimer > 0 && player.manualGear !== null
          ? 'M' + player.prevGear
          : String(player.prevGear));
  } else {
    if (player.pSpeed < 1) _gearProxy = 'N';
    else if (player.pSpeed < 30) _gearProxy = '1';
    else if (player.pSpeed < 65) _gearProxy = '2';
    else if (player.pSpeed < 105) _gearProxy = '3';
    else if (player.pSpeed < 150) _gearProxy = '4';
    else _gearProxy = '5';
    const _speedClamped = Math.max(0, Math.min(SPEED_MAX_UPS, player.pSpeed));
    const _rpmTarget = RPM_IDLE + (RPM_MAX - RPM_IDLE) * (_speedClamped / SPEED_MAX_UPS);
    player.pRpm += (_rpmTarget - player.pRpm) * 5 * ctx.frame.dt;
  }
  // H87: engine audio pitch driven by player.pRpm normalized into the
  // active car's idle→redline band. 1:1 port of monolith rpmNorm at
  // L18411:  clamp((pRPM-idleRPM)/(redline-idleRPM), 0, 1). Same signal
  // the monolith uses to drive its V8 engine loop playbackRate; the
  // modular synth-based engineOsc takes the same 0..1 input. Pitch now
  // dips on each gear-shift target dip (H86) and matches the tachometer
  // needle frame-by-frame — replaces the H8 placeholder `pSpeed/200`
  // that climbed linearly with road speed regardless of gear.
  const _rpmNorm = Math.max(0, Math.min(1,
    (player.pRpm - RPM_IDLE) / Math.max(1, RPM_MAX - RPM_IDLE)
  ));
  // H152/H153: full proceduralEngine pass + UI sfx all live on the
  // engine/audio AudioContext now. arcadeAudio's saw-wave engine,
  // crash thud, refuel ding, and low-fuel beep all retired in H153 —
  // the only thing left in arcadeAudio is the state-holder fields
  // (wasRefuelingLast, lastLowFuelBeepAtMs, unlocked, ...) which
  // stay until LIFE grows replacement slots.
  //
  // updateAudio internally:
  //   1. Classifies the car's engine type (i4 / i6 / v6 / v8 / v10 /
  //      f4 / rot / b2 / b4 / hd) from name + isBike.
  //   2. Drives the 4-resonator stack + bass osc + exhaust filter +
  //      bike scream gain to match the cylinder count's harmonic
  //      fingerprint at the current fundHz = rpm/60 * cyls/2.
  //   3. Fires exhaust pops on gear shifts + rev-limiter holds.
  //   4. Updates tireGrain (drift + wheelspin + brake-lock screech).
  //   5. Calls updateV8Engine for V8-named cars and damps the
  //      procedural engine when V8 is active (no double-engine).
  //
  // Several player fields are defaulted (no drift / wheelspin /
  // slip-angle state in arcadeUpdate yet — those land with the real
  // tire-slip port). brakeAmount is binary 0/1 from input.brake.
  void _rpmNorm; // computed for the gauge cluster below; audio reads
                 // RPM directly from player.pRpm.
  // H156: derive arcade approximations for drift / slip / wheelspin
  // / wheelGap so proceduralEngine's tireGrain fires correctly on
  // handbrake drifts and hard launches. arcade physics doesn't
  // model lateral velocity or wheel slip — these are heuristic
  // gates on existing inputs that fire the right audio events:
  //
  //   drifting       = ebrk held + speed > 30 + steer > 0.3
  //   slipAngle      = steer * 0.25 while drifting (signed)
  //   wheelspinRatio = 0.3 on hard launches (gas + gear ≤ 2 +
  //                                          rpm > 80% + speed < 30)
  //   wheelGap       = gearTopSpeed[gear] - |pSpeed| (delta to
  //                                                   ideal current
  //                                                   gear top end)
  //
  // Real values land with the NFS-Blackbox port at the tire-physics
  // commit.
  const _absSpd = Math.abs(player.pSpeed);
  const _steer = ctx.input.steerAxis;
  const _drifting = ctx.input.ebrk && _absSpd > 30 && Math.abs(_steer) > 0.3;
  player.drifting = _drifting;
  player.slipAngle = _drifting ? _steer * 0.25 : 0;
  const _wsLow = ctx.input.gas
    && player.prevGear <= 2
    && _rpmNorm > 0.8
    && _absSpd < 30;
  player.wheelspinRatio = _wsLow ? 0.3 : 0;
  const _gearTopSpeed = activeCar?.gearSpeeds?.[player.prevGear] ?? 0;
  player.wheelGap = Math.max(0, _gearTopSpeed - _absSpd);

  // H158: analog brakeAmount for proceduralEngine's brake-pad noise
  // + lock-up detection. 1:1 port of monolith L23879's
  //   brakeAmount = gpBrakeActive ? gpBrake : max(touch, kb)
  // (we have no analog touch yet — mobile pedal is a binary button —
  //  so the non-gamepad path collapses to the kb/touch boolean).
  // Effects:
  //   - Light trigger pull (0.04..0.5) → soft brake-pad rasp
  //   - Hard pull (>0.80) → tire lock-up screech + sample loop
  //   - Binary kb/touch still maps to 1.0 (always locks on a tap)
  // gas stays boolean in proceduralEngine — its only consumers are
  // gate conditions, no continuous modulation.
  const _gpBrakeActive = ctx.gamepad.connected && ctx.gamepad.brake > 0.02;
  const _brakeAmount = _gpBrakeActive
    ? ctx.gamepad.brake
    : (ctx.inputHeld.brake ? 1 : 0);

  if (activeCar) {
    updateEngineAudio({
      player: {
        speed: player.pSpeed,
        rpm: player.pRpm,
        gear: player.prevGear,
        drifting: player.drifting,
        slipAngle: player.slipAngle,
        onRoad,
        wheelspinRatio: player.wheelspinRatio,
        wheelGap: player.wheelGap,
      },
      controls: {
        gas: ctx.input.gas,
        braking: ctx.input.brake,
        ebrk: ctx.input.ebrk,
        brakeAmount: _brakeAmount,
      },
      car: {
        name: activeCar.name,
        isBike: activeCar.isBike,
        idleRPM: activeCar.idleRPM,
        redline: activeCar.redline,
      },
      uiOpen: ctx.home.open || ctx.worldEditor.active,
      dt: ctx.frame.dt,
    });
  }
  // H80: locale-aware speed/odo unit per active car's effective drive
  // side. RHD car (or LIFE.rhdOverride === true) → KM/H + KM; LHD →
  // MPH + MI. Matches monolith getEffectiveUnit at L7682 + the
  // dispSpeed branch at L33724.
  const _unit = activeCarId
    ? getEffectiveUnit(activeCarId, life, activeCarId, CAR_CATALOG)
    : 'mph';
  const _isMph = _unit === 'mph';
  const _odoRaw = activeCarId ? (life?.carOdometers?.[activeCarId] ?? 0) : 0;
  const gaugeOpts: GaugeOpts = {
    rpm: player.pRpm,
    redline: RPM_MAX,
    idleRPM: RPM_IDLE,
    speed: _isMph ? _mph(player.pSpeed) : _kmh(player.pSpeed),
    speedMax: _isMph ? SPEED_MAX_MPH : SPEED_MAX_KMH,
    speedUnit: _isMph ? 'MPH' : 'KM/H',
    gear: _gearProxy,
    fuel: player.fuel,
    temp: 0.4,                            // no temp model yet — sits in normal range
    battery: 1.0,                          // no battery model yet
    // H76: real per-car odometer. raw game units → miles via the
    // monolith's 0.0001278 factor, or km via 0.0002056. Floor matches
    // monolith L34266/34267.
    odo: _isMph ? Math.floor(_odoRaw * 0.0001278) : Math.floor(_odoRaw * 0.0002056),
    odoUnit: _isMph ? 'MI' : 'KM',
    todIcon: '',                           // legacy field, unused by cluster body
    todName: '',
    date: '',
    fps: ctx.frame.fpsDisplay,
  };
  const activeCarName = activeCar?.name;
  const genKey = getCarGeneration(activeCarName) ?? 'default';
  const preset = getGaugePreset(genKey);
  // H79: cluster sizing + position matches monolith L34322-34325 PC path.
  //   const _gWidgetR = document.body.classList.contains('mob') ? 35 : 42;
  //   const _gK = _gWidgetR / 100;
  //   const _gRimOuter = _gWidgetR + 5*_gK + 11*_gK;    // rimR + rimW/2
  //   _drawGaugeCluster(ctx, HUD_W - _gRimOuter, _gWidgetR, _gWidgetR, ...);
  // R=42 is the PC default; mobile would use 35 (deferred until the
  // mobile SVG path lands). Center cx = hudW - rimOuter so the gas
  // gauge's outer arc edge sits flush at the right canvas border;
  // cy = R so the speedo bezel top kisses the canvas top edge.
  const CLUSTER_R = 42;
  const _gK = CLUSTER_R / 100;
  const _gRimOuter = CLUSTER_R + 5 * _gK + 11 * _gK;
  const clusterCX = hudCanvas.width - _gRimOuter;
  const clusterCY = CLUSTER_R;
  // H254: hideGauges fault (display_failure only) blanks the entire
  // cluster. Player sees no speedo / tach / fuel / temp / battery —
  // the cluster space stays dark. Matches monolith L34234's
  // `if(_hg) skip` gate around the same draw call. The driver has
  // to read speed from the world (engine pitch, traffic relativity)
  // until they fix it at the mechanic.
  if (!ctx.faultEffects.hideGauges) {
    drawGaugeCluster(hctx, clusterCX, clusterCY, CLUSTER_R, gaugeOpts, preset);
  }

  // H182: pulsing cyan "🏠 ENTER HOME" button. Drawn before the home
  // overlay because the overlay covers it once opened — drawHomeHint
  // internally gates on !home.open so the order is belt-and-braces.
  // No-op when life is missing or _homeHint is false.
  if (life) {
    drawHomeHint(hctx, life, hudCanvas.width, hudCanvas.height, ctx.home.open, ctx.fullMapOpen);
  }

  // H183: orange/purple "VIEW CAR/HOME" near-pin button. Read straight
  // from the module-level _nearPin cache refreshed above. No-op when
  // _nearPin is null, which is the steady state until the pin-picker
  // ports and carPins can be populated.
  drawNearPinPrompt(hctx, hudCanvas.width, hudCanvas.height);

  // H185: private-seller overlay. Paints between near-pin (H183) and
  // broken indicator (H184) — same order as monolith L34504. Full-
  // screen 94%-black backdrop covers the HUD beneath. Currently only
  // the menu phase paints; testdrive HUD ports in H186.
  if (life?.sellerVisit) {
    drawSellerOverlay(hctx, {
      state: life.sellerVisit,
      GW: hudCanvas.width,
      GH: hudCanvas.height,
      getCar: catalogLookupAdapter,
    });
  }

  // H210: realtor overlay — full-screen 94%-black modal stacked
  // BETWEEN the seller overlay and the purchase modal in the
  // monolith's draw order. Realtor and sellerVisit never coexist
  // (different pin types), but the ordering keeps both eligible
  // for the purchase-modal layer above (future house-purchase
  // financing reuses the H207 modal).
  if (life?.realtorVisit && life.realtorVisit.phase !== 'driving') {
    const creditScore = (life.creditScore as number) ?? 650;
    const jobSalary = life.playerJob
      ? (JOB_SALARY_FOR_INCOME[life.playerJob as JobName] ?? 0)
      : 0;
    drawRealtorOverlay(hctx, {
      state: life.realtorVisit,
      creditScore,
      creditTier: getCreditTier(creditScore),
      annualIncome: jobSalary * 250,
      money: life.money,
      GW: hudCanvas.width,
      GH: hudCanvas.height,
    });
  }

  // H216: office-job day-flow modal. Drawn AFTER realtor + BEFORE
  // purchase since office is its own peer modal — never coexists
  // with seller / realtor flows (different entry path).
  if (life?.officeMenu) {
    drawOfficeMenu(hctx, {
      state: life.officeMenu,
      life,
      GW: hudCanvas.width,
      GH: hudCanvas.height,
    });
  }

  // H207: purchase finance modal — drawn ON TOP of the seller
  // overlay so the PURCHASE → modal flow stacks visually. BACK
  // closes only the purchase modal, leaving the seller menu
  // beneath visible again. 1:1 with monolith L34509 paint order.
  if (life?.purchaseMenu) {
    drawPurchaseMenu(hctx, {
      state: life.purchaseMenu,
      money: life.money,
      existingPayments: getTotalCarPayments(life),
      HUD_W: hudCanvas.width,
      menuCenterOffX: 0,
      GW: hudCanvas.width,
      GH: hudCanvas.height,
    });
  }

  // H223: race-HUD overlay — currently only the 'ready' phase
  // paints; countdown / racing / result lands in H224+. Draw
  // ABOVE the seller/realtor/purchase modals so the ready
  // confirmation always reads on top of any background state.
  if (life?.race && life.race.active) {
    drawRaceHud(hctx, {
      phase: life.race.phase,
      oppName: life.race.oppName,
      bet: life.race.betInput,
      pinkSlip: life.race.pinkSlip,
      raceDistance: null,
      useMph: true,
      TILE,
      countdown: life.race.countdown,
      px: player.px,
      py: player.py,
      oppX: life.race.oppX,
      oppY: life.race.oppY,
      startX: life.race.startX,
      startY: life.race.startY,
      finishX: life.race.finishX,
      finishY: life.race.finishY,
      winner: life.race.winner,
      // H241: outcome cache + fallback. _raceOutcome is set inline
      // when phase transitions to 'result' but isn't persisted by
      // the save shape — a save during the result modal would
      // restore life.race intact but lose the wonCarName /
      // lostCarName display. Fall back to deriving from race
      // state when the cache is absent.
      wonCarName: (() => {
        const o = (life as { _raceOutcome?: { wonCarName: string | null } })._raceOutcome;
        if (o?.wonCarName) return o.wonCarName;
        if (life.race.winner === 'player' && life.race.stakeType === 'car') {
          return life.race.oppName;
        }
        return null;
      })(),
      lostCarId: (() => {
        const o = (life as { _raceOutcome?: { lostCarName: string | null } })._raceOutcome;
        if (o?.lostCarName) return o.lostCarName;
        if (life.race.winner === 'opponent' && life.race.stakeType === 'car' && life.race.stakeCarId) {
          return CAR_CATALOG[life.race.stakeCarId]?.name ?? life.race.stakeCarId;
        }
        return null;
      })(),
      menuOpen: ctx.menu.open,
      carSelectOpen: false,
      fullMapOpen: ctx.fullMapOpen,
      homeScreenOpen: ctx.home.open,
      GW: hudCanvas.width,
      GH: hudCanvas.height,
    }, _raceHudRects);
  }

  // H184: broken-car indicator + CALL TOW button. Paints when
  // life.broken is set — dormant until the fault system flips it.
  // Drawn UNDER the home overlay / full map (matches monolith order
  // L34515 < L34534 menu overlay) so opening a modal hides the
  // breakdown UI; tow modal is meant to take over instead.
  if (life) {
    drawBreakdownIndicator(hctx, life, hudCanvas.width, hudCanvas.height);
  }

  // H30: home-screen overlay. Drawn LAST so it sits over the HUD
  // bars and minimap. Only renders when LIFE exists and home.open.
  if (life && ctx.home.open) {
    drawHomeOverlay(hctx, {
      GW: hudCanvas.width,
      GH: hudCanvas.height,
      life,
      clock: ctx.clock,
      tab: ctx.home.tab,
    });
  }

  // H178: full-screen city-map overlay. Drawn after the home overlay
  // so a player toggling the map mid-home-screen sees the map (less
  // surprising than the reverse). Paints a black backdrop and the
  // whole road network at city-centered zoom — see render/fullMap.ts.
  if (ctx.fullMapOpen) {
    drawFullMap(hctx, hudCanvas.width, hudCanvas.height, player, life);
  }

  // H181: notification toast. Drawn LAST so it sits over the home
  // overlay and the full map — the toast is a transient acknowledgment
  // ("Save loaded", "Pinned X as 3") that shouldn't get covered by
  // whatever the player just opened. Monolith renders it at L34474
  // inside drawPlaying, before the home-entry hint.
  if (life) {
    drawNotif(hctx, {
      state: life,
      GW: hudCanvas.width,
      GH: hudCanvas.height,
    });
  }

  // H192: main pause menu — drawn ABOVE everything when open. Full-
  // screen black backdrop covers the world, all HUD, and any modal
  // beneath. 1:1 with monolith L34534 paint order (last full-screen
  // modal in drawPlaying).
  if (ctx.menu.open) {
    drawPauseMenu(hctx, {
      state: ctx.menu,
      GW: hudCanvas.width,
      GH: hudCanvas.height,
      life,
      clock: ctx.clock,
    });
  }

  // H246: confirm prompt — sits on top of EVERYTHING (pause menu,
  // notif, HUD). Monolith paints it inside the menu translate block
  // at L35730; modular paints it after the menu so the panel stays
  // centered on the HUD canvas regardless of which overlay is
  // underneath. No-op when life._confirmPrompt is null.
  if (life) {
    drawConfirmPrompt(hctx, life, hudCanvas.width, hudCanvas.height);
  }
}



/** Click/tap dispatcher. Routes by gameState. Every state now has a real
 *  handler (or no-op for 'playing' where keyboard owns input); the cycle
 *  stop-gap from H1-H5 is gone. */
function installClickRouter(deps: GameLoopDeps): void {
  // H181: toast notifications. Writes to LIFE.notif/notifTimer so the
  // playing-state HUD's drawNotif paints the yellow toast band. Pre-
  // life states (title/jobSelect/carSelect) still call this — life is
  // null there, so we just console-log in DEV and skip the write.
  // The toast can't be drawn outside 'playing' anyway since drawNotif
  // is only called from drawPlaying.
  const notif = (msg: string): void => {
    if (__DEV__) console.log(`[notif] ${msg}`);
    const life = deps.ctx.life;
    if (life) setNotifState(life, msg);
  };

  const nameEntryDeps: NameEntryDeps = {
    showNotif: notif,
    onCommit: (commit) => {
      deps.ctx.character = commit;
      // H19: real age-weighted roll. Test mode bumps money to
      // $999,999 here AND skips the v8.99.42 job-band reroll
      // downstream so the test-mode cash doesn't get clobbered.
      const conds = rollStartingConditions(commit.age);
      if (commit.testMode) conds.money = 999_999;
      deps.ctx.startingConditions = conds;
      deps.ctx.jobSelect.scrollY = 0;
      hideNameOverlay();
      deps.ctx.gameState = 'jobSelect';
    },
  };

  const jobSelectDeps: JobSelectDeps = {
    onPick: (jobName) => {
      deps.ctx.playerJob = jobName;
      const ctxRef = deps.ctx;
      const conds = ctxRef.startingConditions!;
      const character = ctxRef.character!;
      // v8.99.42 + .43: reroll money via job-band table EXCEPT in
      // test mode (test players keep the $999,999 the name-entry
      // commit injected). Mutates the existing conds slot so any
      // other consumers of ctx.startingConditions see the new value.
      if (!character.testMode) {
        conds.money = rollStartingSavingsForJob(jobName, character.age);
      }
      // H20: real choice generator. Picks 4 deals from CAR_CATALOG
      // based on age + money + job, with proper credit tier + loan /
      // lease math + affordability gating per lane.
      deps.ctx.carSelect.payload = generateStartingCarChoices({
        age: character.age,
        money: conds.money,
        job: jobName,
        playerAlias: character.playerAlias,
        gender: character.gender,
        fitness: conds.fitness,
        skinTone: conds.skinTone,
      });
      deps.ctx.carSelect.scrollY = 0;
      deps.ctx.gameState = 'carSelect';
    },
  };

  const carSelectDeps: CarSelectDeps = {
    showNotif: notif,
    onPick: (choice) => {
      // H21: build LIFE and apply every committed start-flow value.
      const character = deps.ctx.character!;
      const conds = deps.ctx.startingConditions!;
      const job = deps.ctx.playerJob!;
      const life = createDefaultLife();
      applyStartingConditions(life, character, conds);
      applyStartingJob(life, job);
      applyStartingCarChoice(life, choice, character.testMode);
      deps.ctx.life = life;
      deps.ctx.gameState = 'playing';
      // Snapshot so reloads skip the start-flow.
      saveGame(deps.ctx);
    },
  };

  const titleDeps: TitleClickDeps = {
    setConfirmNewGame: (v) => { deps.ctx.title.confirmNewGame = v; },
    showNotif: notif,
    startNewGame: () => {
      clearSave();
      deps.ctx.gameState = 'nameEntry';
      ensureNameOverlay(nameEntryDeps);
    },
    loadFromStorage: () => {
      if (!loadGame(deps.ctx)) return false;
      // Loaded successfully — jump straight to 'playing'. The H-shape
      // save only ever persists from 'playing', so this is the
      // expected destination.
      deps.ctx.gameState = 'playing';
      return true;
    },
    openFileLoadPicker: () => {
      // H159: file-import fallback for users without a localStorage
      // save. 1:1 port of monolith L44062-44083 — spawns a hidden
      // input[type=file], FileReader-reads the picked .json as text,
      // calls loadGameFromText, and transitions to 'playing' on
      // success. Failures show a notif via the showNotif dep (same
      // path the save-overwrite confirm uses).
      // H228: desktop path uses the native open dialog via the
      // Tauri fs / dialog plugins. Falls through to the browser
      // hidden-input pattern when not running under Tauri.
      if (isTauriRuntime()) {
        void openFileNative().then((txt) => {
          if (!txt) return;
          try {
            if (loadGameFromText(deps.ctx, txt)) {
              deps.ctx.gameState = 'playing';
            } else {
              notif('Invalid save file!');
            }
          } catch {
            notif('Error reading save!');
          }
        });
        return;
      }
      const inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = '.json,application/json';
      inp.style.display = 'none';
      inp.onchange = (ev) => {
        const target = ev.target as HTMLInputElement | null;
        const f = target?.files?.[0];
        if (!f) {
          // User cancelled the picker — clean up the orphan input.
          inp.remove();
          return;
        }
        const r = new FileReader();
        r.onload = () => {
          try {
            const txt = typeof r.result === 'string' ? r.result : '';
            if (loadGameFromText(deps.ctx, txt)) {
              deps.ctx.gameState = 'playing';
            } else {
              notif('Invalid save file!');
            }
          } catch {
            notif('Error reading save!');
          } finally {
            inp.remove();
          }
        };
        r.onerror = () => {
          notif('Error reading save!');
          inp.remove();
        };
        r.readAsText(f);
      };
      document.body.appendChild(inp);
      inp.click();
    },
  };
  // H137: hand titleDeps to the per-frame gamepad handler. Set once
  // at boot — tickTitleGamepad reads from this ref each frame while
  // gameState === 'title'.
  _titleClickRouterRef = titleDeps;
  // H138: same wiring for jobSelect + carSelect so D-pad + A in those
  // states can reach onPick without lifting every closure out of
  // installClickRouter.
  _jobSelectDepsRef = jobSelectDeps;
  _carSelectDepsRef = carSelectDeps;

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
      const consumed = handleTitleClick(tx, ty, buildTitleOpts(deps), titleDeps);
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
    // H246: confirm prompt — TOP priority while open. Paints over
    // every other overlay (pause menu, modals, HUD) and eats every
    // tap until YES or NO. Has to fire before the pause-menu route
    // because the prompt is opened FROM the pause menu's OPT tab —
    // without this intercept, the YES/NO buttons would route into
    // pause-menu tap dispatch and never hit handleConfirmPromptTap.
    // 1:1 with monolith L21133 / L21708 entry points (same
    // hand-off pattern across all major tap-handler chains).
    if (state === 'playing' && deps.ctx.life?._confirmPrompt) {
      if (handleConfirmPromptTap(tx, ty, deps.ctx.life)) return;
    }
    // H192: pause menu — top priority while open (full-screen modal
    // covers everything). When closed, a top-right corner tap on
    // the HUD opens it. Both branches return immediately so the
    // rest of the playing-state taps can't fire underneath.
    if (state === 'playing') {
      if (deps.ctx.menu.open) {
        const pmDeps: PauseMenuDeps = {
          setTab: (t) => { deps.ctx.menu.tab = t; },
          close: () => { deps.ctx.menu.open = false; },
          // H245: SWITCH CAR — cycle to the next owned car. Interim
          // wiring before the carSelect modal (monolith L7686) ports;
          // that modal renders a tappable list, but until then a
          // single-tap cycle through ownedCars[] is the cadence-
          // correct way to make the button actually do something.
          // Guards mirror the monolith openCarSelect entry check at
          // L7687 (savedCar block) + the implicit no-op when only
          // one car is owned.
          switchCar: () => {
            const life = deps.ctx.life;
            if (!life) { deps.ctx.menu.open = false; return; }
            if (life.savedCar) {
              setNotifState(life, 'Return job vehicle first — go home!');
              deps.ctx.menu.open = false;
              return;
            }
            if (life.ownedCars.length <= 1) {
              setNotifState(life, 'Only one car owned');
              deps.ctx.menu.open = false;
              return;
            }
            const nextId = life.ownedCars[1];
            const r = runSwitchCar(life, deps.ctx, nextId);
            if (r.kind === 'swapped') {
              const car = CAR_CATALOG[r.toCarId];
              setNotifState(life, 'Switched to ' + (car?.name ?? r.toCarId));
            }
            deps.ctx.menu.open = false;
          },
          // H195: QUIT JOB clears life.job. 1:1 with monolith's
          // quit-flow — the active assignment ends; the player
          // keeps their playerJob (the role); they can pick a fresh
          // assignment next workday. The monolith also writes a
          // calendar event + bumps consecutiveAbsences when applicable;
          // those side effects port with the daily-job roller.
          quitJob: () => {
            const life = deps.ctx.life;
            if (life && life.job) {
              life.job = null;
              // H206: restore personal car if we swapped on accept.
              // 1:1 with monolith L21172 / L21795 quit paths.
              swapBackToPersonalCar(life);
              setNotifState(life, 'Quit job');
            }
          },
          // H243: SKIP WORK — burn the day, take the rep hit, fire
          // the player if absences pile up. 1:1 with monolith
          // skipWork() at L8854 (entry points L21177 + L21746 both
          // route here after closing the menu).
          skipWork: () => {
            const life = deps.ctx.life;
            if (life) {
              const r = runSkipWork(life);
              if (r.kind === 'fired') {
                setNotifState(life, "YOU'RE FIRED! Rep too low. Check JOBS tab.");
              } else {
                setNotifState(
                  life,
                  'Skipped work. No pay. Rep: ' + r.workRep + ' (' + r.absences + ' absences)',
                );
              }
            }
            deps.ctx.menu.open = false;
          },
          // H200: ACCEPT — picked assignment becomes life.job, clear
          // the available slate. Single-shift-per-day matches monolith.
          // H206: also swap to the job-typed vehicle when applicable
          // (PARAMEDIC → ambulance, TOW TRUCK → tow_truck, etc).
          // Personal car snapshotted to life.savedCar so delivery /
          // QUIT can restore it. Mirrors monolith L21185 / L21751
          // (`if (JOB_VEHICLES[LIFE.job.type]) swapToJobVehicle(...)`).
          acceptJob: (job) => {
            const life = deps.ctx.life;
            if (!life) return;
            life.job = { ...job };
            life._availJobs = [];
            const swapped = swapToJobVehicle(life, job.type);
            setNotifState(
              life,
              swapped
                ? 'Accepted ' + job.type + ' — switched to job vehicle'
                : 'Accepted ' + job.type,
            );
            deps.ctx.menu.open = false;
          },
          // H200: APPLY — picked opening becomes life.playerJob.
          // Clear _jobListings + _fired latch + zero the workRep
          // floor so the player starts fresh.
          applyForJob: (opening) => {
            const life = deps.ctx.life;
            if (!life) return;
            life.playerJob = opening.name;
            life._jobListings = [];
            life._fired = false;
            setNotifState(life, 'Hired: ' + opening.name);
          },
          // H220: lazy-fill the RACE tab on entry. Only fires when
          // the player's in the night slot AND no race is active —
          // otherwise the tab paints the H196 NIGHT-ONLY gate or
          // the in-progress race state. Re-entering with an active
          // race is a no-op (preserves the existing setup so the
          // player can keep tuning the stake).
          fillRaceTab: () => {
            const life = deps.ctx.life;
            if (!life) return;
            if (life.timeSlot !== 'night') return;
            if (life.race && life.race.active) return;
            const activeCarId = life.ownedCars[0];
            if (!activeCarId) return;
            life.race = newRaceSetup(activeCarId);
          },
          // H222: DIFFERENT OPPONENT — re-roll the opponent. Only
          // valid during the setup phase (the in-flight race
          // shouldn't swap opponents mid-countdown).
          rerollRaceOpponent: () => {
            const life = deps.ctx.life;
            if (!life || !life.race || life.race.phase !== 'setup') return;
            const activeCarId = life.ownedCars[0];
            if (!activeCarId) return;
            const fresh = newRaceSetup(activeCarId);
            if (fresh) {
              // Preserve the player's bet/stake selections through
              // the re-roll — only the opponent changes.
              fresh.stakeType = life.race.stakeType;
              fresh.betInput = life.race.betInput;
              fresh.stakeCarId = life.race.stakeCarId;
              life.race = fresh;
              setNotifState(life, 'Rolled a new opponent');
            }
          },
          // H223: START RACE → 'ready' phase + finishline placement.
          // Snapshots player position as startX/Y, rolls a finishline
          // on a far highway (80-250 tiles away), closes the pause
          // menu so the ready overlay is visible. Pink-slip flag
          // derives from non-money stake types.
          startRace: () => {
            const life = deps.ctx.life;
            if (!life || !life.race) return;
            const race = life.race;
            // Build the highway candidate list from the live
            // RENDER_ENTRIES — same data source the minimap reads.
            const candidates: RaceFinishCandidate[] = RENDER_ENTRIES.map((e) => ({
              isMajor: e.row[1] === 1,
              // row format: [width, isMajor, name, z, x1, y1, ...]
              pts: e.row.slice(4) as number[],
            }));
            const finish = generateRaceFinish(
              deps.ctx.player.px,
              deps.ctx.player.py,
              TILE,
              candidates,
            );
            race.phase = 'ready';
            race.startX = deps.ctx.player.px;
            race.startY = deps.ctx.player.py;
            race.finishX = finish.x;
            race.finishY = finish.y;
            race.pinkSlip = race.stakeType !== 'money';
            // H225: opponent spawns 2 tiles lateral to player
            // heading (right side). 1:1 with monolith fallback
            // L8276-8277. Initial speed 0 + angle = player.pAngle
            // so they start lined up alongside.
            const pAng = deps.ctx.player.pAngle;
            race.oppX = deps.ctx.player.px + Math.cos(pAng + Math.PI / 2) * TILE * 2;
            race.oppY = deps.ctx.player.py + Math.sin(pAng + Math.PI / 2) * TILE * 2;
            race.oppAngle = pAng;
            race.oppSpeed = 0;
            // Straight-line race distance for the HUD bar's stable
            // scale. Stored in tiles to match the monolith's
            // RACE.raceDistance convention.
            const ddx = race.finishX - race.startX;
            const ddy = race.finishY - race.startY;
            race.raceDistance = Math.sqrt(ddx * ddx + ddy * ddy) / TILE;
            deps.ctx.menu.open = false;
            setNotifState(life, '🏁 Drive to the finish — START COUNTDOWN when ready');
          },
          // H200: lazy-fill the JOBS tab on entry. Either populates
          // _jobListings (unemployed) or _availJobs (employed, no
          // active assignment, not done today). Each only fills if
          // the corresponding slot is empty so re-entering the tab
          // mid-session doesn't re-roll.
          fillJobsTab: () => {
            const life = deps.ctx.life;
            if (!life) return;
            if (!life.playerJob) {
              if (!life._jobListings || life._jobListings.length === 0) {
                life._jobListings = generateJobListings();
              }
            } else if (!life.job && !life.jobDoneToday) {
              if (!life._availJobs || life._availJobs.length === 0) {
                life._availJobs = generateDailyJob(
                  life.playerJob as JobName,
                  { getTile: (x, y) => getTile(deps.ctx.tileMap, x, y) },
                  {
                    dispatcherTrust: !!life.dispatcherTrust,
                    // H217: thread home/office coords so the OFFICE
                    // JOB branch can compute its commute path.
                    homeX: life.homeX,
                    homeY: life.homeY,
                    officeX: life.officeX,
                    officeY: life.officeY,
                  },
                );
              }
            }
          },
          // H246: RESTART — open the confirm modal. YES clears save
          // + reloads (executeConfirmAction in src/ui/modals/confirm.ts);
          // NO dismisses without action. Pause menu stays open
          // underneath so cancelling drops the player back into the
          // OPT tab. 1:1 with monolith L21425-21429.
          optRestart: () => {
            const life = deps.ctx.life;
            if (!life) return;
            life._confirmPrompt = {
              action: 'restart',
              title: 'RESTART GAME?',
              msg: 'All progress this session will be lost.',
            };
          },
          // H198: QUIT — save and return to title. Same path the
          // T-key dev shortcut takes at this file's L444-451.
          optQuit: () => {
            if (deps.ctx.gameState === 'playing') saveGame(deps.ctx);
            deps.ctx.gameState = 'title';
            deps.ctx.menu.open = false;
            resetInputState(deps.ctx);
          },
          optToggleXray: () => {
            const life = deps.ctx.life;
            if (life) life.gameplaySettings.xrayBody = !(life.gameplaySettings.xrayBody === true);
          },
          optToggleScanlines: () => {
            const life = deps.ctx.life;
            if (life) life.gameplaySettings.scanlines = !(life.gameplaySettings.scanlines === true);
          },
        };
        handlePauseMenuClick(
          tx, ty,
          {
            state: deps.ctx.menu,
            GW: deps.hudCanvas.width,
            GH: deps.hudCanvas.height,
            life: deps.ctx.life,
            clock: deps.ctx.clock,
          },
          pmDeps,
        );
        return;
      }
      // Open via top-right corner tap. 1:1 with monolith L20992.
      // Suppressed while any other modal is up — the user's
      // intent is the modal beneath, not opening a new layer.
      if (
        isMenuOpenCornerHit(tx, ty, deps.hudCanvas.width)
        && !deps.ctx.home.open
        && !deps.ctx.fullMapOpen
        && !(deps.ctx.life?.sellerVisit && deps.ctx.life.sellerVisit.phase !== 'driving')
        && !deps.ctx.life?.pinPicker
      ) {
        deps.ctx.menu.open = true;
        deps.ctx.menu.tab = 'car';
        return;
      }
    }
    // H178: tap-anywhere closes the full-screen map. Checked BEFORE
    // the home-overlay route so the map's tap-to-close takes priority
    // over any HUD widget underneath (the map covers the whole HUD).
    if (state === 'playing' && deps.ctx.fullMapOpen) {
      deps.ctx.fullMapOpen = false;
      return;
    }
    // H223: race-HUD modal route. Sits at the top of the modal
    // stack so the ready-phase START COUNTDOWN / FORFEIT buttons
    // beat seller / realtor / office taps. Only fires when a race
    // is active; otherwise falls through to whatever's below.
    if (state === 'playing' && deps.ctx.life?.race?.active) {
      const life = deps.ctx.life;
      const race = life.race!;
      const raceDeps: RaceHudDeps = {
        startCountdown: () => {
          race.phase = 'countdown';
          race.countdown = 3;
          setNotifState(life, '3…');
        },
        forfeit: () => {
          life.race = null;
          // H241: hygiene — clear any stale outcome cache too.
          // The forfeit path technically can't leak _raceOutcome
          // (forfeit only fires in 'ready' phase, before
          // applyRaceResult), but a save-loaded race-mid-result
          // scenario could leave one set. Mirror dismissResult.
          (life as { _raceOutcome?: unknown })._raceOutcome = null;
          setNotifState(life, 'Race forfeited');
        },
        dismissResult: () => {
          life.race = null;
          (life as { _raceOutcome?: unknown })._raceOutcome = null;
        },
      };
      if (handleRaceHudTap(tx, ty, _raceHudRects, raceDeps)) return;
    }

    // H216: office-menu modal route. Peer modal — never coexists
    // with seller / realtor (different entry path: OFFICE JOB
    // arrival from H202/H216 jobArrival).
    if (state === 'playing' && deps.ctx.life?.officeMenu) {
      const life = deps.ctx.life;
      const om = life.officeMenu!;
      handleOfficeMenuClick(
        tx, ty,
        {
          state: om,
          life,
          GW: deps.hudCanvas.width,
          GH: deps.hudCanvas.height,
        },
        (msg) => setNotifState(life, msg),
        (l) => swapBackToPersonalCar(l),
      );
      return;
    }
    // H211: realtor modal route. Full-screen modal — eats all
    // taps while up. Sits BETWEEN purchase (top) and seller in the
    // draw stack but realtor + seller never coexist (mutually-
    // exclusive pin types). commit() routes to TODO notif until
    // H212 ports completeHomePurchase. evaluateOffer threads the
    // player's live finance state through evaluateHomeOffer.
    if (state === 'playing' && deps.ctx.life?.realtorVisit && deps.ctx.life.realtorVisit.phase !== 'driving') {
      const life = deps.ctx.life;
      const rv = life.realtorVisit!;
      const creditScore = (life.creditScore as number) ?? 650;
      const jobSalary = life.playerJob
        ? (JOB_SALARY_FOR_INCOME[life.playerJob as JobName] ?? 0)
        : 0;
      const annualIncome = jobSalary * 250;
      const realtorDeps: RealtorDeps = {
        evaluateOffer: (downPct) =>
          evaluateHomeOffer({
            price: rv.listing.price,
            downPct,
            money: life.money,
            creditScore,
            annualIncome,
            existingMonthlyDebt:
              getTotalCarPayments(life) + (life.mortgageBalance > 0 ? monthlyHousing(life) : 0),
          }),
        // H212: real commit — completeHomePurchase handles both
        // rental (deduct 2× upfront + housingType) and ownership
        // (deduct downAmt + write mortgage state) branches. Splices
        // the newspaper row + prunes the matching carPin + repairs
        // remaining pin indices. Clears realtorVisit on success.
        commit: () => {
          if (__DEV__) console.log('[realtor] commit');
          completeHomePurchase(life, deps.ctx.player, (msg) => setNotifState(life, msg));
        },
        walkAway: () => {
          life.realtorVisit = null;
          setNotifState(life, 'Left the realtor');
        },
        showNotif: (msg) => setNotifState(life, msg),
      };
      handleRealtorTap(
        tx, ty,
        {
          state: rv,
          creditScore,
          creditTier: getCreditTier(creditScore),
          annualIncome,
          money: life.money,
          GW: deps.hudCanvas.width,
          GH: deps.hudCanvas.height,
        },
        realtorDeps,
      );
      return;
    }
    // H207: purchase modal route. Sits ON TOP of the seller overlay
    // visually so its tap handler must run first. BACK closes the
    // purchase modal only; the seller menu beneath stays open.
    // commit() is currently a TODO — real handler lands with the
    // completePurchase port (H208).
    if (state === 'playing' && deps.ctx.life?.purchaseMenu) {
      const life = deps.ctx.life;
      const pm = life.purchaseMenu!;
      const purchaseDeps: PurchaseDeps = {
        // H208: real commit. Drives completePurchase with the
        // PurchaseMenuState fields written at H207's openPurchase
        // call. Closes the seller-visit modal too via the
        // closeSellerVisit flag (which is true for the seller-flow
        // path; future 'lot' entry would pass false).
        commit: (opt) => {
          if (__DEV__) console.log('[purchase] commit', opt.type, opt.label);
          completePurchase(
            life,
            pm.carId,
            pm.carName,
            pm.price,
            pm.isNew,
            opt,
            pm.source,
            pm.index,
            pm.preFaults,
            !!pm.sellerVisit,
            life.carOdometers,
            (msg) => setNotifState(life, msg),
          );
        },
        cancel: () => {
          life.purchaseMenu = null;
        },
      };
      handlePurchaseMenuClick(
        tx, ty,
        {
          state: pm,
          money: life.money,
          existingPayments: getTotalCarPayments(life),
          HUD_W: deps.hudCanvas.width,
          menuCenterOffX: 0,
          GW: deps.hudCanvas.width,
          GH: deps.hudCanvas.height,
        },
        purchaseDeps,
      );
      return;
    }
    // H185: seller overlay route. Full-screen 94%-black modal — if
    // it's up, every other playing-state tap below MUST fall through
    // it first. Mirrors monolith L20940 priority (realtor/seller
    // checked before near-pin, breakdown, home-hint). Returns true
    // when a button consumed the tap; we return early either way so
    // taps that miss the buttons (e.g. on the price line) don't leak
    // through to handlers behind the modal.
    // H186: testdrive phase routes here too — only the top-bar tap
    // is consumed; everything else falls through so the player can
    // still steer. handleSellerClick owns that branch internally.
    if (
      state === 'playing'
      && deps.ctx.life?.sellerVisit
      && deps.ctx.life.sellerVisit.phase !== 'driving'
    ) {
      const life = deps.ctx.life;
      const sv = life.sellerVisit!;
      const sellerDeps: SellerDeps = {
        // PURCHASE / HAGGLE / INSPECT / TEST DRIVE port later — for
        // now they surface a TODO notif so the wiring is observable.
        // The monolith implementations are:
        //   openPurchase  → L49581 (writes LIFE.purchaseMenu)
        //   haggle        → L49708 (haggleWithSeller, fault-tier disc)
        //   inspect       → L49593 (sets _inspected, random reveals)
        //   startTestDrive→ L49793 (saves tdSavedCar, phase='testdrive')
        //   endTestDrive  → L49826 (restores tdSavedCar, phase='menu')
        // H207: real PURCHASE handler. Opens the finance modal
        // with pre-computed options (cash/loan/lease via
        // getFinanceOptions). The modal owns its own click router
        // from this point on; sellerVisit stays open underneath so
        // a BACK from the purchase modal lands back on the seller
        // menu. 1:1 with monolith L49581-49589.
        openPurchase: () => {
          if (__DEV__) console.log('[seller] PURCHASE tapped');
          const isNew = !!sv.listing.isNew;
          life.purchaseMenu = {
            carId: sv.listing.id,
            carName: sv.listing.name,
            price: sv.hagglePrice,
            isNew,
            source: 'newspaper',
            index: sv.index,
            preFaults: sv.preFaults,
            sellerVisit: true,
            options: getFinanceOptions(sv.hagglePrice, isNew),
            listing: { mileage: sv.listing.mileage },
          };
        },
        // H191: real HAGGLE handler. 30% chance the seller refuses;
        // 70% chance hagglePrice drops to 80-95% of current. 1:1
        // with monolith L49626-49637 notifs.
        haggle: () => {
          if (__DEV__) console.log('[seller] HAGGLE tapped');
          const newPrice = haggleWithSeller(sv);
          if (newPrice === null) {
            setNotifState(life, "Seller won't budge on price!");
          } else {
            setNotifState(life, 'Seller agrees to $' + newPrice + '!');
          }
        },
        // H190: real INSPECT handler. Rolls each undetected non-test-
        // drive fault against detectChance. Notif summarizes the
        // outcome — 'Looks clean from the outside' or 'Visual check:
        // N issue(s) found!' (1:1 monolith L49607-49610).
        inspect: () => {
          if (__DEV__) console.log('[seller] INSPECT tapped');
          const found = inspectSellerCar(sv);
          if (found > 0) {
            setNotifState(
              life,
              'Visual check: ' + found + ' issue' + (found > 1 ? 's' : '') + ' found!',
            );
          } else {
            setNotifState(life, 'Looks clean from the outside');
          }
        },
        // H187: real test-drive handlers. Swap into the listing's car,
        // start the 45s timer (startTestDrive). End-tap or expiry calls
        // endTestDrive to restore the player's original car + faults.
        startTestDrive: () => {
          if (__DEV__) console.log('[seller] TEST DRIVE start');
          startTestDrive(life, sv, deps.ctx.player, (msg) => setNotifState(life, msg));
        },
        endTestDrive: () => {
          if (__DEV__) console.log('[seller] TEST DRIVE end (tap)');
          endTestDrive(life, sv, deps.ctx.player, (msg) => setNotifState(life, msg));
        },
        // WALK AWAY actually works: clear sellerVisit + notif. 1:1
        // port of monolith L49617-49619.
        walkAway: () => {
          life.sellerVisit = null;
          setNotifState(life, 'Left the seller');
        },
      };
      const consumed = handleSellerClick(
        tx,
        ty,
        {
          state: sv,
          GW: deps.hudCanvas.width,
          GH: deps.hudCanvas.height,
          getCar: catalogLookupAdapter,
        },
        sellerDeps,
      );
      // H186: menu phase eats every tap (full-screen modal); testdrive
      // phase only eats the top-bar tap so the player can still steer.
      // handleSellerClick returns false for the testdrive fall-through
      // case — fall through to the rest of the playing-state taps.
      if (sv.phase === 'menu' || consumed) return;
    }
    // H184: CALL TOW button tap. Sets life.towMenuOpen so the
    // tow-pricing modal will pick it up (monolith L20948 + L22051 +
    // L21675 — three call sites all writing the same flag). Checked
    // BEFORE the near-pin prompt because the buttons sit one above
    // the other (tow at GH*0.42, near-pin at GH*0.35) — overlapping
    // taps when broken should reach the tow button first.
    // isCallTowHit internally gates on broken state + suppress flags,
    // so when LIFE.broken is false this branch falls through cheaply.
    if (
      state === 'playing'
      && deps.ctx.life
      && isCallTowHit(tx, ty, deps.hudCanvas.width, deps.hudCanvas.height, deps.ctx.life)
    ) {
      deps.ctx.life.towMenuOpen = true;
      if (__DEV__) console.log('[tow] CALL TOW tapped — towMenuOpen=true');
      return;
    }
    // H183/H188: near-pin prompt tap. Car pins route through
    // openSellerVisitFromPin (H188 — 1:1 port of monolith L50386-
    // 50398 direct-menu entry). House pins still TODO-notif until
    // openRealtorVisit / drawRealtorOverlay port.
    if (
      state === 'playing'
      && getNearPin()
      && isNearPinHit(tx, ty, deps.hudCanvas.width, deps.hudCanvas.height)
    ) {
      const pin = getNearPin()!;
      const pinListing = pin.listing as { type?: string } | undefined;
      const isHouse = pinListing?.type === 'house';
      const life = deps.ctx.life;
      if (!life) return;
      if (isHouse) {
        if (__DEV__) console.log(`[near-pin] tap on house pin "${pin.label}"`);
        // H209: route house pins to the realtor flow. Cast through
        // CarPin.listing (typed unknown) into the realtor's
        // RealtorListing shape — newspaper-generated house rows
        // carry the same fields the realtor reads. listing.worldX/Y
        // synthesized at pinPicker commit time (H189) so they're
        // stable across the tap.
        openRealtorVisit(
          life,
          pin.listing as RealtorListing,
          pin,
          (msg) => setNotifState(life, msg),
        );
        return;
      }
      if (__DEV__) console.log(`[near-pin] tap on car pin "${pin.label}"`);
      // Cast through the CarPin.listing unknown into the seller
      // shape. carPins are pushed by the (un-ported) pinPicker UI
      // from newspaper listings, which share the same field set —
      // see [[H180]] CarPin doc.
      openSellerVisitFromPin(
        life,
        {
          worldX: pin.worldX,
          worldY: pin.worldY,
          listing: pin.listing as SellerVisitState['listing'],
          index: pin.index,
        },
        deps.ctx.player,
        (msg) => setNotifState(life, msg),
      );
      return;
    }
    // H182: tapping the cyan ENTER HOME hint opens the home overlay
    // (mirrors monolith L20994-20999). Gated on _homeHint so taps
    // through where the button isn't visible fall through to other
    // handlers. Checked BEFORE the home-overlay route since this
    // path *opens* the overlay.
    if (
      state === 'playing'
      && deps.ctx.life?._homeHint
      && !deps.ctx.home.open
      && isHomeHintHit(tx, ty, deps.hudCanvas.width, deps.hudCanvas.height)
    ) {
      deps.ctx.home.open = true;
      deps.ctx.home.tab = 'main';
      resetInputState(deps.ctx);
      // Same lazy newspaper fill the H key path runs — keeps the
      // tap-to-open and key-to-open paths behaviorally identical.
      fillNewspaperListings(deps.ctx.life, deps.ctx.clock.day);
      return;
    }
    if (state === 'playing' && deps.ctx.home.open && deps.ctx.life) {
      // H30: route taps to the home overlay while it's up.
      const homeDeps: HomeOverlayDeps = {
        setTab: (t) => { deps.ctx.home.tab = t; },
        close: () => { deps.ctx.home.open = false; deps.ctx.home.tab = 'main'; },
      };
      handleHomeOverlayClick(tx, ty, {
        GW: deps.hudCanvas.width,
        GH: deps.hudCanvas.height,
        life: deps.ctx.life,
        clock: deps.ctx.clock,
        tab: deps.ctx.home.tab,
      }, homeDeps);
      return;
    }
    // 'playing' canvas taps reserved for future use (e.g., menu
    // toggle); ignored for now.
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
    } else if (
      state === 'playing'
      && deps.ctx.menu.open
      && deps.ctx.menu.tab === 'opt'
      && deps.ctx.life
    ) {
      // H219: pause-menu OPT tab scroll. drawOptTab writes
      // _menuTabScrollMax each paint; clamp the new scrollY against
      // it. Wheel deltaY is one notch per click on most pointers, so
      // we scale to match the H38/H44 list-scroll feel elsewhere.
      e.preventDefault();
      const life = deps.ctx.life as { _menuTabScrollY?: number; _menuTabScrollMax?: number };
      const max = life._menuTabScrollMax ?? 0;
      const cur = life._menuTabScrollY ?? 0;
      life._menuTabScrollY = Math.max(0, Math.min(max, cur + e.deltaY));
    } else if (
      state === 'playing'
      && deps.ctx.home.open
      && deps.ctx.home.tab === 'garage'
      && deps.ctx.life
    ) {
      // H257: home-overlay GARAGE tab scroll. drawGarageTab writes
      // _garageScrollMax each paint; clamp the new scrollY against
      // it. Without this, test-mode players (ALL_CAR_IDS = 30+ cars)
      // can only access the first 7 — the rest render off the
      // bottom of the clip.
      e.preventDefault();
      const life = deps.ctx.life;
      const max = life._garageScrollMax ?? 0;
      const cur = life._garageScrollY ?? 0;
      life._garageScrollY = Math.max(0, Math.min(max, cur + e.deltaY));
    }
  }, { passive: false });
}
