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
import { tickCameraAngle } from '@/state/player';
import { tickTrafficCollisions } from '@/physics/trafficCollision';
import { drawPlayerCar, drawHeadlights } from '@/render/playerCar';
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
import { drawGaugeCluster, type GaugeOpts } from '@/render/hud/gauges';
import { getGaugePreset } from '@/config/cars/gaugePresets';
import { getCarGeneration } from '@/render/carBody/generation';
import { getEffectiveUnit } from '@/state/effectiveRhd';
import { drawGasStations, tickRefuel } from '@/render/gasStations';
import { drawTraffic, drawTrafficHeadlights, drawTrafficTailLights } from '@/render/traffic';
import { tickTraffic } from '@/state/traffic';
import { applyDayNightTint } from '@/render/dayNightTint';
import { tickClock, formatClockTime, nightIntensity } from '@/state/clock';
import { isOnRoad } from '@/world/tileMap';
import { unlockAudio, setEngineActive, setEngineSpeed, playCrash, playRefuelDing, playLowFuelBeep } from '@/audio/arcadeAudio';
import { drawHomeOverlay, handleHomeOverlayClick, type HomeOverlayDeps } from '@/ui/screens/home/overlay';
import { fillNewspaperListings } from '@/sim/newspaperGenerator';
import { rollStartingConditions, rollStartingSavingsForJob } from '@/sim/startingConditions';
import { generateStartingCarChoices } from '@/sim/startingCars';
import { applyStartingConditions, applyStartingJob } from '@/sim/applyStartingConditions';
import { applyStartingCarChoice } from '@/sim/applyStartingCarChoice';
import { fireMonthlyBills, isMonthBoundary } from '@/sim/monthlyBills';
import { fireMonthlyPay } from '@/sim/monthlyPay';
import { createDefaultLife } from '@/state/life';
import { setMobileControlsVisible } from '@/ui/mobileControls';
import { saveGame, loadGame, clearSave } from '@/save/interim';

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
  const isPlaying = deps.ctx.gameState === 'playing';
  setMobileControlsVisible(isPlaying);
  setEngineActive(deps.ctx.audio, isPlaying);
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

    if (e.key === 't' || e.key === 'T') {
      // Snapshot before exiting so LOAD GAME picks up where we left
      // off. Only saves from 'playing' — other states have nothing
      // meaningful to persist yet.
      if (deps.ctx.gameState === 'playing') saveGame(deps.ctx);
      deps.ctx.gameState = 'title';
      deps.ctx.input.gas = false;
      deps.ctx.input.brake = false;
      deps.ctx.input.steerLeft = false;
      deps.ctx.input.steerRight = false;
      return;
    }

    if ((e.key === 'h' || e.key === 'H') && deps.ctx.gameState === 'playing') {
      // H30: toggle home-screen overlay. Pauses input pass-through to
      // arcadeUpdate by zeroing held buttons so the player doesn't
      // coast across town while the menu is up.
      deps.ctx.home.open = !deps.ctx.home.open;
      if (deps.ctx.home.open) {
        deps.ctx.input.gas = false;
        deps.ctx.input.brake = false;
        deps.ctx.input.steerLeft = false;
        deps.ctx.input.steerRight = false;
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

    if ((e.key === 'n' || e.key === 'N') && deps.ctx.gameState === 'playing') {
      // H24 dev: advance the clock by one in-game day. Fires the
      // monthly cycle if the new day crosses a 30-day boundary so the
      // economy is testable without driving for 3 real hours.
      const prevDay = deps.ctx.clock.day;
      deps.ctx.clock.day++;
      // Reset timeOfDay to morning so the world lighting matches "next
      // day" rather than carrying the previous time. Reads more like
      // a sleep / fast-forward than a teleport mid-evening.
      deps.ctx.clock.timeOfDay = 7 / 24;
      if (deps.ctx.life && isMonthBoundary(prevDay, deps.ctx.clock.day)) {
        fireMonthlyPay(deps.ctx.life, deps.ctx.clock.day);
        fireMonthlyBills(deps.ctx.life, deps.ctx.clock.day);
      }
      // H36: refresh the classifieds — expire stale, top up to 5+3.
      if (deps.ctx.life) {
        fillNewspaperListings(deps.ctx.life, deps.ctx.clock.day);
      }
      return;
    }

    setInputFromKey(deps.ctx.input, e.key, true);
  };
  const onUp = (e: KeyboardEvent): void => {
    setInputFromKey(deps.ctx.input, e.key, false);
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

/** First-playable 'playing' state. Updates arcade physics with the
 *  current input, paints the world (grass + baseline-road network as
 *  of H8), draws the player triangle, and overlays a small HUD with
 *  FPS + driver alias + speed. Real update + render + HUD pipelines
 *  replace this when their bodies port. */
function drawPlaying(deps: GameLoopDeps): void {
  const { mainCtx, hctx, mainCanvas, hudCanvas, ctx } = deps;
  const player = ctx.player;

  const onRoad = isOnRoad(ctx.tileMap, player.px, player.py);
  arcadeUpdate(player, ctx.input, ctx.frame.dt, onRoad);
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
      // multiplier (fault system not ported). Speed gate at >5 wpx/s
      // mirrors the monolith's `if (spd > 5 && !LIFE.broken)` guard;
      // we don't have a broken flag yet so the gate is speed-only.
      // wearMult ramps: new car (0mi)=1×, 100k=2×, 200k=3× — accelerates
      // wear on used cars so a high-mileage beater eats stats faster.
      const _spd = Math.abs(player.pSpeed);
      if (_spd > 5) {
        const _odoMi = ((ctx.life.carOdometers?.[_activeCarId] ?? 0)) * 0.0001278;
        const _wearMult = 1 + _odoMi / 100000;
        const _dt = ctx.frame.dt;
        ctx.life.tires  = Math.max(0, ctx.life.tires  - 0.001  * _spd * _dt * _wearMult);
        ctx.life.engine = Math.max(0, ctx.life.engine - 0.0005 * _spd * _dt * _wearMult);
        ctx.life.paint  = Math.max(0, ctx.life.paint  - 0.0001 * _spd * _dt * _wearMult);
      }
    }
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
  spawnSkidMarksIfNeeded(ctx.skidMarks, player, ctx.input, onRoad, _nowMs);
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
  // H29 refuel ding: fire once on the null → station edge.
  if (refuelingAt && !ctx.audio.wasRefuelingLast) {
    playRefuelDing(ctx.audio);
  }
  ctx.audio.wasRefuelingLast = !!refuelingAt;
  // H29 low-fuel beep: throttled to every 2 seconds while fuel ∈
  // (0, 0.15). Runs out of fuel = silence (no point telling them).
  if (player.fuel > 0 && player.fuel < 0.15) {
    const now = Date.now();
    if (now - ctx.audio.lastLowFuelBeepAtMs > 2000) {
      playLowFuelBeep(ctx.audio);
      ctx.audio.lastLowFuelBeepAtMs = now;
    }
  }
  const prevDay = ctx.clock.day;
  tickClock(ctx.clock, ctx.frame.dt);
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
    fillNewspaperListings(ctx.life, ctx.clock.day);
  }
  tickTraffic(ctx.traffic, ctx.frame.dt);
  const collision = tickTrafficCollisions(player, ctx.traffic);
  if (collision) {
    playCrash(ctx.audio, collision.impact);
    // H50: spark burst at the player position when we hit traffic.
    spawnCrashSparks(ctx.particles, player.px, player.py, collision.impact);
  }
  // H50: tick particle ages + drift toward the visible viewport.
  updateParticles(ctx.particles, ctx.frame.dt);
  // H56: tick the Akira taillight trail — push a point if above
  // threshold, shift off otherwise.
  tickSpeedTrail(ctx.speedTrail, player, ctx.input.brake);
  // Engine pitch tracks player.pSpeed (already clamped to MAX_SPEED
  // = 200 by arcadeUpdate). Normalized to 0..1 so off-road's 50%
  // cap automatically rolls the engine off without extra plumbing.
  setEngineSpeed(ctx.audio, player.pSpeed / 200);

  // World pass: solid grass + baseline road network.
  // H60: bumped ZOOM to 3.0 on PC (was 2.2) — the monolith's effective
  // on-screen zoom at pcRenderScale=0.75 + base 2.2 lands at ~2.93×,
  // and the user reported the H build still felt too far out at 2.2.
  // Going direct (no render-scale) avoids the CSS-upscale side-border
  // artifact H59 introduced. Player anchors 65% down (sight ahead).
  // Note: aspect detection compares display aspect via window size
  // rather than mainCanvas.height (which is gh-overscanned and so
  // always taller than wide on tilted-canvas mode).
  const _isLandscape = window.innerWidth >= window.innerHeight;
  const ZOOM = _isLandscape ? 3.0 : 2.5;
  const CAM_Y_RATIO = 0.65;
  mainCtx.setTransform(1, 0, 0, 1, 0, 0);
  mainCtx.fillStyle = '#1a2818';
  mainCtx.fillRect(0, 0, mainCanvas.width, mainCanvas.height);

  const night = nightIntensity(ctx.clock.timeOfDay);

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
  // square of side canvasH / ZOOM centered on the player. H60 dropped
  // the 0.75 padding multiplier to 0.55 — at ZOOM=3 the tighter cull
  // halves the grass + building tile pass per frame, recovering the
  // 20fps slowdown the user reported. Edge fragments still covered
  // by the +1 tile margins inside drawGrass / drawBuildings.
  const cullRadius = Math.ceil((Math.max(mainCanvas.width, mainCanvas.height) / ZOOM) * 0.55);

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
  drawBaselineRoads(mainCtx);
  // H57: crosswalk zebra stripes at intersections. Paints over the
  // road surface but under skid marks / traffic / player.
  drawCrosswalks(mainCtx, player.px, player.py);
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
  drawStreetlights(mainCtx, player.px, player.py, night);
  drawGasStations(mainCtx);
  // Headlights drawn under the car body. The cone gets darkened by
  // the day/night tint along with the rest of the world; the gradient
  // is bright enough that even after a 55% alpha night overlay, the
  // cone reads as illumination.
  drawHeadlights(mainCtx, player, night);
  // H53: traffic NPC headlight cones at night. Painted before
  // drawTraffic so the cone sits under each car body.
  drawTrafficHeadlights(mainCtx, ctx.traffic, player.px, player.py, night);
  drawTraffic(mainCtx, ctx.traffic);
  // H54: tail-light pixels on top of each traffic sprite.
  drawTrafficTailLights(mainCtx, ctx.traffic, player.px, player.py, night);
  // H26: resolve the active car's body color from CAR_CATALOG.
  // H27: also resolve a sprite PNG from the catalog's car name —
  // drawPlayerCar uses the sprite when available + loaded, else
  // falls back to the silhouette colored by playerColor.
  // ownedCars[0] is the spawn car; falls back to default if undefined.
  const activeCarId = ctx.life?.ownedCars[0];
  const activeCar = activeCarId ? CAR_CATALOG[activeCarId] : undefined;
  const playerColor = activeCar?.color;
  const playerSprite = spriteForCarName(activeCar?.name);
  drawPlayerCar(mainCtx, player, playerColor, playerSprite, ctx.input.brake);
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
  drawMinimap(hctx, ctx.minimap, player, hudCanvas.width);
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
  let _gearProxy: string;
  let _rpmTarget: number;
  let _shifting = false;
  if (activeCar) {
    const GS = activeCar.gearSpeeds;
    const aSpd = Math.abs(player.pSpeed);
    let pGear = activeCar.gears; // top gear default
    for (let i = 1; i < activeCar.gears; i++) {
      if (aSpd < GS[i]) { pGear = i; break; }
    }
    _gearProxy = player.pSpeed < 0 ? 'R' : String(pGear);
    // H86: gear-shift timer. 1:1 port of monolith L26418-26422:
    //   if (pGear!==prevGear && pGear>0 && prevGear>0 && pGear>prevGear)
    //       gearShiftTimer = 0.15 * fxFault.shiftMult;
    //   if (gearShiftTimer>0) gearShiftTimer -= dt;
    // fxFault.shiftMult is a transmission-fault multiplier (longer shift
    // when the gearbox is faulted); not ported until fault system lands,
    // so the base 0.15 (150ms) is used directly. Upshift-only — downshifts
    // don't dip RPM in the monolith. Stored on PlayerState so the timer
    // survives across frames.
    if (pGear !== player.prevGear && pGear > 0 && player.prevGear > 0 && pGear > player.prevGear) {
      player.gearShiftTimer = 0.15;
    }
    if (player.gearShiftTimer > 0) player.gearShiftTimer -= ctx.frame.dt;
    player.prevGear = pGear;
    _shifting = player.gearShiftTimer > 0;
    // H84: per-gear RPM target. 1:1 port of monolith L26461-26462. H86
    // adds the shifting branch (the 0.3× multiplier dip during the
    // 150ms post-upshift):
    //   target = shifting ? idleRPM + gearFrac*rpmRange*0.3
    //                     : gas ? idleRPM + min(1, gearFrac)*rpmRange*0.97
    //                           : idleRPM + gearFrac*rpmRange*0.5
    // The shifting branch ignores `gas` because the engine briefly
    // disconnects from the wheels during a shift (real auto-trans
    // behavior — torque converter unlocks, RPM drops).
    const gearLow = GS[Math.max(0, pGear - 1)] ?? 0;
    const gearHigh = GS[pGear] ?? activeCar.topSpeed;
    const gearFrac = pGear === 0 ? 0.3 : Math.min(1, (aSpd - gearLow) / (gearHigh - gearLow || 1));
    const rpmRange = RPM_MAX - RPM_IDLE;
    _rpmTarget = _shifting
      ? RPM_IDLE + gearFrac * rpmRange * 0.3
      : (ctx.input.gas
          ? RPM_IDLE + Math.min(1, gearFrac) * rpmRange * 0.97
          : RPM_IDLE + gearFrac * rpmRange * 0.5);
  } else {
    if (player.pSpeed < 1) _gearProxy = 'N';
    else if (player.pSpeed < 30) _gearProxy = '1';
    else if (player.pSpeed < 65) _gearProxy = '2';
    else if (player.pSpeed < 105) _gearProxy = '3';
    else if (player.pSpeed < 150) _gearProxy = '4';
    else _gearProxy = '5';
    // No-car fallback — preserve H75's linear proxy as the target.
    const _speedClamped = Math.max(0, Math.min(SPEED_MAX_UPS, player.pSpeed));
    _rpmTarget = RPM_IDLE + (RPM_MAX - RPM_IDLE) * (_speedClamped / SPEED_MAX_UPS);
  }
  // H85/H86: integrate player.pRpm toward the target. 1:1 port of
  // monolith L26473:  pRPM += (target-pRPM) * (shifting?12:5) * dt.
  // k=12 during shift (snappier ~85ms recovery toward the dip target),
  // k=5 otherwise (~200ms). The (target-pRpm) magnitude shrinks with
  // each step so the integrator is frame-rate independent.
  const _k = _shifting ? 12 : 5;
  player.pRpm += (_rpmTarget - player.pRpm) * _k * ctx.frame.dt;
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
  drawGaugeCluster(hctx, clusterCX, clusterCY, CLUSTER_R, gaugeOpts, preset);

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
}



/** Click/tap dispatcher. Routes by gameState. Every state now has a real
 *  handler (or no-op for 'playing' where keyboard owns input); the cycle
 *  stop-gap from H1-H5 is gone. */
function installClickRouter(deps: GameLoopDeps): void {
  const notif = (msg: string): void => {
    if (__DEV__) console.log(`[notif] ${msg}`);
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
      // File-import fallback for users without a localStorage save.
      // Pending — needs the user to actually have a .json export
      // workflow first (not added yet in H). Logged in dev so we
      // don't silently swallow the tap.
      if (__DEV__) console.log('[title] file-picker fallback not wired yet (H<export> follow-up)');
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
    }
  }, { passive: false });
}
