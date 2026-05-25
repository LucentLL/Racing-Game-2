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
import { runPhase0BTick, shouldUsePhase0B } from '@/physics/phase0BAdapter';
import { tickGearAndRpm } from '@/physics/gearAndRpm';
import { getTorqueAtRPM } from '@/physics/torqueCurve';
import { wpxsToMph, wpxsToKmh, MILES_PER_GAME_UNIT, KM_PER_GAME_UNIT, gameUnitsToMiles, SCALE_MS } from '@/physics/physicsUnits';
import { applyCruiseSpeedCap, cruiseShouldAutoDisable } from '@/physics/cruiseControl';
import { effectiveTopSpeed } from '@/physics/topSpeedCap';
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
  spawnWreckSmoke,
  updateParticles,
  drawParticles,
} from '@/render/particles';
import { drawMinimap } from '@/render/minimap';
import { drawFullMap } from '@/render/fullMap';
import { drawGaugeCluster, type GaugeOpts } from '@/render/hud/gauges';
import { updateSpeedoSvg, setSpeedoSvgVisible } from '@/render/hud/speedoSvg';
import { updateMobileRpm, setMobileRpmSvgVisible } from '@/render/hud/mobileRpmSvg';
import { getWheelSteerAxis } from '@/input/steerWheel';
import { getPedalGasAmount, getPedalBrakeAmount } from '@/input/sliderPedal';
import { installShifter, updateShifterGear } from '@/input/shifter';
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
import { applyForJob as runApplyForJob } from '@/sim/applyForJob';
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
  applyAudioVolumes,
} from '@/engine/audio';
import { drawHomeOverlay, handleHomeOverlayClick, type HomeOverlayDeps } from '@/ui/screens/home/overlay';
import { fillNewspaperListings } from '@/sim/newspaperGenerator';
import { rollStartingConditions, rollStartingSavingsForJob } from '@/sim/startingConditions';
import { generateStartingCarChoices } from '@/sim/startingCars';
import { applyStartingConditions, applyStartingJob } from '@/sim/applyStartingConditions';
import { applyStartingCarChoice } from '@/sim/applyStartingCarChoice';
import { fireMonthlyBills, isMonthBoundary } from '@/sim/monthlyBills';
import { generateCarAdOffers } from '@/sim/carAds';
import { checkMonthlyRaise } from '@/sim/monthlyRaise';
import { decayStreetRep } from '@/sim/decayStreetRep';
import { updateConnections } from '@/sim/updateConnections';
import { tickHiddenFaultReveal } from '@/sim/hiddenFaultReveal';
import { tickBreakdownRecovery } from '@/sim/breakdownRecovery';
import { tickIncomingTow } from '@/sim/incomingTowTick';
import { getMileageTier } from '@/sim/mileageTier';
import { diagnoseFault } from '@/sim/diagnoseFault';
import { maybeRollBreakdown } from '@/sim/breakdownRoll';
import { runFridayPayout, runYearRolloverW2 } from '@/sim/payday';
import { expireCarPins } from '@/sim/expireCarPins';
import { checkOutOfGas } from '@/sim/outOfGasBreakdown';
import { getDateString } from '@/config/calendar';
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
import { drawPursuitHud } from '@/ui/hud/pursuit';
import { drawJobIndicator } from '@/ui/hud/jobIndicator';
import { drawRoadInfo } from '@/ui/hud/roadInfo';
import { drawCrtScanlines } from '@/render/crt';
import { drawPhysicsDebug } from '@/ui/hud/physicsDebug';
import { drawTowMenu, handleTowMenuClick } from '@/ui/modals/towMenu';
import { drawGasStationMenu, handleGasStationTap } from '@/ui/modals/gasStation';
import {
  drawPauseMenu,
  handlePauseMenuClick,
  isMenuOpenCornerHit,
  MENU_TAB_ORDER,
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
import { generateCarLot } from '@/sim/carLot';
import { applyZoneDamage } from '@/sim/faults';
import { getTotalCarPayments } from '@/sim/finance';
import { TILE, WORLD_W, WORLD_H } from '@/config/world/tiles';
import { startTestDrive, endTestDrive, tickTestDrive } from '@/sim/sellerTestDrive';
import { saveGame, loadGame, loadGameFromText, exportSaveToFile, clearSave } from '@/save/interim';
import { isTauriRuntime, openFileNative } from '@/platform/desktop';
import { pollGamepad, gpPressed } from '@/input/gamepad';
import { playRumble } from '@/input/rumble';
import { tickRumbleStrip } from '@/input/rumbleStrip';
import { _weTick, _weToggle, _weExit, _weResizeCanvas, type EditorLifecycleDeps } from '@/editor';
import { _weCanvasMouseDown, _weCanvasMouseMove, _weCanvasMouseUp, _weCanvasWheel, _weCanvasContextMenu, _weTouchStart, _weTouchMove, _weTouchEnd, _weDeleteSelected, WHEEL_ZOOM_FACTOR, ZOOM_MIN, ZOOM_MAX, type InputDeps as EditorInputDeps } from '@/editor/input';
import { _weScreenToTile, type RenderDeps as EditorRenderDeps, type RenderOrchestratorDeps as EditorRenderOrchestratorDeps } from '@/editor/render';
import { getEditedBaselinePts, getOverlayPts } from '@/editor/input';
import { _weEffectiveMaterialAge, _weApplyMaterialOrAge, _weDeleteSelected as _weDeleteSelectedToolbar, type MaterialBearingRoad, type BaselineRoadEntry as EditorBaselineRoadEntry, type DeleteDeps as EditorDeleteDeps } from '@/editor/delete';
import { BASELINE_ROADS, type BaselineRoadRow } from '@/config/world/baselineRoads';
import { MAP_W, MAP_H } from '@/config/world/tiles';
import { _weBeginDraft, _weCommitDraft, _weCancelDraft, _weCurvePoints } from '@/editor/draft';
import { _weMakeDriveway, type StampDeps as EditorStampDeps, type TilePoint as EditorTilePoint } from '@/editor/stamp';
import { _weMergeBondEndpoints, type MergeDeps as EditorMergeDeps } from '@/editor/merge';
import { _weSaveOverlayToStorage, _weSaveBaselineEdits } from '@/editor/storage';
import { _weDetectAngleRefDirection, type AngleRefRoad } from '@/editor/angleRef';
import { _weCurrentRelativeAngleDeg, _weApplyAngleToSelectedRoad, _weSmoothSelectedPolygon, type SelectDeps as EditorSelectDeps } from '@/editor/select';
import { _weFindRiverSnap, _weFindSnap, _weSnapSelectedEndpoints, type SnapDeps as EditorSnapDeps } from '@/editor/snap';
import { _weReadProps, _weExport, _weReloadBaseline, type ExportDeps as EditorExportDeps } from '@/editor/export';
import { _weBindUI, type UiBindDeps as EditorUiBindDeps } from '@/editor/ui';
import { camYRatioForTilt } from '@/render/camera';
import { tiltState, effectiveTiltDeg, TILT_PERSPECTIVE_PX, CANVAS_OVERSCAN } from '@/engine/tilt';
import { setRenderScale } from '@/engine/renderScale';
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
  installShifterBindings(deps);

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
 *  pick up canvas size changes on window resize.
 *
 *  H608: now also threads through `renderDeps` so `_weTick` dispatches
 *  to the full `_weRender` pipeline (asphalt material/age, lane
 *  dividers, bridge concrete) instead of the H116 placeholder. */
function editorDeps(deps: GameLoopDeps): EditorLifecycleDeps {
  return {
    isDevToolsEnabled: () => import.meta.env.DEV,
    getCanvas: () => document.getElementById('weCanvas') as HTMLCanvasElement | null,
    getOverlay: () => document.getElementById('weOverlay'),
    confirm: (msg: string) => window.confirm(msg),
    scheduleRedraw: (state) => { state.needsRedraw = true; },
    renderDeps: getEditorRenderDeps(deps),
  };
}

/** H638: line-segment intersection. Returns the intersection point
 *  when both segments cross strictly inside their parameter ranges;
 *  null otherwise. The 0.01 / 0.99 inner band excludes shared
 *  endpoints — adjacent segments of the same polyline never report
 *  as crossing each other, which is what `computeMaxCrossedZ` needs
 *  to avoid false-positive self-cross on the selected road. Mirrors
 *  the same helper inside editor/apply.ts (kept here as a duplicate
 *  so the editor wire-up doesn't depend on a privately-exported
 *  helper). */
function _segHitEditor(
  x1: number, y1: number, x2: number, y2: number,
  x3: number, y3: number, x4: number, y4: number,
): boolean {
  const d = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
  if (Math.abs(d) < 0.01) return false;
  const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / d;
  const u = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / d;
  return t > 0.01 && t < 0.99 && u > 0.01 && u < 0.99;
}

/** H608: lazy + cached build of the editor's full render-deps bundle.
 *  Memoized per GameLoopDeps so the closures aren't reallocated every
 *  frame (editorDeps itself fires once per tick). */
const editorRenderDepsCache = new WeakMap<
  GameLoopDeps,
  EditorRenderDeps & EditorRenderOrchestratorDeps
>();
function getEditorRenderDeps(
  deps: GameLoopDeps,
): EditorRenderDeps & EditorRenderOrchestratorDeps {
  const cached = editorRenderDepsCache.get(deps);
  if (cached) return cached;
  const fresh = buildEditorRenderDeps(deps);
  editorRenderDepsCache.set(deps, fresh);
  return fresh;
}

/** Deterministic Murmur3-style avalanche mix for age default — mirrors
 *  `roadAgeForRow` in src/render/roadTextures.ts so the editor draws
 *  the same new/old age the game would. */
function hashRoadAge(x: number, y: number): 'new' | 'old' {
  const ix = (x * 100) | 0;
  const iy = (y * 100) | 0;
  let h = Math.imul(ix, 0x9e3779b1) ^ Math.imul(iy, 0x6a09e667);
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return ((h >>> 0) % 100) < 40 ? 'new' : 'old';
}

/** H608: full RenderDeps + RenderOrchestratorDeps bundle for `_weRender`.
 *  Builds the road list (baseline + overlay) on each frame call so live
 *  edits propagate immediately; lane geometry / material-age resolvers
 *  mirror the game's worldMap.ts so the editor matches what would ship.
 *
 *  The deletedSet / per-road property reads are O(N) per frame; for
 *  Charlotte's ~120-road network this is well under a millisecond. */
function buildEditorRenderDeps(
  deps: GameLoopDeps,
): EditorRenderDeps & EditorRenderOrchestratorDeps {
  const we = () => deps.ctx.worldEditor;
  const LANE_W_STD = 1.275;
  const STRIPE_INSET = 1.7 / TILE;

  const defaultMaterial = (r: MaterialBearingRoad): 'asphalt' | 'concrete' => {
    const name = (r as { name?: string }).name ?? '';
    return name === 'Driveway' ? 'concrete' : 'asphalt';
  };
  const defaultAge = (r: MaterialBearingRoad): 'new' | 'old' | 'auto' => {
    const pts = (r as { pts?: number[][] }).pts;
    if (!pts || pts.length < 1) return 'old';
    return hashRoadAge(pts[0][0], pts[0][1]);
  };

  const getMajorRoads = (): Array<{
    pts: number[][];
    w: number;
    maj: number;
    name: string;
    z: number;
    [k: string]: unknown;
  }> => {
    const state = we();
    const out: Array<{
      pts: number[][];
      w: number;
      maj: number;
      name: string;
      z: number;
      [k: string]: unknown;
    }> = [];
    // Resolve material from explicit override → Driveway → asphalt;
    // resolve age from explicit override → Murmur3 hash of first vertex.
    // Mirrors src/render/roadTextures.ts:roadMaterialForRow/roadAgeForRow
    // so the editor draws the same per-road new/old variation the game does.
    const resolveMaterial = (
      explicit: string | undefined,
      name: string,
    ): 'asphalt' | 'concrete' =>
      explicit === 'asphalt' || explicit === 'concrete'
        ? explicit
        : name === 'Driveway' ? 'concrete' : 'asphalt';
    const resolveAge = (
      explicit: string | undefined,
      firstX: number,
      firstY: number,
    ): 'new' | 'old' =>
      explicit === 'new' || explicit === 'old'
        ? explicit
        : hashRoadAge(firstX, firstY);
    const deletedSet = new Set(state.baselineDeletes);
    for (let i = 0; i < BASELINE_ROADS.length; i++) {
      const row = BASELINE_ROADS[i] as BaselineRoadRow;
      const pts = deletedSet.has(i) ? [] : getEditedBaselinePts(state, i);
      const props = state.baselineRoadProps?.[String(i)];
      const overrides = state.baselineMaterialOverrides?.[String(i)];
      const firstX = pts.length > 0 ? pts[0][0] : (row[4] as number);
      const firstY = pts.length > 0 ? pts[0][1] : (row[5] as number);
      out.push({
        pts: pts as number[][],
        w: row[0],
        maj: row[1],
        name: row[2],
        z: row[3],
        material: resolveMaterial(props?.material, row[2]),
        age: resolveAge(props?.age, firstX, firstY),
        materialOverrides: overrides,
      });
    }
    const overlay = state.overlay as unknown[];
    for (let oIdx = 0; oIdx < overlay.length; oIdx++) {
      const raw = overlay[oIdx] as readonly (string | number)[] | undefined;
      if (!raw || raw.length < 6) continue;
      const pts = getOverlayPts(state, oIdx) as number[][];
      if (pts.length < 2) continue;
      const props = state.overlayRoadProps?.[String(oIdx)];
      const overrides = state.overlayMaterialOverrides?.[String(oIdx)];
      const merge = (raw.length & 1) === 1;
      const name = String(raw[2] ?? '');
      out.push({
        pts,
        w: raw[0] as number,
        maj: raw[1] === 1 ? 1 : 0,
        name,
        z: raw[3] as number,
        material: resolveMaterial(props?.material, name),
        age: resolveAge(props?.age, pts[0][0], pts[0][1]),
        materialOverrides: overrides,
        ...(merge ? { merge: true } : {}),
      });
    }
    // H632: tee-junction pass. For each road A's endpoints, project onto
    // every other road B's interior segments (skipping near-vertex t
    // outside 0.05..0.95). When the perpendicular distance is within
    // TEE_TOLERANCE tiles, push a {segIdx, t, radius} record onto B's
    // _teeJunctions list — the editor's _drawTeeJunctionEdgePass reads
    // these to erase the fog stripe inside the junction zone so the
    // cross-street pavement reads as "joined" to the through road
    // instead of separate slabs with hard edges where they cross.
    //
    // 1:1 with src/render/worldMap.ts:computeTeeJunctions L696-L778
    // (the constants TEE_TOLERANCE_TILES=0.5, TEE_SEG_MIN_T=0.05,
    // TEE_SEG_MAX_T=0.95, TEE_RADIUS_MIN=1, TEE_RADIUS_MAX=4,
    // TEE_DEDUP_DIST=0.3 match exactly). Cost is O(R²·S) where R is
    // road count and S is avg seg count — for Charlotte's ~118
    // baselines plus overlay roads this runs in a few ms per call,
    // acceptable since the editor only ticks on needsRedraw.
    const TEE_TOL = 0.5;
    const TEE_MIN_T = 0.05;
    const TEE_MAX_T = 0.95;
    const TEE_RMIN = 1;
    const TEE_RMAX = 4;
    const TEE_DEDUP = 0.3;
    const halfAsphaltCache: number[] = [];
    for (const r of out) {
      const lps = (r as { w: number; name?: string }).name === 'I-485' ? 3
        : r.w >= 12 ? 4 : r.w >= 8 ? 3 : r.w >= 6 ? 2 : 1;
      const medFrac = r.name === 'I-485' ? 0.25
        : r.w >= 12 ? 0.02 : r.w >= 8 ? 0.02 : 0;
      const isDivided = r.name === 'I-485' || r.w >= 12;
      const carriageW = lps * 2 * 1.275;
      const medHalf = medFrac > 0 ? carriageW * medFrac * 0.5 : 0;
      const shoulderW = isDivided ? 0.5 * 1.275 : 0;
      const asphaltW = carriageW + medHalf * 2 + 2 * shoulderW;
      halfAsphaltCache.push(asphaltW * 0.5);
    }
    for (let i = 0; i < out.length; i++) {
      const ptsA = out[i].pts;
      if (!ptsA || ptsA.length < 2) continue;
      const N = ptsA.length;
      for (const endIdx of [0, N - 1]) {
        const ax = ptsA[endIdx][0];
        const ay = ptsA[endIdx][1];
        for (let j = 0; j < out.length; j++) {
          if (i === j) continue;
          const rb = out[j];
          const ptsB = rb.pts;
          if (!ptsB || ptsB.length < 2) continue;
          const halfB = halfAsphaltCache[j];
          const M = ptsB.length;
          for (let s = 0; s < M - 1; s++) {
            const ex = ptsB[s][0];
            const ey = ptsB[s][1];
            const fx = ptsB[s + 1][0];
            const fy = ptsB[s + 1][1];
            const vx = fx - ex;
            const vy = fy - ey;
            const lenSq = vx * vx + vy * vy;
            if (lenSq < 0.01) continue;
            const t = ((ax - ex) * vx + (ay - ey) * vy) / lenSq;
            if (t < TEE_MIN_T || t > TEE_MAX_T) continue;
            const projX = ex + t * vx;
            const projY = ey + t * vy;
            const dx = ax - projX;
            const dy = ay - projY;
            if (dx * dx + dy * dy > TEE_TOL * TEE_TOL) continue;
            let list = (rb as { _teeJunctions?: Array<{ segIdx: number; t: number; radius: number }> })._teeJunctions;
            if (!list) {
              list = [];
              (rb as { _teeJunctions?: typeof list })._teeJunctions = list;
            }
            let dup = false;
            for (const tj of list) {
              // No x/y on the editor record shape — dedup via segIdx
              // matching since (segIdx, t) uniquely identifies a
              // junction point on this through road. The monolith uses
              // (x, y) Euclidean dedup; matching segIdx here is
              // equivalent because adjacent segments can't share a
              // junction within the same TEE_DEDUP_DIST without
              // hitting the SEG_MIN/MAX_T gates above first.
              if (tj.segIdx === s && Math.abs(tj.t - t) < TEE_DEDUP) {
                dup = true;
                break;
              }
            }
            if (dup) continue;
            list.push({
              segIdx: s,
              t,
              radius: Math.min(TEE_RMAX, Math.max(TEE_RMIN, halfB * 1.1)),
            });
          }
        }
      }
    }
    return out;
  };

  // Port of monolith getLaneGeom (src/render/worldMap.ts:1164). Returns
  // the editor's expected shape with H642 semantics:
  //   totalW   = carriage + median (drive surface only)
  //   asphaltW = totalW + 2*shoulderW (full visual stroke incl. shoulders)
  // Editor render.ts Pass 2 reads `prof.asphaltW ?? prof.totalW` for the
  // stroke width, so the visual stroke covers the paved shoulder.
  const getRoadProfile = (road: { pts: number[][]; w: number }) => {
    const w = road.w;
    const name = (road as { name?: string }).name ?? '';
    let lps: number;
    let medFrac: number;
    let isDivided: boolean;
    if (name === 'I-485') { lps = 3; medFrac = 0.25; isDivided = true; }
    else if (w >= 12) { lps = 4; medFrac = 0.02; isDivided = true; }
    else if (w >= 8) { lps = 3; medFrac = 0.02; isDivided = false; }
    else if (w >= 6) { lps = 2; medFrac = 0; isDivided = false; }
    else { lps = 1; medFrac = 0; isDivided = false; }
    const carriageW = lps * 2 * LANE_W_STD;
    const medHalf = medFrac > 0 ? carriageW * medFrac * 0.5 : 0;
    const shoulderW = isDivided ? 0.5 * LANE_W_STD : 0;
    const totalW = carriageW + medHalf * 2;
    const asphaltW = totalW + 2 * shoulderW;
    const dividers: number[] = [];
    for (let i = 1; i < lps; i++) {
      dividers.push(medHalf + i * LANE_W_STD);
      dividers.push(-(medHalf + i * LANE_W_STD));
    }
    // White outer fog line — for divided highways inset by full shoulder
    // so the paved breakdown shoulder is visible past the stripe (matches
    // monolith worldMap.ts:1517 `edgeOff = w*0.5 - shoulderTiles - inset`).
    // Non-divided roads have shoulderW = 0 so behavior is unchanged.
    const edgeOff = asphaltW * 0.5 - shoulderW - STRIPE_INSET;
    const edgeOffsets = [edgeOff, -edgeOff];
    // Yellow inner-edge stripes for divided highways (I-485 + w>=12 jersey
    // barrier). Position at medHalf + small inset so each stripe sits
    // just inside its carriageway's inner asphalt edge. Mirrors monolith
    // worldMap.ts:1493 `innerOff = medHalf + EDGE_STRIPE_INSET_PX/TILE`.
    const innerEdgeOffsets = isDivided
      ? [medHalf + STRIPE_INSET, -(medHalf + STRIPE_INSET)]
      : undefined;
    // H610: wear / oil offsets. Mirrors src/render/worldMap.ts:1206-1221
    // (the H561 game-port). Lane center is medHalf + (i+0.5)*LANE_W_STD;
    // wear tracks inset 0.25*LANE_W_STD from each side of the lane
    // center (4 entries per lane); oil at the lane center (1 entry per
    // lane). Empty arrays for single-lane minors so the pass no-ops.
    const wearOffsets: number[] = [];
    const oilOffsets: number[] = [];
    if (lps >= 2) {
      const wearInset = LANE_W_STD * 0.25;
      for (let i = 0; i < lps; i++) {
        const laneCenter = medHalf + (i + 0.5) * LANE_W_STD;
        wearOffsets.push(laneCenter - wearInset);
        wearOffsets.push(laneCenter + wearInset);
        wearOffsets.push(-(laneCenter - wearInset));
        wearOffsets.push(-(laneCenter + wearInset));
        oilOffsets.push(laneCenter);
        oilOffsets.push(-laneCenter);
      }
    }
    return {
      lps,
      laneW: LANE_W_STD,
      totalW,
      asphaltW,
      dividers,
      edgeOffsets,
      innerEdgeOffsets,
      wearOffsets,
      oilOffsets,
    };
  };

  // Minimal DeleteDeps shape — _weEffectiveMaterialAge only reads
  // defaultMaterial / defaultAge; the mutating fields stay no-op stubs.
  const matAgeDeleteDeps = {
    getMajorRoads,
    getBaselineLength: () => BASELINE_ROADS.length,
    getBaselineMajorRoads: () => [],
    saveBaselineEdits: () => {},
    saveOverlayToStorage: () => {},
    defaultMaterial,
    defaultAge,
    rebuildWorld: () => {},
  } as unknown as EditorDeleteDeps;

  return {
    getCanvas: () => document.getElementById('weCanvas') as HTMLCanvasElement | null,
    getStatusEl: () => document.getElementById('weStatus'),
    getMap: () => deps.ctx.tileMap.bytes,
    MAP_W,
    MAP_H,
    getMajorRoads,
    getBaselineLength: () => BASELINE_ROADS.length,
    getRoadProfile,
    TILE,
    effectiveMaterialAge: (road, segIdx) =>
      _weEffectiveMaterialAge(road as MaterialBearingRoad, segIdx, matAgeDeleteDeps),
    worldTile: {
      getMap: () => deps.ctx.tileMap.bytes,
      MAP_W,
      MAP_H,
    },
    // H641: status-composer extras. getBaselineMajorRoads slices the
    // baseline prefix off the combined list (getMajorRoads concatenates
    // baseline then overlay). defaultMaterial / defaultAge mirror the
    // resolvers used in the matAgeDeleteDeps shim above so the status
    // composer reads the same fallbacks the apply pipeline does.
    getBaselineMajorRoads: () => getMajorRoads().slice(0, BASELINE_ROADS.length),
    defaultMaterial: (r) => defaultMaterial(r as MaterialBearingRoad),
    defaultAge: (r) => defaultAge(r as MaterialBearingRoad),
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

  // H635: live rebuildWorld + snap deps + apply/persist/select deps.
  // The monolith's _weRebuildWorld saves overlay+baseline to storage
  // then rebuilds majorRoads. The modular tree's equivalent: save +
  // rebuild render entries + baseline map + minimap + road crossings.
  // Forward-declared via `let` so dDeps below can reference it before
  // the body is assigned (closure-resolves at call time).
  let rebuildWorld: () => void = () => {};

  // H637: building auto-driveway dispatcher. _weMakeDriveway needs
  // getMajorRoads + MAP_W/H + tile read/write, but the road-finding
  // pass only reads from getMajorRoads; setTile/getTile aren't touched
  // (the stamp-onto-tilemap step happens later in _weApplyOverlay).
  // We stub the tile read/write to keep the StampDeps shape complete
  // — they're no-ops on the driveway code path.
  const driveStampDeps: EditorStampDeps = {
    MAP_W,
    MAP_H,
    getTile: (x, y) => deps.ctx.tileMap.bytes[y * MAP_W + x] ?? 0,
    setTile: (x, y, v) => { deps.ctx.tileMap.bytes[y * MAP_W + x] = v; },
    getMajorRoads: () => RENDER_ENTRIES.map((e) => {
      const row = e.row;
      const pts: number[][] = [];
      for (let i = 4; i + 1 < row.length; i += 2) {
        pts.push([row[i] as number, row[i + 1] as number]);
      }
      return { pts };
    }),
  };

  // H635: shared snap deps. Used by iDeps.findSnap (per-pointer-move
  // snap) AND by the toolbar Snap button (_weSnapSelectedEndpoints).
  // Minimal-fields port of monolith getRoadProfile (L18602-18620) for
  // the merge branch — lps / laneW / totalW, the three fields the
  // lane-edge-stripe calc reads. Lane width is the v8.99.126.09
  // LANE_W_STD = 1.275. lps tiers match monolith: I-485 → 3, w>=12
  // → 4, w>=8 → 3, w>=6 → 2, else 1. One-way roads (w === 2) halve
  // the carriageway.
  const snapDeps: EditorSnapDeps = {
    getMajorRoads: () => RENDER_ENTRIES.map((e) => {
      const row = e.row;
      const pts: number[][] = [];
      for (let i = 4; i + 1 < row.length; i += 2) {
        pts.push([row[i] as number, row[i + 1] as number]);
      }
      return { pts, w: row[0] as number, name: row[2] as string };
    }),
    getRoadProfile: (road) => {
      const LANE_W_STD = 1.275;
      const w = road.w;
      const name = road.name;
      let lps: number;
      let medFrac: number;
      if (name === 'I-485') { lps = 3; medFrac = 0.25; }
      else if (w >= 12) { lps = 4; medFrac = 0.02; }
      else if (w >= 8) { lps = 3; medFrac = 0.02; }
      else if (w >= 6) { lps = 2; medFrac = 0; }
      else { lps = 1; medFrac = 0; }
      const isOneWay = (w === 2);
      const totalLanes = isOneWay ? lps : lps * 2;
      const carriageW = totalLanes * LANE_W_STD;
      const medHalf = medFrac > 0 ? carriageW * medFrac * 0.5 : 0;
      const totalW = carriageW + medHalf * 2;
      // H642: paved shoulders on divided highways. Matches monolith
      // getRoadProfile L18756-L18757 — divided highways (I-485 grass
      // median or w>=12 jersey barrier) get an extra 0.5*laneW of
      // paved shoulder on each side, bringing asphaltW to totalW + laneW.
      // Non-divided roads keep asphaltW = totalW (no shoulder concept).
      // Critical for matching the buildBaselineMap brushR = floor(w/2)
      // tile=1 footprint — without shoulders, the asphalt stroke is
      // narrower than the tile-pass road squares and the staircase
      // shows through at every edge.
      const hasRealMedian = name === 'I-485' || w >= 12;
      const shoulderW = hasRealMedian ? 0.5 * LANE_W_STD : 0;
      const asphaltW = totalW + 2 * shoulderW;
      const centers: number[] = [];
      for (let i = 0; i < lps; i++) {
        centers.push(medHalf + (i + 0.5) * LANE_W_STD);
      }
      return { lps, laneW: LANE_W_STD, totalW, asphaltW, centers };
    },
    TILE: 18,
    rebuildWorld: () => rebuildWorld(),
  };

  // H638: merge bond dispatcher. Standard / Cloverleaf / Stop / Yield
  // branches live in editor/merge/*; the dispatcher in editor/merge/index.ts
  // picks the right one based on mergeType. Before H638 this dDep was a
  // no-op (pts passed through verbatim) — merge roads committed visually
  // as a tapered polygon (via render-side taper.ts) but the polyline
  // endpoints stayed at the user's raw click positions, so the polygon
  // edge didn't pixel-perfectly land on the destination's stripe and
  // the inner-side seam read as a hard angle into the cross-road
  // instead of a smooth blend. Wiring the real bonder rewrites the
  // endpoints onto the projected lane center / edge stripe so the
  // commit geometry matches the in-flight preview.
  const mergeDeps: EditorMergeDeps = {
    getMajorRoads: () => RENDER_ENTRIES.map((e) => {
      const row = e.row;
      const pts: EditorTilePoint[] = [];
      for (let i = 4; i + 1 < row.length; i += 2) {
        pts.push([row[i] as number, row[i + 1] as number]);
      }
      return { pts, w: row[0] as number, name: row[2] as string };
    }),
    // snapDeps.getRoadProfile returns lps / laneW / totalW / centers;
    // DestProfile only reads the first three, so the extra `centers`
    // field is harmless (TypeScript-structural compat).
    getRoadProfile: snapDeps.getRoadProfile,
  };

  // H118 draft-deps. H635: rebuildWorld now points at the live rebuild
  // so a right-click commit immediately shows the new geometry in the
  // game render layer (was a no-op — overlay rows only appeared after
  // Ctrl+S). H637: makeDriveway calls _weMakeDriveway so a building
  // committed with Auto-driveway checked emits the connecting surface
  // polygon to the nearest road. H638: mergeBondEndpoints now routes
  // through _weMergeBondEndpoints (was returning pts verbatim).
  const dDeps = {
    mergeBondEndpoints: (
      pts: EditorTilePoint[],
      dW: number,
      mergeAlign: number,
      mergeType: number,
      loopDiameter: number,
    ) => _weMergeBondEndpoints(
      { pts, dW, mergeAlign, mergeType, loopDiameter },
      mergeDeps,
    ),
    makeDriveway: (buildingPts: EditorTilePoint[]) => _weMakeDriveway(buildingPts, driveStampDeps),
    rebuildWorld: () => rebuildWorld(),
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
    findSnap: (tx, ty) => _weFindSnap(tx, ty, deps.ctx.worldEditor, snapDeps),
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
      // H635: Ctrl+S body collapsed into rebuildWorld (which already
      // saves overlay + baseline edits and rebuilds entries / baseline
      // map / minimap / crossings). lastSaveAtMs lives outside since
      // it's purely the "MAP SAVED" toast trigger — rebuildWorld also
      // runs on non-save mutations and shouldn't flash the toast then.
      rebuildWorld();
      deps.ctx.worldEditor.lastSaveAtMs = Date.now();
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

  // H637: window-level touch handlers for mobile drawing. The editor
  // input handlers (_weTouchStart / Move / End) live in editor/input.ts
  // and synthesize a fake mouse-down on tap so the place/select logic
  // stays in one path (PC pointer flow). passive:false so the editor
  // can preventDefault for tap-to-place and pinch-zoom. Each guard
  // bails when the editor is inactive so game-mode touch (steering
  // wheel, pedals, menu taps) keeps owning input.
  window.addEventListener('touchstart', (e) => {
    if (!deps.ctx.worldEditor.active) return;
    _weTouchStart(e, deps.ctx.worldEditor, iDeps);
  }, { passive: false });
  window.addEventListener('touchmove', (e) => {
    if (!deps.ctx.worldEditor.active) return;
    _weTouchMove(e, deps.ctx.worldEditor, iDeps);
  }, { passive: false });
  window.addEventListener('touchend', (e) => {
    if (!deps.ctx.worldEditor.active) return;
    _weTouchEnd(e, deps.ctx.worldEditor, iDeps);
  }, { passive: false });

  // H635: real rebuildWorld body. Mirrors the monolith's _weRebuildWorld
  // (save overlay → re-apply over baseline → rebuild caches → redraw).
  // The save runs BEFORE rebuild so a crashing rebuild leaves persisted
  // state at the new shape (the user's edit survives reload). All four
  // game-side caches (render entries, baseline map bytes, minimap,
  // road crossings) refresh so a draft commit or property edit reads
  // identically in-game from this point on without a page reload.
  rebuildWorld = (): void => {
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
    _weSaveBaselineEdits(we);
    rebuildRenderEntries();
    rebuildBaselineMap(deps.ctx.tileMap);
    rebuildMinimap(deps.ctx.minimap);
    rebuildRoadCrossings(RENDER_ENTRIES.map((e) => e.row));
    we.needsRedraw = true;
  };

  // H635: toolbar deps for _weBindUI. The modular tree has no live
  // mutable baseline copy (BASELINE_ROADS is the immutable source +
  // state.baselineEdits / baselineRoadProps / baselineMaterialOverrides
  // are the sidecar overrides), so getBaselineMajorRoads synthesizes
  // an array on each read. Mutations to the returned road objects
  // are lost on the next call, but apply.ts ALSO writes to the
  // sidecar — and buildEditorRenderDeps.getMajorRoads reads back
  // from the sidecar — so the persisted side of the write survives.
  const liveDeleteDeps: EditorDeleteDeps = {
    getMajorRoads: () => editorRenderDepsCache.get(deps)?.getMajorRoads() ?? [],
    getBaselineLength: () => BASELINE_ROADS.length,
    getBaselineMajorRoads: (): EditorBaselineRoadEntry[] => {
      const state = deps.ctx.worldEditor;
      return BASELINE_ROADS.map((row, idx) => {
        const props = state.baselineRoadProps?.[String(idx)] ?? {};
        const overrides = state.baselineMaterialOverrides?.[String(idx)];
        const pts = getEditedBaselinePts(state, idx) as number[][];
        return {
          pts,
          w: row[0],
          maj: row[1],
          name: row[2],
          z: row[3],
          material: props.material as 'asphalt' | 'concrete' | undefined,
          age: props.age as 'new' | 'old' | 'auto' | undefined,
          materialOverrides: overrides,
        } as EditorBaselineRoadEntry;
      });
    },
    saveBaselineEdits: () => _weSaveBaselineEdits(deps.ctx.worldEditor),
    saveOverlayToStorage: (state) => _weSaveOverlayToStorage(
      {
        roads: state.overlay,
        surfaces: state.surfaces,
        buildings: state.buildings,
        rivers: state.rivers,
        lakes: state.lakes,
        roadProps: state.overlayRoadProps ?? {},
        materialOverrides: state.overlayMaterialOverrides ?? {},
      },
      state,
    ),
    defaultMaterial: (r) => {
      const name = (r as { name?: string }).name ?? '';
      return name === 'Driveway' ? 'concrete' : 'asphalt';
    },
    defaultAge: () => 'auto',
    rebuildWorld: () => rebuildWorld(),
  };

  const liveSelectDeps: EditorSelectDeps = {
    getMajorRoads: liveDeleteDeps.getMajorRoads,
    getBaselineLength: () => BASELINE_ROADS.length,
    getBaselineMajorRoads: liveDeleteDeps.getBaselineMajorRoads,
    saveBaselineEdits: () => _weSaveBaselineEdits(deps.ctx.worldEditor),
    rebuildWorld: () => rebuildWorld(),
    curvePoints: _weCurvePoints,
  };

  // H635: Reset (Reload Baseline) needs an immutable original snapshot
  // to revert vertex edits against. The modular tree doesn't keep one
  // (BASELINE_ROADS itself is immutable; baseline edits live in a
  // sidecar map). Stub the immutable-copy hooks for this hop — Reset
  // still clears overlay rows, baselineDeletes, and sidecar maps via
  // _weReloadBaseline's own state mutations, which covers the common
  // "throw away my edits" case. Restoring per-vertex baseline edits
  // is the follow-up.
  const liveExportDeps: EditorExportDeps = {
    getBaselineMajorRoadsOriginal: () => null,
    setBaselineMajorRoads: () => {},
    saveBaselineEdits: () => _weSaveBaselineEdits(deps.ctx.worldEditor),
    rebuildWorld: () => rebuildWorld(),
    confirm: (msg) => window.confirm(msg),
  };

  const uiDeps: EditorUiBindDeps = {
    toggleEditor: () => _weToggle(deps.ctx.worldEditor, eDeps),
    exitEditor: () => _weExit(deps.ctx.worldEditor, eDeps),
    commitDraft: () => _weCommitDraft(deps.ctx.worldEditor, dDeps),
    cancelDraft: () => _weCancelDraft(deps.ctx.worldEditor),
    deleteSelected: () => _weDeleteSelectedToolbar(deps.ctx.worldEditor, liveDeleteDeps),
    snapSelectedEndpoints: () => _weSnapSelectedEndpoints(deps.ctx.worldEditor, snapDeps),
    smoothSelectedPolygon: () => _weSmoothSelectedPolygon(deps.ctx.worldEditor, liveSelectDeps),
    applyMaterialOrAge: (field, value) => _weApplyMaterialOrAge(field, value, deps.ctx.worldEditor, liveDeleteDeps),
    readProps: () => _weReadProps(deps.ctx.worldEditor),
    exportOverlay: () => _weExport(deps.ctx.worldEditor, liveExportDeps),
    reloadBaseline: () => _weReloadBaseline(deps.ctx.worldEditor, liveExportDeps),
    // H638: bridge auto-Z. Segment-vs-segment scan of the selected
    // polyline against every other road; the highest z of any road
    // crossed wins. Bridge checkbox then sets z = max + 2 — bridge
    // over ground (z=0) gets z=2, bridge over a baseline highway
    // (z=4) gets z=6, bridge over a user bridge (z=2) gets z=4.
    // Guarantees the new bridge renders ABOVE everything it crosses
    // in the ascending-z paint order (was the v124.39 fix, monolith
    // L17070-17129). Self-cross is naturally rejected: segHit's
    // |d|<0.01 guard returns null for identical-direction segments,
    // and its (0.01, 0.99) interval excludes shared endpoints between
    // adjacent segments of the same polyline, so no explicit
    // self-skip is needed.
    computeMaxCrossedZ: (road) => {
      const myPts = road.pts;
      if (!myPts || myPts.length < 2) return 0;
      const rds = editorRenderDepsCache.get(deps)?.getMajorRoads() ?? [];
      let maxCrossedZ = 0;
      for (const r2 of rds) {
        if (!r2.pts || r2.pts.length < 2) continue;
        const r2z = r2.z || 0;
        // Quick early-out: if r2's z can't beat the current max, the
        // crossing test is irrelevant.
        if (r2z <= maxCrossedZ) continue;
        let crossed = false;
        outer: for (let a = 0; a < myPts.length - 1; a++) {
          for (let b = 0; b < r2.pts.length - 1; b++) {
            if (_segHitEditor(
              myPts[a][0],     myPts[a][1],
              myPts[a + 1][0], myPts[a + 1][1],
              r2.pts[b][0],     r2.pts[b][1],
              r2.pts[b + 1][0], r2.pts[b + 1][1],
            )) {
              crossed = true;
              break outer;
            }
          }
        }
        if (crossed) maxCrossedZ = r2z;
      }
      return maxCrossedZ;
    },
    rebuildWorld: () => rebuildWorld(),
    applyAngleToSelectedRoad: (deg) => _weApplyAngleToSelectedRoad(deg, deps.ctx.worldEditor, liveSelectDeps),
  };
  _weBindUI(deps.ctx.worldEditor, uiDeps);
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
  // H646: master `body.mob-driving` gate for the H644 wheel + H645
  // pedals + mobile SVG gauges. Visible ONLY while actually driving:
  // playing state, no pause menu / home overlay open, no gamepad
  // connected. CSS in base.css gates .steer-zone / .pedal-zone /
  // #mobileRpmSvg / #speedoSvg on this class so title / pause / menus
  // don't see the driving HUD layered on top.
  if (typeof document !== 'undefined') {
    const driving = isPlaying && !deps.ctx.menu.open && !deps.ctx.gamepad.connected;
    document.body.classList.toggle('mob-driving', driving);
  }
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
    // H602: Escape closes the home overlay too (matches monolith
    // L20809). Pause-menu Escape is handled above; this catches
    // the home-open case so the player can dismiss either modal
    // with the same key. Closes BEFORE the H key handler below so
    // Escape doesn't fight that path.
    if (e.key === 'Escape' && deps.ctx.home.open) {
      deps.ctx.home.open = false;
      resetInputState(deps.ctx);
      return;
    }
    // H602: Tab cycles pause-menu tabs (matches monolith L20825).
    // Only fires when the menu is open + no blocking inner modal
    // (DEBUG fault catalog, etc — those should pass Tab through to
    // their own scroll). Wraps around the MENU_TAB_ORDER list.
    if (e.key === 'Tab' && deps.ctx.menu.open) {
      const order = MENU_TAB_ORDER;
      const idx = order.indexOf(deps.ctx.menu.tab);
      const next = e.shiftKey
        ? order[(idx - 1 + order.length) % order.length]
        : order[(idx + 1) % order.length];
      deps.ctx.menu.tab = next;
      e.preventDefault();
      return;
    }
    // H603: PageUp / PageDown / Home / End scroll the pause-menu
    // tab content (matches monolith L20782-L20797). Useful for the
    // OPT tab's long physics-tuning + audio + DEBUG fault list
    // where the wheel-scroll alone takes a lot of spinning to
    // reach the bottom. 80%-page jumps for PageUp/Down, full
    // jumps to top/bottom for Home/End.
    if (deps.ctx.menu.open && deps.ctx.life) {
      const life = deps.ctx.life as { _menuTabScrollY?: number; _menuTabScrollMax?: number };
      const max = life._menuTabScrollMax ?? 0;
      const cur = life._menuTabScrollY ?? 0;
      const pageStep = deps.hudCanvas.height * 0.8;
      if (e.key === 'PageUp') {
        life._menuTabScrollY = Math.max(0, cur - pageStep);
        e.preventDefault();
        return;
      }
      if (e.key === 'PageDown') {
        life._menuTabScrollY = Math.max(0, Math.min(max, cur + pageStep));
        e.preventDefault();
        return;
      }
      if (e.key === 'Home') {
        life._menuTabScrollY = 0;
        e.preventDefault();
        return;
      }
      if (e.key === 'End') {
        life._menuTabScrollY = max;
        e.preventDefault();
        return;
      }
    }
    // H596: M key toggles the pause menu (matches monolith L20726).
    // Suppressed when any blocking modal is up so M doesn't fight
    // those overlays for input.
    if (
      (e.key === 'm' || e.key === 'M')
      && deps.ctx.gameState === 'playing'
      && !deps.ctx.home.open
      && !deps.ctx.life?.fuelMenuOpen
      && !deps.ctx.life?.sellerVisit
      && !deps.ctx.life?.realtorVisit
      && !deps.ctx.life?.purchaseMenu
      && !deps.ctx.life?.towMenuOpen
      && !deps.ctx.life?.bankLoanOffer
      && !deps.ctx.life?.officeMenu
    ) {
      deps.ctx.menu.open = !deps.ctx.menu.open;
      if (deps.ctx.menu.open) {
        deps.ctx.menu.tab = 'car';
        resetInputState(deps.ctx);
      }
      e.preventDefault();
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
          fillNewspaperListings(life, deps.ctx.clock.day, deps.ctx.tileMap);
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

    // H590: C key toggles cruise control. Edge-triggered, playing
    // state only. Requires forward motion to engage (no point
    // capping speed when stopped or reversing). Per-tick
    // applyCruiseSpeedCap reads the flag; brake auto-disable in
    // the per-frame tick handles deadman cancel.
    if ((e.key === 'c' || e.key === 'C') && deps.ctx.gameState === 'playing' && !e.repeat) {
      const p = deps.ctx.player;
      if (p.cruiseOn) {
        p.cruiseOn = false;
        if (deps.ctx.life) setNotifState(deps.ctx.life, '🚗 CRUISE OFF', 120);
      } else if (p.pSpeed > 0) {
        p.cruiseOn = true;
        if (deps.ctx.life) setNotifState(deps.ctx.life, '🚗 CRUISE ON', 120);
      } else {
        if (deps.ctx.life) setNotifState(deps.ctx.life, '🚗 Cruise needs forward motion', 120);
      }
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

/** H647: wire the mobile gear shifter to the same gear-bump logic the
 *  keyboard `e` / `q` shortcuts use (installKeyboard at L1411-L1426).
 *  Each swipe past 12 px on #shiftKnob (or a non-swipe tap, which shifts
 *  toward the touch half) fires this with dir = ±1.
 *
 *  Mirrors monolith doShift (L23515-L23542) — bump manualGear, refresh
 *  manualGearTimer to 4 s, clamped to [1, car.gears]. Skips in non-
 *  playing states. */
function installShifterBindings(deps: GameLoopDeps): void {
  installShifter((dir) => {
    if (deps.ctx.gameState !== 'playing') return;
    const carId = deps.ctx.life?.ownedCars[0];
    const car = carId ? CAR_CATALOG[carId] : undefined;
    if (!car) return;
    const cur = deps.ctx.player.manualGear ?? deps.ctx.player.prevGear;
    const next = Math.max(1, Math.min(car.gears, cur + dir));
    deps.ctx.player.manualGear = next;
    deps.ctx.player.manualGearTimer = 4;
  });
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

  // H645: include the mobile slider-pedal amounts. addSliderPedal writes
  // 0..1 analog to module-scoped state; OR into the boolean inputs so
  // arcadeUpdate / phase0BAdapter / skidMarks (all boolean gas/brake
  // readers) fire while the pedal is pressed. Threshold 0.02 matches
  // the gamepad trigger deadzone for symmetry.
  const pedalGas = getPedalGasAmount();
  const pedalBrake = getPedalBrakeAmount();
  ctx.input.gas   = held.gas   || (gpOn && gp.gas   > GP_TRIGGER_DEADZONE) || (pedalGas   > GP_TRIGGER_DEADZONE);
  ctx.input.brake = held.brake || (gpOn && gp.brake > GP_TRIGGER_DEADZONE) || (pedalBrake > GP_TRIGGER_DEADZONE);
  ctx.input.ebrk  = held.ebrk  || (gpOn && (gp.a || gp.lb));

  const kbSteer = (held.steerRight ? 1 : 0) - (held.steerLeft ? 1 : 0);
  // H644: priority — gamepad analog > touch wheel > keyboard booleans.
  // Wheel returns -1..+1 while a drag is active, null when idle so the
  // keyboard / gamepad paths take over cleanly on release.
  const wheelAxis = getWheelSteerAxis();
  if (gpOn && Math.abs(gp.steer) > GP_STEER_DEADZONE_DRIVE) {
    const curved = Math.sign(gp.steer) * Math.pow(Math.abs(gp.steer), GP_STEER_CURVE);
    ctx.input.steerAxis += (curved - ctx.input.steerAxis) * GP_STEER_BLEND_RATE * dt;
  } else if (wheelAxis !== null) {
    ctx.input.steerAxis = wheelAxis;
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
  // === H502: Phase 0B integrator branch dispatcher ===
  // When the feature flag (LIFE.gameplaySettings.bicycleModel +
  // .dynPhysics0B) is on AND eligibility passes (GT4 car, dynPhysics0B
  // enabled, sufficient speed, etc.), the integrator owns this frame's
  // px/py/pAngle/pSpeed updates and arcadeUpdate is skipped. When the
  // flag is off OR the integrator deferred (low speed, bike, drift +
  // !dynPhysics0B, missing activeCar / life), the arcadeUpdate path
  // below runs as before.
  //
  // The integrator's chassis-frame setup (Phase 1) runs even on
  // ineligible frames so pFzTransfer + pPrevSpeed stay current — the
  // adapter's tookOwnership flag specifically tracks whether the
  // integrator advanced motion fields.
  //
  // Feature flag defaults OFF (neither bicycleModel nor dynPhysics0B
  // is set in fresh saves), so out-of-the-box behavior is unchanged
  // until the player opts in via the pause-menu physics toggles (when
  // those land — currently dynPhysics0B + bicycleModel can be flipped
  // by editing the save file or via dev console).
  let phase0BOwned = false;
  if (activeCar && ctx.life && shouldUsePhase0B(ctx.life)) {
    const result = runPhase0BTick(
      player,
      ctx.input,
      ctx.frame.dt,
      activeCar,
      ctx.life,
      ctx.tileMap,
      ctx.faultEffects,
    );
    phase0BOwned = result.tookOwnership;
  }
  if (!phase0BOwned) {
    arcadeUpdate(
      player,
      ctx.input,
      ctx.frame.dt,
      onRoad,
      activeCar?.redline ?? Infinity,
      _torqueMult,
      _gearMult,
      // H585: clamp the catalog topSpeed by the OPT Top Speed Cap
      // slider (km/h ceiling, range 250-450). Cap stays the
      // catalog default when the OPT slider is unset.
      effectiveTopSpeed(activeCar, ctx.life),
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
      // H582: live OPT steering-sensitivity slider. Reads
      // gameplaySettings.padSteerSens (modular only has
      // keyboard+gamepad input today; touchSteerSens routes when
      // touch input ports). Defaults 1.0 = no scaling.
      (() => {
        const raw = ctx.life?.gameplaySettings?.padSteerSens;
        if (typeof raw !== 'number' || raw <= 0) return 1.0;
        return Math.max(0.5, Math.min(2.0, raw));
      })(),
    );
  }

  // H590: cruise control speed cap + auto-disable on brake.
  // Runs AFTER arcadeUpdate (or the Phase 0B integrator's
  // ownership branch) so the cap applies whichever physics path
  // owned the tick. Brake-press auto-cancel matches every real
  // car's deadman behavior so the player can always slow down
  // without fighting the cruise lock. Reverse (pSpeed<0) bypasses
  // the cap path entirely — applyCruiseSpeedCap returns pSpeed
  // unchanged for negative speeds.
  if (player.cruiseOn) {
    if (cruiseShouldAutoDisable(true, ctx.input.brake)) {
      player.cruiseOn = false;
      if (ctx.life) setNotifState(ctx.life, '🚗 CRUISE OFF — brake', 120);
    } else {
      const speedLimitMphNow = playerSpeedLimitWpx(player.px, player.py) / MPH_TO_WPX;
      player.pSpeed = applyCruiseSpeedCap(
        player.pSpeed, true, speedLimitMphNow, SCALE_MS,
      );
    }
  }
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
      // H78: per-frame wear tick. 1:1 port of monolith L42029-L42037.
      // H184 tightened the guard to `spd>5 && !broken`. wearMult
      // ramps: new car (0mi)=1×, 100k=2×, 200k=3× — accelerates wear
      // on used cars so a high-mileage beater eats stats faster.
      //
      // H527: closed two H78-era deferrals —
      //   * engineWearMult fault multiplier: ctx.faultEffects
      //     populates this via H248's wiring. timing_belt /
      //     oil_leak / valve_cover_gasket and the other
      //     engine-wear faults (each carries an engineWearMult >
      //     1.0 in FAULT_EFFECTS) now correctly accelerate engine
      //     degradation in real time. Identity (1.0) for fault-
      //     free play, so no behavior change when faults absent.
      //   * pDrifting drift-bonus wear: player.drifting is now
      //     populated by either H156's arcade-tier proxy
      //     (ebrk + speed + steer heuristic) or H501's Phase 0B
      //     adapter (state.pDrifting from the hysteretic 0.26/0.10
      //     rad classifier). H506 prevents the arcade proxy from
      //     clobbering the Phase 0B value, so reads here see the
      //     authoritative drift state regardless of which physics
      //     path owned the frame. Drift wear is additive (separate
      //     from the speed-based base wear): tires -= 0.01·dt,
      //     carHP -= 0.005·dt, paint -= 0.003·dt — meaningful
      //     erosion at full drift, rewards careful play.
      const _spd = Math.abs(player.pSpeed);
      if (_spd > 5 && !ctx.life.broken) {
        const _odoMi = gameUnitsToMiles(ctx.life.carOdometers?.[_activeCarId] ?? 0);
        const _wearMult = 1 + _odoMi / 100000;
        const _dt = ctx.frame.dt;
        const _engWear = ctx.faultEffects.engineWearMult;
        ctx.life.tires  = Math.max(0, ctx.life.tires  - 0.001  * _spd * _dt * _wearMult);
        ctx.life.engine = Math.max(0, ctx.life.engine - 0.0005 * _spd * _dt * _wearMult * _engWear);
        ctx.life.paint  = Math.max(0, ctx.life.paint  - 0.0001 * _spd * _dt * _wearMult);
        // Drift-bonus wear (1:1 with monolith L42035). Fires
        // alongside the base wear; total per-frame degradation =
        // base + drift when both gates fire.
        if (player.drifting) {
          ctx.life.tires = Math.max(0, ctx.life.tires - 0.01 * _dt);
          ctx.life.carHP = Math.max(0, ctx.life.carHP - 0.005 * _dt);
          ctx.life.paint = Math.max(0, ctx.life.paint - 0.003 * _dt);
        }
        // H535: wear-tick fault diagnosis. After the base + drift
        // wear has mutated this frame's stats, the six threshold
        // checks at monolith L42041-L42046 fire — each one rolls
        // a fault from FAULT_POOLS via diagnoseFault when its stat
        // crosses 40 (normal) or 15 (severe). The gate logic in
        // diagnoseFault (one-per-stat normal / max-two severe)
        // makes the calls fire-and-forget — most frames after the
        // first cross are silent no-ops because the stat-gate
        // rejects re-entry. Active car's origin + mileage tier
        // are passed in deps so the modular sim layer keeps its
        // global-free discipline.
        const _activeCar = CAR_CATALOG[_activeCarId];
        if (_activeCar) {
          const _faultDeps = {
            faults: ctx.life.faults as { id: string; stat: string }[],
            origin: _activeCar.origin,
            mileageTier: getMileageTier(ctx.life.carOdometers?.[_activeCarId] ?? 0),
            notify: (msg: string) => setNotifState(ctx.life!, msg),
          };
          if (ctx.life.engine < 40) diagnoseFault(_faultDeps, 'engine');
          if (ctx.life.tires  < 40) diagnoseFault(_faultDeps, 'tires');
          if (ctx.life.carHP  < 40) diagnoseFault(_faultDeps, 'hp');
          if (ctx.life.engine < 15) diagnoseFault(_faultDeps, 'engine', true);
          if (ctx.life.tires  < 15) diagnoseFault(_faultDeps, 'tires',  true);
          if (ctx.life.carHP  < 15) diagnoseFault(_faultDeps, 'hp',     true);
        }
        // H528: hidden-fault reveal — used cars carry hidden
        // PreFault rows in life._hiddenFaults from the seller-
        // visit / inspection flow. Each fault surfaces after
        // ~500-2000 game units of driving since the last reveal.
        // Returns the revealed fault's name so we can show the
        // monolith's '⚠ HIDDEN ISSUE FOUND' notif. 1:1 with
        // monolith L42038-L42049.
        const _curOdo = ctx.life.carOdometers?.[_activeCarId] ?? 0;
        const _reveal = tickHiddenFaultReveal(ctx.life, _curOdo);
        if (_reveal) {
          setNotifState(ctx.life, '⚠ HIDDEN ISSUE FOUND: ' + _reveal.name);
        }
        // H536: per-frame breakdown roll. Fires AFTER the H528
        // hidden-fault reveal so the inner diagnoseFault call sees
        // any newly-revealed hidden faults in its dedupe set —
        // matches monolith ordering at L42041 (diagnose) → L42048
        // (hidden) → L42059 (breakdown roll). Reuses the H535
        // _activeCar lookup; passes the same origin + tier so the
        // cause-tagged diagnose sub-call (impact/ignition/cooling)
        // rolls from the same regional pool the threshold-cross
        // diagnose calls do. Skipped on catalog-miss; the enclosing
        // spd>5 && !broken guard already prevents re-roll while
        // a breakdown is active.
        if (_activeCar) {
          maybeRollBreakdown({
            life: ctx.life,
            odoMi: _odoMi,
            wearMult: _wearMult,
            origin: _activeCar.origin,
            mileageTier: getMileageTier(_curOdo),
            notify: (msg: string) => setNotifState(ctx.life!, msg),
          });
        }
      }
      // H557: OUT OF GAS breakdown trigger. Closes the gap between
      // arcadeUpdate's fuel-burn (decrements player.fuel) and the
      // H529 tickBreakdownRecovery's out-of-gas tow gate (gated
      // on life.broken). Fires once per fuel-out event (idempotent
      // via !life.broken). Sits BEFORE tickBreakdownRecovery so
      // when fuel hits 0 the recovery sees broken=true on the same
      // frame and flips towMenuOpen — matches monolith ordering
      // at L42021-L42027 (fuel check) → L42090+ (recovery). Notif
      // is the explicit 'OUT OF GAS!' string the player sees once.
      const _oog = checkOutOfGas(ctx.life, player);
      if (_oog) setNotifState(ctx.life, _oog.notif);
      // H529: breakdown recovery tick — ENGINE STALL counts the
      // 3-sec timer down to an auto-restart (if engine/tires/fuel
      // all > floor) or a tow-required notif. Also handles the
      // out-of-gas immediate-tow gate. Runs OUTSIDE the spd>5
      // wear-guard above because breakdown can be active at zero
      // speed (post-stall coast, post-flat halt). 1:1 with
      // monolith L42090-L42112.
      // H598: advance the incoming-tow truck through its
      // arriving/reversing/loading/departing phases. The towMenu
      // modal seeds life.incomingTow; without this tick the truck
      // sits in 'arriving' forever and the player stays stranded.
      // Runs BEFORE breakdownRecovery so the depart-phase warp-home
      // clears life.broken before the recovery tick reads it.
      tickIncomingTow(ctx.life, ctx.player, ctx.frame.dt);
      const _recovery = tickBreakdownRecovery(ctx.life, ctx.frame.dt);
      if (_recovery?.kind === 'restarted') {
        setNotifState(ctx.life, 'Car restarted...');
      } else if (_recovery?.kind === 'tow-required' && ctx.life.fuel > 0) {
        // The out-of-gas immediate-tow branch (fuel<=0) doesn't
        // get a notif in the monolith — the prior 'OUT OF GAS'
        // notif from the breakdown roll covers it. Only the
        // can't-restart-from-stall path surfaces a fresh notif.
        setNotifState(ctx.life, "Car won't start. Call a tow truck.");
      }
    }
  }
  // H547: sessionTimer per-frame increment. Drives the headlight
  // ambient transitions in render/headlightShadows.ts (dawn/dusk
  // tints keyed off seconds-within-slot). Gated on !home.open so
  // pausing on the home screen freezes the tint — matches monolith
  // L42001-42002 which gates on `dayPhase==='driving'||'jobActive'`.
  // sessionTimer resets to 0 in doSleep/doRelax on every slot
  // advance + day rollover (H547 wires those).
  if (ctx.life && !ctx.home.open && !ctx.fullMapOpen) {
    ctx.life.sessionTimer = (ctx.life.sessionTimer || 0) + ctx.frame.dt;
  }
  // H556: removed H553's per-frame `life.fuel = player.fuel * 100`
  // sync — it clobbered legitimate life.fuel writes from
  // completePurchase / applyRaceResult / swapToJobVehicle /
  // startTestDrive / applyStartingCarChoice, all of which set
  // life.fuel directly (and don't touch player.fuel). The fix
  // moved to two targeted sync points: (a) right before
  // drawPauseMenu in this same loop so the STATUS tab fuel%
  // reads fresh, (b) inside switchCar before saveCarCondition
  // so the car-swap snapshot captures the live burn-adjusted
  // value. See H553 commit for the bugs the sync was originally
  // meant to fix.
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
  // H594: gas-station menu trigger — when the player slows to a
  // stop within station range with fuel below 98 %, open the
  // fuel/paint/mech modal so they can pick a grade or buy
  // services. Previously life.fuelMenuOpen was only ever set to
  // FALSE (by the modal's LEAVE STATION button) and the modal
  // surfaces (FUEL grades, factory respray swatches, mechanic
  // services) were completely unreachable in the modular tree.
  // Edge-trigger only — once the menu's open we leave it alone so
  // the player can re-LEAVE without it instantly re-opening, and
  // re-arm when they drive away (refuelingAt → null). The
  // ctx.audio.wasRefuelingLast latch (just below) tracks that
  // edge and serves double-duty as the re-arm flag.
  if (
    refuelingAt
    && !ctx.audio.wasRefuelingLast
    && ctx.life
    && !ctx.life.fuelMenuOpen
    && !ctx.menu.open
    && !ctx.life.homeScreenOpen
    && player.fuel < 0.98
  ) {
    // Sync life.fuel (0..100 percent) from player.fuel (0..1
    // decimal) BEFORE opening the modal so it reads the current
    // tank level. arcadeUpdate burns player.fuel each frame but
    // never touches life.fuel, so without this sync the modal's
    // 'X% full' header would render a stale value.
    ctx.life.fuel = player.fuel * 100;
    ctx.life.fuelMenuOpen = true;
    ctx.life.stationTab = 'fuel';
    player.pSpeed = 0;
  }
  // H594: when the modal closes (player tapped LEAVE STATION or
  // picked a grade and refueled), sync player.fuel back from
  // life.fuel so the runtime burn pool picks up the refuel.
  // Without this the player.fuel value would be the pre-modal
  // amount and arcadeUpdate would keep draining as if they
  // hadn't refueled.
  if (
    ctx.life
    && !ctx.life.fuelMenuOpen
    && Math.abs(player.fuel - ctx.life.fuel / 100) > 0.01
    && ctx.life.fuel > player.fuel * 100
  ) {
    player.fuel = Math.max(0, Math.min(1, ctx.life.fuel / 100));
  }
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
    // H517: rep-based raise/promotion chance — fires after pay+bills
    // settle so this month's salary lands at the OLD multiplier and
    // next month picks up the new one. Matches monolith ordering at
    // L47020-L47022 where triggerMonthlyBills runs first, then
    // checkMonthlyRaise. On a hit, surface the raise notif.
    const raise = checkMonthlyRaise(ctx.life, ctx.clock.day);
    if (raise) {
      setNotifState(
        ctx.life,
        '💰 RAISE! Pay now ' + raise.payPercent + '% of base. Rep: ' + raise.workRep,
      );
    }
  }
  // H36: refresh the classifieds when the day rolls over via the real
  // clock tick (not just the dev N-key path).
  if (ctx.life && prevDay !== ctx.clock.day) {
    // H551: sync life.day to clock.day FIRST so downstream
    // day-rollover consumers (decayStreetRep reads
    // life.day - life.lastRaceDay; credit log timestamps
    // via life.day) see the new value. life.day is otherwise
    // only set on save-load — without this sync it stays at
    // whatever it loaded as / defaulted to (1) forever, which
    // silently broke decayStreetRep's "days since last race"
    // gate (always returned a large number → constant decay
    // even when the player raced yesterday) and stamped credit
    // log entries with an obsolete day.
    ctx.life.day = ctx.clock.day;
    // H215: per-day health/fitness update fires BEFORE we clear
    // the daily latches — it reads ateToday / daysSinceEat /
    // slotsActiveToday / gymVisitedToday / daysSinceSleep before
    // they get reset. Mirrors monolith's lifeSimTick day-rollover
    // ordering (health-update before latch-clears at L42xxx).
    updateDailyHealth(ctx.life);
    // H518: silent street-rep decay if the player hasn't raced in
    // 7+ days. High-tier (rep>50) decays 2/day, low-tier 1/day.
    // No notif by monolith convention — the underground-scene
    // erosion is meant to be noticed by glancing at the rep
    // counter, not announced. Mirrors monolith L47024.
    decayStreetRep(ctx.life);
    // H519: connection-milestone tick. Flips the four "you're
    // recognized" booleans (mechanicDiscount / dispatcherTrust /
    // sceneRegular / localDeals) once their thresholds are crossed
    // + increments neighborhoodDays. All silent — player notices
    // when prices drop / better jobs appear / deal-tagged
    // listings show up in the newspaper. Mirrors monolith L47025.
    updateConnections(ctx.life);
    // H544: Friday payday. Runs BEFORE the H521 notif so the notif
    // can surface the PAYDAY breakdown when the payout fires. No-op
    // except on Fridays with pendingSalary > 0 (idempotent via the
    // pendingSalary reset). 1:1 with monolith L46973-L46986. The
    // accumulator side (which feeds pendingSalary) fires inside
    // doSleep/doRelax's day-rollover branch.
    const _payday = runFridayPayout(ctx.life, ctx.clock.day);
    // H546: W-2 year-end rollover. Fires once per in-game year on
    // the day gameYearFor advances. Snapshots YTD totals and zeroes
    // them. The notif emission lives AFTER the H521 notif below
    // (both call setNotifState which overwrites) so the rare W-2
    // string wins over the everyday DAY N header on the year-
    // boundary day. The runFridayPayout above already deposited
    // any pending paycheck so the W-2 reflects the closing year's
    // full earnings. 1:1 with monolith advanceCalendarDay's
    // year-wrap block at L46487-L46498.
    const _w2 = runYearRolloverW2(ctx.life, ctx.clock.day);
    // H521: day-rollover notif. Three branches mirror monolith L47028-
    // L47038: unemployed players get the explicit "Check JOBS tab"
    // prompt; PAYDAY shows gross / tax / net breakdown when the
    // H544 payout fired; everyone else gets the plain "DAY N — DOW
    // MON DD" header. Notif fires BEFORE the latch-clears so
    // jobDoneToday / job state isn't wiped before the format string
    // can read it.
    {
      const dateStr = getDateString(ctx.clock.day);
      if (!ctx.life.playerJob) {
        setNotifState(
          ctx.life,
          'DAY ' + ctx.clock.day + ' — ' + dateStr + ' | Unemployed. Check JOBS tab.',
        );
      } else if (_payday) {
        setNotifState(
          ctx.life,
          'DAY ' + ctx.clock.day + ' — 💰 PAYDAY +$' + _payday.net
            + ' (gross $' + _payday.gross + ', tax -$' + _payday.tax + ')',
        );
      } else {
        setNotifState(ctx.life, 'DAY ' + ctx.clock.day + ' — ' + dateStr);
      }
      // H546: W-2 notif emission — sits AFTER the H521 notif so the
      // rare year-end string wins on the year-boundary day.
      if (_w2) {
        setNotifState(
          ctx.life,
          '📋 W-2: Gross $' + _w2.gross.toLocaleString()
            + ' • Tax -$' + _w2.tax.toLocaleString()
            + ' (' + _w2.effectivePct + '%)',
        );
      }
    }
    // H545: pin expiry. Runs BEFORE fillNewspaperListings so the
    // isPinned clear lands on the source listing in time for the
    // same rollover's fillNewspaper to drop it via the standard
    // expiry path. Per-pin "SOLD!" notif fires here too — matches
    // monolith expireCarPins call order at L47013 (just above
    // fillNewspaper at L47014).
    expireCarPins(ctx.life, ctx.clock.day, (msg) => setNotifState(ctx.life!, msg));
    fillNewspaperListings(ctx.life, ctx.clock.day, ctx.tileMap);
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
    // H544: clear today's "salary already accrued" latch so the
    // accumulator can fire again next day.
    ctx.life.dailyPaid = false;
    // H214: also clear the time-slot used latches + reset to
    // morning so the new day starts cleanly. doSleep already does
    // this on its day-roll branch; this catches the case where
    // clock.day++ fires from elsewhere (real-clock tick at
    // midnight, dev N-key skip).
    ctx.life.slotsUsed = { morning: false, afternoon: false, night: false };
    ctx.life.timeSlot = 'morning';
    ctx.life.slotsActiveToday = 0;
    // H552: also reset sessionTimer here. H547 wired the reset
    // inside doSleep/doRelax (which is the dominant slot/day
    // transition path); this catches the day-rolled-via-real-
    // clock-or-N-key case where doSleep didn't fire. Without
    // this, a player who drives through all three slots without
    // sleeping carries the prior day's accumulated sessionTimer
    // into the new morning and the headlightShadows ambient
    // transitions skip their dawn window entirely. 1:1 with
    // monolith L47007 which resets unconditionally on day-roll.
    ctx.life.sessionTimer = 0;
    // H525: v8.98.50 per-day office flags. Mirror monolith
    // L46996-L46998 inside doSleep's all-slots-done block:
    //   - officeLeaveEarly: cleared so tomorrow's pay isn't
    //     auto-capped at 60% (the daily-salary accrual path
    //     reads this when it ports; safe to reset early).
    //   - coffeeBuff: sleeping always flushes remaining coffee
    //     (matches reality). H524 added the slot-fade decrement
    //     so coffee normally exhausts naturally during the day;
    //     this clears any stragglers + the edge case where the
    //     day rolls from a non-sleep path (real-clock midnight,
    //     N-key dev skip).
    ctx.life.officeLeaveEarly = false;
    ctx.life.coffeeBuff = 0;
    // H526: FOOD DELIVERY daily perk — +1 regular meal stocked
    // automatically. 1:1 with monolith L46990-L46992 inside doSleep's
    // all-slots-done branch (the food-bonus block, fires alongside
    // pendingSalary=0 + officeLeaveEarly=false + coffeeBuff=0).
    // FOOD DELIVERY's base pay is symbolic ($2-10/tip per the
    // jobs roller); this bonus is the actual career perk that
    // makes the role viable — a free meal keeps daysSinceEat
    // from advancing without spending cash.
    if (ctx.life.playerJob === 'FOOD DELIVERY') {
      ctx.life.foodStock.regular = (ctx.life.foodStock.regular || 0) + 1;
    }
    // H576: daily car-ad tick — bumps daysListed on each active ad
    // and rolls a fresh offer on weekdays. Mirrors monolith
    // generateCarAdOffers L43745 firing inside the day-rollover
    // branch. Offers also mirror into life.mail so the H568 MAIL
    // tab badge picks them up.
    generateCarAdOffers(ctx.life);
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
  const collision = tickTrafficCollisions(player, ctx.traffic, ctx.life ?? undefined);
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

  // H600: wall-collision sparks. Phase 0B records the per-tick
  // collision classification (H595) into player.phase0B; gameLoop
  // is the right place to fire visual side effects since the
  // adapter is purposely physics-only. Severity scales with the
  // pre-collision pSpeed exactly the same way the crash sound
  // does (H595) so the spark burst's intensity matches the audio.
  // Bounce gets the same +0.25 floor as the audio so head-on hits
  // at parking speed still spark visibly.
  const _wallHit = player.phase0B?.lastCollisionImpact;
  if (_wallHit && _wallHit !== 'none') {
    const _MAX_SPEED_FOR_FX = 200;
    const _spd = player.phase0B?.lastCollisionPSpeed ?? 0;
    const _sev = Math.min(1, _spd / _MAX_SPEED_FOR_FX);
    const _impactDmg = _wallHit === 'bounce' ? Math.max(0.25, _sev) : _sev;
    if (_impactDmg > 0.05) {
      spawnCrashSparks(ctx.particles, player.px, player.py, _impactDmg);
    }
    // H605: per-zone body damage on wall hits. Phase 0B doesn't
    // expose the wall normal — but the impact classification gives
    // us a usable approximation:
    //   - 'bounce' = head-on into something in front → frontBumper
    //   - 'slide'  = side scrape along a wall → hood (cosmetic side
    //                of front; doesn't break into door/quarter
    //                since the slide doesn't carry rotational
    //                information about which side scraped)
    // Damage magnitude scales with pre-collision speed × 30 (same
    // as H597 traffic). Slides get scrape damage; bounces get full
    // impactDmg so a head-on at speed cracks the bumper.
    if (ctx.life && _sev > 0.03) {
      const _dmg = _sev * 30;
      if (_wallHit === 'bounce') {
        applyZoneDamage(ctx.life, 'frontBumper', _dmg, 0);
      } else {
        // slide
        applyZoneDamage(ctx.life, 'hood', _dmg * 0.4, _dmg * 0.6);
      }
    }
  }

  // H229: rumble-strip detection. Light pulses at ~10 Hz when the
  // player drifts off the road line but the road is still a few
  // pixels away — like real highway rumble strips. Skips when
  // parked-ish (low pSpeed). Uses Date.now() for the cadence
  // clock so the pulses fire at wall-clock rate regardless of
  // frame variation.
  tickRumbleStrip(ctx.tileMap, player.px, player.py, player.pSpeed, Date.now());
  // H509: wreck-smoke plume from the hood when the car is broken.
  // ~1 Hz emission gated on LIFE.broken; reads as slow rising smoke
  // rather than a dense burst (the 1Hz cadence is from monolith
  // L31831 _lastWreckSmokeT > 950ms gap). Hood anchor = 35 % of the
  // car's body length forward of CG along heading; default 6 gu when
  // no activeCar (pre-LIFE start-flow path won't hit this since
  // ctx.life is also undefined then, but the fallback keeps the math
  // finite). Matches monolith L31822-L31836.
  if (ctx.life?.broken) {
    const wreckNow = Date.now();
    if (wreckNow - ctx.particles.lastWreckSmokeMs > 950) {
      const _hoodOff = (activeCar?.size?.[0] ?? 6) * 0.35;
      const _hx = player.px + Math.cos(player.pAngle) * _hoodOff;
      const _hy = player.py + Math.sin(player.pAngle) * _hoodOff;
      spawnWreckSmoke(ctx.particles, _hx, _hy);
      ctx.particles.lastWreckSmokeMs = wreckNow;
    }
  }
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
    // H599: minimal incoming-tow marker so the player can see the
    // AI tow truck during arriving/reversing/loading/departing. The
    // full drawIncomingTow render (render/tow.ts) has a signature
    // mismatch with the modular drawTopCar — wiring the proper
    // truck sprite needs a separate adapter hop. This placeholder
    // gives visible feedback (a yellow disc with status text) so
    // the player knows the truck is en route. Reads the same
    // life.incomingTow state the tick (H598) advances each frame.
    const itw = ctx.life.incomingTow as {
      x: number; y: number; angle: number; phase: string;
      loadProg: number;
    } | undefined | null;
    if (itw) {
      const it = itw;
      mainCtx.save();
      mainCtx.translate(it.x, it.y);
      mainCtx.rotate(it.angle);
      // Truck silhouette (yellow rectangle pointing forward).
      mainCtx.fillStyle = '#e8c840';
      mainCtx.fillRect(-19, -6, 38, 12);
      mainCtx.strokeStyle = '#000';
      mainCtx.lineWidth = 0.5;
      mainCtx.strokeRect(-19, -6, 38, 12);
      // Bed cap.
      mainCtx.fillStyle = '#aa8820';
      mainCtx.fillRect(-19, -4, 18, 8);
      mainCtx.restore();
      // Amber flashers (~2.5 Hz).
      if (Math.floor(Date.now() / 400) % 2 === 0) {
        mainCtx.fillStyle = '#ff8800';
        mainCtx.globalAlpha = 0.85;
        mainCtx.beginPath();
        mainCtx.arc(it.x, it.y, 2.5, 0, Math.PI * 2);
        mainCtx.fill();
        mainCtx.globalAlpha = 1;
      }
      // Status label above the truck.
      mainCtx.fillStyle = '#ff0';
      mainCtx.font = 'bold 5px monospace';
      mainCtx.textAlign = 'center';
      const status = it.phase === 'arriving'  ? 'TOW TRUCK COMING'
                   : it.phase === 'reversing' ? 'POSITIONING'
                   : it.phase === 'loading'   ? 'LOADING ' + Math.round(it.loadProg * 100) + '%'
                   :                            'TOWING AWAY';
      mainCtx.fillText(status, it.x, it.y - 12);
      mainCtx.textAlign = 'left';
    }
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

  // H601: brake-light + reverse-light halos at the player's rear
  // corners. drawTopCar paints 1.5×2 px solid rectangles for the
  // lamp bulbs (drawTopCar.ts L477-L482) — visible up close but
  // they don't read at game-scale, especially during the day.
  // These radial-gradient halos make brake checks and reverse
  // lights clearly visible from a few car lengths away. Simpler
  // than the full drawPlayerTaillights pipeline (no occluder mask
  // / bridge punch / trailer reach) but the visible effect is the
  // same — red glow when braking, warm-white when reversing,
  // ambient red when night + running. Skipped for bikes (one
  // central tail lamp, not corner pair).
  if (!_carIsBike) {
    const _tlBaseAlpha = 0.18 + nightVis * 0.35;
    const _brake = ctx.input.brake && !player.pRevIntent;
    const _rev = player.pRevIntent;
    if (_brake || _rev || nightVis > 0.15) {
      const _tlCx = player.px - Math.cos(player.pAngle) * _carHalfLen;
      const _tlCy = player.py - Math.sin(player.pAngle) * _carHalfLen;
      const _perpCos = Math.cos(player.pAngle + Math.PI / 2);
      const _perpSin = Math.sin(player.pAngle + Math.PI / 2);
      const _tlOff = _carHalfW * 0.72;
      for (const _s of [-1, 1] as const) {
        const _lx = _tlCx + _perpCos * _s * _tlOff;
        const _ly = _tlCy + _perpSin * _s * _tlOff;
        // Running lights: dim red, always on at night.
        if (nightVis > 0.05) {
          const _runR = 3.5;
          const _g = mainCtx.createRadialGradient(_lx, _ly, 0, _lx, _ly, _runR);
          _g.addColorStop(0, `rgba(255,40,20,${nightVis * 0.28})`);
          _g.addColorStop(1, 'rgba(255,40,20,0)');
          mainCtx.fillStyle = _g;
          mainCtx.beginPath();
          mainCtx.arc(_lx, _ly, _runR, 0, Math.PI * 2);
          mainCtx.fill();
        }
        // Brake lights: brighter red, fires whenever braking
        // (day or night).
        if (_brake) {
          const _brR = 5.5;
          const _g = mainCtx.createRadialGradient(_lx, _ly, 0, _lx, _ly, _brR);
          _g.addColorStop(0,    `rgba(255,70,40,${_tlBaseAlpha + 0.2})`);
          _g.addColorStop(0.55, `rgba(255,55,25,${_tlBaseAlpha * 0.5})`);
          _g.addColorStop(1,    'rgba(255,55,25,0)');
          mainCtx.fillStyle = _g;
          mainCtx.beginPath();
          mainCtx.arc(_lx, _ly, _brR, 0, Math.PI * 2);
          mainCtx.fill();
        }
        // Reverse lights: warm-white halo, fires on pRevIntent.
        if (_rev) {
          const _revR = 5.0;
          const _g = mainCtx.createRadialGradient(_lx, _ly, 0, _lx, _ly, _revR);
          _g.addColorStop(0,   `rgba(255,245,220,${_tlBaseAlpha + 0.15})`);
          _g.addColorStop(0.5, `rgba(255,235,190,${_tlBaseAlpha * 0.4})`);
          _g.addColorStop(1,   'rgba(255,235,190,0)');
          mainCtx.fillStyle = _g;
          mainCtx.beginPath();
          mainCtx.arc(_lx, _ly, _revR, 0, Math.PI * 2);
          mainCtx.fill();
        }
      }
    }
  }
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
  // H511: paramedic lightbar gate. Mirrors monolith L40908
  // `isPlayer && LIFE.playerJob==='PARAMEDIC' && LIFE.job && !LIFE.jobDoneToday`.
  // Only meaningful when the player is driving the Ambulance chassis;
  // drawAmbulanceStub gates on this regardless, so always-passing the
  // computed value is fine for non-ambulance cars (the deps field is
  // simply unread on their render path).
  const _paramedicLightsActive = !!ctx.life
    && ctx.life.playerJob === 'PARAMEDIC'
    && !!ctx.life.job
    && !ctx.life.jobDoneToday;
  // H604: pass life.bodyDamage through so the X-Ray overlay reads
  // the per-zone heatmap H597 accrues from collisions.
  const _bodyDamage = ctx.life?.bodyDamage as import('@/render/carBody/damage').BodyDamage | undefined;
  drawPlayerCarV2(mainCtx, player, activeCar ?? null, _braking, player.pRevIntent, night, _xrayBody, _paramedicLightsActive, _bodyDamage);
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
  drawMinimap(hctx, ctx.minimap, player, hudCanvas.width, ctx.life, ctx.traffic);

  // H577: road name + speed limit widget below the minimap. Shows
  // interstate/US shield + name + LIMIT NN sign; red flash when
  // player is 10+ mph over. No-op when off-road.
  drawRoadInfo(hctx, player, true);

  // H580: live physics debug HUD — opt-in panel left side, below
  // the road info widget. Toggled via OPT → Debug HUD. No-op
  // when off so default play stays uncluttered.
  drawPhysicsDebug(hctx, player, life?.gameplaySettings?.physDebugHUD === true);

  // H579: FPS counter pill — top-center, away from the minimap
  // (top-left) and gauge cluster (top-right). Toggled via
  // OPT → FPS Counter (life.gameplaySettings.showFPS). Color-codes
  // the readout: green ≥55, yellow 30-54, red <30 so the player
  // sees perf status at a glance without parsing the number.
  if (life?.gameplaySettings?.showFPS === true) {
    const fps = ctx.frame.fpsDisplay;
    const fpsCol = fps >= 55 ? '#0f0' : fps >= 30 ? '#ff0' : '#f44';
    const pillW = 52;
    const pillX = (hudCanvas.width - pillW) / 2;
    hctx.fillStyle = 'rgba(0, 0, 0, 0.65)';
    hctx.fillRect(pillX, 4, pillW, 14);
    hctx.fillStyle = fpsCol;
    hctx.font = 'bold 9px monospace';
    hctx.textAlign = 'center';
    hctx.fillText('FPS ' + fps, pillX + pillW / 2, 14);
    hctx.textAlign = 'left';
  }
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
  // H483: SCALE_MS + mph/kmh helpers extracted to physics/physicsUnits.ts
  // as the canonical source. The wpxsToMph/wpxsToKmh exports match
  // the formulas previously inlined here (and in catalog.ts, traffic.ts,
  // home/overlay.ts) — see that module for the wpx/s ↔ m/s derivation.
  const _mph = wpxsToMph;
  const _kmh = wpxsToKmh;
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
  // H506: drift / slipAngle / wheelspinRatio approximations are SKIPPED
  // when the Phase 0B integrator owned this frame's tick — runPhase0BTick
  // has already written the AUTHORITATIVE values (state.pDrifting,
  // state.pSlipAngle, state.pWheelspinRatio) onto PlayerState via
  // syncIntegratorStateToPlayer. Overwriting them with the arcade
  // heuristics here would clobber the real physics-derived signal that
  // proceduralEngine reads downstream.
  //
  // wheelGap stays unconditional — the integrator doesn't model gear-
  // vs-speed delta (it's a UI / audio derivation, not a physics one),
  // and it depends on prevGear which gameLoop's tickGearAndRpm owns
  // regardless of which physics path ran.
  const _absSpd = Math.abs(player.pSpeed);
  if (!phase0BOwned) {
    const _steer = ctx.input.steerAxis;
    const _drifting = ctx.input.ebrk && _absSpd > 30 && Math.abs(_steer) > 0.3;
    player.drifting = _drifting;
    player.slipAngle = _drifting ? _steer * 0.25 : 0;
    const _wsLow = ctx.input.gas
      && player.prevGear <= 2
      && _rpmNorm > 0.8
      && _absSpd < 30;
    player.wheelspinRatio = _wsLow ? 0.3 : 0;
  }
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
    // H76: real per-car odometer. raw game units → miles via
    // MILES_PER_GAME_UNIT, or km via KM_PER_GAME_UNIT. Floor matches
    // monolith L34266/34267.
    odo: _isMph ? Math.floor(_odoRaw * MILES_PER_GAME_UNIT) : Math.floor(_odoRaw * KM_PER_GAME_UNIT),
    odoUnit: _isMph ? 'MI' : 'KM',
    todIcon: '',                           // legacy field, unused by cluster body
    todName: '',
    date: '',
    fps: ctx.frame.fpsDisplay,
    // H627: on mobile the SVG overlays own the crisp tick/label/needle
    // layers. Canvas keeps the dial fill + bezel + corner pills.
    //   skipSpeedo — H625/H627: SVG owns speedo ticks/labels/needle/hub.
    //   skipRim    — H628: SVG fuel needle replaces the canvas left-OD
    //                fuel rim arc. (Temp rim arc has no SVG replacement
    //                yet; H629 wheel-RPM SVG will host #rpmTempNeedle.
    //                Until then temp gauge silently disappears on
    //                mobile — non-critical since modular hardcodes
    //                temp=0.4 and nothing reads it.)
    skipSpeedo: document.body.classList.contains('mob'),
    skipRim: document.body.classList.contains('mob'),
    // H629: SVG RPM overlay owns the RPM dial on mobile. Skip the canvas
    // cluster's small RPM circle so they don't stack visually.
    skipRPM: document.body.classList.contains('mob'),
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
  // H625: SVG speedometer overlay — fires only on mobile (body.mob class
  // gate inside updateSpeedoSvg). Visibility tracks the class so a
  // portrait→landscape orientation flip hides the SVG and the canvas
  // cluster reclaims the dial. setSpeedoSvgVisible is idempotent; we
  // call it every frame so external display:none writes (e.g. from a
  // pause-menu modal that hides every HUD layer) get reset back.
  const isMobMode = document.body.classList.contains('mob');
  setSpeedoSvgVisible(isMobMode && !ctx.faultEffects.hideGauges);
  setMobileRpmSvgVisible(isMobMode && !ctx.faultEffects.hideGauges);
  if (isMobMode) {
    updateSpeedoSvg({
      speed: gaugeOpts.speed,
      speedMax: gaugeOpts.speedMax,
      unit: gaugeOpts.speedUnit,
      needleColor: preset?.speedNeedleColor,
      fuel: gaugeOpts.fuel,
      hideGauges: ctx.faultEffects.hideGauges,
    });
    updateMobileRpm({
      rpm: gaugeOpts.rpm,
      redline: gaugeOpts.redline,
      temp: gaugeOpts.temp,
      gear: gaugeOpts.gear,
      hideGauges: ctx.faultEffects.hideGauges,
    });
    // H647: gear digit now also lives inside the shift knob (#skGearText).
    // Per monolith v8.99.123.97 the RPM-gauge gear digit was retired in
    // favor of the shifter recess; we keep both DOM elements but CSS
    // hides #mobileRpmGearGroup on mobile, so this is the only gear
    // indicator the mobile player sees post-H647.
    updateShifterGear(ctx.faultEffects.hideGauges ? '-' : String(gaugeOpts.gear ?? '-'));
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

  // H572: pursuit HUD — red meter + WANTED label when a cop is
  // actively chasing the player. Reads pursuit state from the
  // traffic list; no-op when no cop has isPursuing=true. Sits at
  // GH*0.18 so it doesn't overlap the breakdown indicator at
  // GH*0.40 (different vertical bands).
  drawPursuitHud(hctx, ctx.traffic, hudCanvas.width, hudCanvas.height);

  // H573: job indicator — top-left text label echoing the active
  // life.job so the driver doesn't have to glance at the minimap
  // A/B markers or open the JOBS pause tab to remember what
  // they're doing. No-op when no job is active.
  if (life) {
    drawJobIndicator(hctx, life, hudCanvas.height);
  }

  // H590: cruise control indicator — small green pill at GH*0.36
  // (just below the job indicator's GH*0.33 band). Shows only
  // when cruise is engaged so default-driving HUD stays clean.
  if (player.cruiseOn) {
    const cy = hudCanvas.height * 0.36;
    hctx.fillStyle = 'rgba(0, 0, 0, 0.65)';
    hctx.fillRect(2, cy - 8, 78, 14);
    hctx.fillStyle = '#0f0';
    hctx.font = 'bold 9px monospace';
    hctx.textAlign = 'left';
    hctx.fillText('🚗 CRUISE ON', 6, cy + 2);
  }

  // H571: gas station menu. Paints over everything when the pump
  // proximity check has flipped life.fuelMenuOpen. Eats all input
  // until LEAVE STATION closes it.
  if (life) {
    drawGasStationMenu(hctx, life, hudCanvas.width, hudCanvas.height);
  }

  // H563: tow-truck breakdown modal. Paints over the breakdown HUD
  // when life.towMenuOpen is true — full-canvas darken + dynamic
  // option list. The modal is a hard stop for the player (taps eat
  // through anything beneath), matching the monolith's behavior at
  // L35965-36025.
  if (life) {
    drawTowMenu(hctx, life, hudCanvas.width, hudCanvas.height);
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
    // H556: sync life.fuel from player.fuel right before the
    // pause menu draws so the STATUS tab fuel% reads the live
    // burn-adjusted value rather than whatever was set the last
    // time a writer touched life.fuel (purchase/race/swap). One-
    // shot at draw time — the player is paused, no fuel burn is
    // happening, so this single sync is enough for the open
    // session. life.fuel returns to "free for writers to set"
    // the moment the menu closes; no per-frame overwrite anywhere.
    if (life) life.fuel = player.fuel * 100;
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

  // H578: CRT scanlines overlay — final post-process pass. Toggled
  // via OPT → CRT Scanlines (life.gameplaySettings.scanlines).
  // Paints subtle 1px-on / 1px-off dark bands across the whole
  // canvas; alpha 0.08 is tuned to be visible without obscuring
  // UI text. Sits AFTER everything (including pause menu + confirm
  // prompt) so the CRT feel applies to all modal layers uniformly,
  // matching the monolith's L36156 ordering inside drawPlaying.
  // No-op when toggle is off — the drawCrtScanlines guard short-
  // circuits before any fillRect work.
  drawCrtScanlines(hctx, {
    WORLD_GW: hudCanvas.width,
    GH: hudCanvas.height,
    enabled: life?.gameplaySettings?.scanlines === true,
  });
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
      // H581: re-sync tiltState from loaded gameplaySettings so a
      // player who saved with tilt OFF doesn't get it back ON on
      // reload. Dispatch resize so fitCanvases picks up the new
      // tiltMul. Mirrors the runtime toggle behavior.
      const loadedLife = deps.ctx.life;
      const tiltSetting = loadedLife?.gameplaySettings?.cameraTiltMode;
      if (typeof tiltSetting === 'number' && tiltSetting !== tiltState.mode) {
        tiltState.mode = tiltSetting;
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new Event('resize'));
        }
      }
      // H583: re-sync audio volumes from loaded settings.
      // applyAudioVolumes is a no-op when the audio context hasn't
      // initialized yet — but it stashes pendingVolumes so the next
      // initAudio (fires on first user interaction) picks them up.
      // Either path lands the right gain values.
      if (loadedLife?.gameplaySettings) {
        applyAudioVolumes({
          volCarSfx:  loadedLife.gameplaySettings.volCarSfx,
          volMenuSfx: loadedLife.gameplaySettings.volMenuSfx,
          volMusic:   loadedLife.gameplaySettings.volMusic,
        });
      }
      // H584: re-sync PC render scale from loaded settings + fire
      // the resize so fitCanvases rebuilds the buffer dimensions.
      // The tilt resize above already fires, but it's idempotent
      // and the render-scale sync needs to happen BEFORE the
      // resize handler runs so the next fitCanvases reads the new
      // multiplier. Set first, then dispatch.
      const rsSetting = loadedLife?.gameplaySettings?.pcRenderScale;
      if (typeof rsSetting === 'number' && rsSetting > 0) {
        setRenderScale(rsSetting);
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new Event('resize'));
        }
      }
      // H586: re-sync the PC Touch Controls body class so the
      // override CSS hides/shows #mctrl per the saved toggle.
      if (typeof document !== 'undefined') {
        const pcTouchOn = loadedLife?.gameplaySettings?.pcShowMobileControls === true;
        document.body.classList.toggle('pc-touch-ui', pcTouchOn);
      }
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
          // H593: LOT tab inspect — open the PURCHASE finance modal
          // for the picked carLot row. Modular's inspection step is
          // seller-side only (the lot is dealer pre-screened per
          // carLot.ts header), so the lot path jumps straight to
          // PURCHASE OPTIONS. Mirrors monolith L21163 in intent;
          // diverges on flow because the modular doesn't carry a
          // separate inspection modal for lot listings.
          optLotInspect: (idx: number) => {
            const life = deps.ctx.life;
            if (!life || !life._carLot) return;
            const listing = life._carLot[idx];
            if (!listing) return;
            deps.ctx.menu.open = false;
            life.purchaseMenu = {
              carId: listing.id,
              carName: listing.name,
              price: listing.price,
              isNew: listing.isNew,
              source: 'lot',
              index: idx,
              options: getFinanceOptions(listing.price, listing.isNew),
              listing: { mileage: listing.mileage },
            };
          },
          // H593: LOT tab reshuffle — re-roll the 8 picks.
          optLotReshuffle: () => {
            const life = deps.ctx.life;
            if (!life) return;
            life._carLot = generateCarLot(deps.ctx.clock.day);
            setNotifState(life, '🔁 Lot reshuffled', 90);
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
          // H200 + H522: APPLY — rolls 55% hire chance per the
          // monolith. Hire-success path resets workRep / workDays /
          // basePay / payMultiplier to fresh-hire defaults; reject
          // path drops the failed opening from _jobListings so the
          // player can't spam-retry. setNotifState surfaces the
          // discriminated outcome with the monolith's exact strings.
          applyForJob: (opening) => {
            const life = deps.ctx.life;
            if (!life) return;
            const result = runApplyForJob(life, opening.name);
            if (result.kind === 'hired') {
              setNotifState(life, "HIRED! You're now a " + result.jobName + '!');
            } else {
              setNotifState(life, 'Application rejected. Try another or sleep & retry.');
            }
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
          // H560: full OPT panel handlers. Each one mutates
          // life.gameplaySettings; the actual render / physics /
          // audio subsystems read these flags lazily, so most
          // toggles take effect on the next frame without an
          // explicit re-init call. PC Render Scale + Camera Tilt
          // are exceptions — their side-effects (canvas resize, CSS
          // perspective re-apply) wire in when those subsystems
          // port. For now the flag persists and reads back into the
          // OPT panel correctly.
          optToggleFPS: () => {
            const life = deps.ctx.life;
            if (life) life.gameplaySettings.showFPS = !(life.gameplaySettings.showFPS === true);
          },
          optToggleCameraTilt: () => {
            // Two-mode toggle: 0 (top-down) ↔ 1 (20° tilt). 1:1 with
            // monolith TILT_MODE binary in OPT taps (L35092-35119).
            // H581: also flip tiltState.mode + dispatch a resize so
            // main.ts's fitCanvases re-runs with the new tiltMul.
            // Without the resize the CSS perspective stays at the
            // old angle and the player sees no change.
            const life = deps.ctx.life;
            if (!life) return;
            const cur = (life.gameplaySettings.cameraTiltMode ?? 0) as number;
            const next = cur === 0 ? 1 : 0;
            life.gameplaySettings.cameraTiltMode = next;
            tiltState.mode = next;
            // Fire a synthetic resize so fitCanvases re-computes the
            // tilted canvas dimensions + re-applies the CSS
            // perspective. Cheap (main.ts handler runs in ~1ms).
            if (typeof window !== 'undefined') {
              window.dispatchEvent(new Event('resize'));
            }
          },
          optToggleBicycleModel: () => {
            // Bicycle Model is independent. The sub-flag dynPhysics0B
            // is gated on it in the OPT click router (no-op when off),
            // and the Phase 0B adapter requires both ON, so we don't
            // need to forcibly clear dynPhysics0B here.
            const life = deps.ctx.life;
            if (life) life.gameplaySettings.bicycleModel = !(life.gameplaySettings.bicycleModel === true);
          },
          optToggleDynPhysics0B: () => {
            const life = deps.ctx.life;
            if (life) life.gameplaySettings.dynPhysics0B = !(life.gameplaySettings.dynPhysics0B === true);
          },
          optToggleInvertPedals: () => {
            const life = deps.ctx.life;
            if (life) life.gameplaySettings.invertPedals = !(life.gameplaySettings.invertPedals === true);
          },
          optTogglePcTouchControls: () => {
            const life = deps.ctx.life;
            if (!life) return;
            const next = !(life.gameplaySettings.pcShowMobileControls === true);
            life.gameplaySettings.pcShowMobileControls = next;
            // H586: body.pc-touch-ui class drives the CSS override
            // that re-shows #mctrl on PC. setMobileControlsVisible
            // still controls the underlying flex/none, but the
            // base.css @media rule hides it on PC regardless — the
            // class flip overrides that hide so PC players can see
            // and interact with the cluster.
            if (typeof document !== 'undefined') {
              document.body.classList.toggle('pc-touch-ui', next);
            }
          },
          optAdjustSteerSens: (delta) => {
            const life = deps.ctx.life;
            if (!life) return;
            const isT = typeof window !== 'undefined' && 'ontouchstart' in window;
            const key = isT ? 'touchSteerSens' : 'padSteerSens';
            const cur = (life.gameplaySettings[key] as number | undefined) ?? 1.0;
            const next = Math.max(0.5, Math.min(2.0, cur + delta));
            life.gameplaySettings[key] = Math.round(next * 10) / 10;
          },
          optAdjustRenderScale: (delta) => {
            const STEPS = [0.5, 0.75, 1.0, 1.25, 1.5];
            const life = deps.ctx.life;
            if (!life) return;
            const cur = (life.gameplaySettings.pcRenderScale as number | undefined) ?? 1.0;
            let idx = STEPS.findIndex((s) => Math.abs(s - cur) < 1e-6);
            if (idx < 0) {
              // Snap to nearest step before stepping.
              idx = 0;
              let best = Math.abs(STEPS[0] - cur);
              for (let i = 1; i < STEPS.length; i++) {
                const d = Math.abs(STEPS[i] - cur);
                if (d < best) { best = d; idx = i; }
              }
            }
            const dir = delta > 0 ? 1 : -1;
            const next = Math.max(0, Math.min(STEPS.length - 1, idx + dir));
            life.gameplaySettings.pcRenderScale = STEPS[next];
            // H584: push the new scale into main.ts's module-level
            // value + dispatch a resize so fitCanvases reapplies it
            // to the internal canvas buffer. Without this the
            // setting persisted to gameplaySettings but the canvas
            // dimensions stayed at the boot scale (always 1.0).
            setRenderScale(STEPS[next]);
            if (typeof window !== 'undefined') {
              window.dispatchEvent(new Event('resize'));
            }
          },
          optAdjustVolume: (key, delta) => {
            const life = deps.ctx.life;
            if (!life) return;
            const cur = (life.gameplaySettings[key] as number | undefined) ?? 1.0;
            const next = Math.max(0, Math.min(1, cur + delta));
            // Round to 5% step so the readout stays clean.
            life.gameplaySettings[key] = Math.round(next * 20) / 20;
            // H583: pipe the new volumes into the audio module's
            // gain nodes so the slider takes effect immediately.
            // Pre-H583 the OPT panel stored the values but no audio
            // path read them — engine/UI/music gains stayed at the
            // 1.0 init defaults regardless of the slider state.
            applyAudioVolumes({
              volCarSfx:  life.gameplaySettings.volCarSfx,
              volMenuSfx: life.gameplaySettings.volMenuSfx,
              volMusic:   life.gameplaySettings.volMusic,
            });
          },
          optAdjustPhysTune: (key, delta, step, min, max) => {
            const life = deps.ctx.life;
            if (!life) return;
            // Default value falls back to the row's min when the
            // setting is unset — keeps clamp behavior predictable.
            const defaults: Record<string, number> = {
              physMuBase: 1.0,
              physMomentumCoef: 6.0,
              physMassMomentum: 0.0003,
              physTopSpeedCap: 350,
              physDriftEnterThresh: 0.26,
            };
            const cur = (life.gameplaySettings[key] as number | undefined) ?? defaults[key] ?? min;
            const next = Math.max(min, Math.min(max, cur + delta * step));
            life.gameplaySettings[key] = next;
          },
          optToggleDebugHUD: () => {
            const life = deps.ctx.life;
            if (life) life.gameplaySettings.physDebugHUD = !(life.gameplaySettings.physDebugHUD === true);
          },
          // H562: test-mode DEBUG handlers. Stat sliders write directly
          // to the live fields (engine/tires/carHP/paint/fuel) so the
          // change is visible immediately on the STATUS tab and in the
          // physics fault gates. Fault toggle pushes the catalog entry
          // verbatim (id + name + stat + cost + days + type + add) so
          // downstream FAULT_EFFECTS lookup + repair routing see the
          // same shape as faults pushed by diagnoseFault / impact
          // damage.
          optDbgSetStat: (key, value) => {
            const life = deps.ctx.life;
            if (!life) return;
            const clamped = Math.max(0, Math.min(100, value));
            (life as Record<string, unknown>)[key] = clamped;
          },
          optDbgToggleFault: (faultId, entry) => {
            const life = deps.ctx.life;
            if (!life) return;
            const arr = (life.faults ?? []) as Array<{ id?: string }>;
            const idx = arr.findIndex((f) => f.id === faultId);
            if (idx >= 0) {
              arr.splice(idx, 1);
            } else {
              arr.push({ ...entry });
            }
            life.faults = arr;
          },
          optDbgClearFaults: () => {
            const life = deps.ctx.life;
            if (life) life.faults = [];
          },
          // H591: live toggle for life._testMode. Flipping ON
          // makes the OPT-tab DEBUG panel (stat sliders + per-
          // fault toggles + CLEAR ALL FAULTS) render on the next
          // paint; OFF hides it without clearing any faults the
          // player added — same semantics as restarting the run
          // with a non-"test" name.
          optToggleTestMode: () => {
            const life = deps.ctx.life as { _testMode?: boolean } | null;
            if (!life) return;
            life._testMode = !life._testMode;
            setNotifState(
              deps.ctx.life!,
              life._testMode ? '🔬 Fault DEBUG ON' : '🔬 Fault DEBUG OFF',
              90,
            );
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
        deps.ctx.clock.day,
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
    // H571: gas station menu eats every tap while open. Sits
    // BEFORE the tow modal check because gas station + tow can't
    // legally coexist (gas station only opens at a pump, tow opens
    // on breakdown — disjoint conditions), but ordering matters
    // for the click pipeline regardless.
    if (
      state === 'playing'
      && deps.ctx.life
      && deps.ctx.life.fuelMenuOpen
    ) {
      handleGasStationTap(tx, ty, deps.ctx.life);
      return;
    }
    // H563: tow modal eats every tap when open. Routes option taps
    // through handleTowMenuClick (USE JERRY CAN / TOW GARAGE /
    // MECHANIC / JUNKYARD). Sits BEFORE the CALL TOW button check
    // because the modal is the consequence of that button — when
    // open the button is suppressed by isCallTowVisible anyway, but
    // returning early here also covers the case where the player
    // taps the modal's option region while pAngle / breakdown state
    // changes mid-frame.
    if (
      state === 'playing'
      && deps.ctx.life
      && deps.ctx.life.towMenuOpen
    ) {
      handleTowMenuClick(
        tx, ty,
        deps.ctx.life,
        deps.hudCanvas.width,
        { player: deps.ctx.player },
      );
      return;
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
      fillNewspaperListings(deps.ctx.life, deps.ctx.clock.day, deps.ctx.tileMap);
      return;
    }
    if (state === 'playing' && deps.ctx.home.open && deps.ctx.life) {
      // H30: route taps to the home overlay while it's up.
      const homeDeps: HomeOverlayDeps = {
        setTab: (t) => { deps.ctx.home.tab = t; },
        close: () => { deps.ctx.home.open = false; deps.ctx.home.tab = 'main'; },
        // H564: GET IN routes through switchCar (snapshot old car's
        // condition into carConditions, rotate ownedCars, load new
        // car's snapshot back onto LIFE, reset player physics) and
        // then closes the home overlay so the player drops straight
        // into the cockpit of the new car. Mirrors monolith
        // "switch & exit" at L50703-50711.
        getIn: (carId) => {
          if (!deps.ctx.life) return;
          runSwitchCar(deps.ctx.life, deps.ctx, carId);
          deps.ctx.home.open = false;
          deps.ctx.home.tab = 'main';
          resetInputState(deps.ctx);
        },
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
