/**
 * Main pause menu — full-screen black overlay with the STATUS / JOBS
 * / RACE / CAL / OPT tab strip. Opened by tapping the top-right HUD
 * corner (tx > GW-82 && ty < 64) or gamepad START / Y. Closed by
 * tapping the same corner again, tapping the CLOSE button, gamepad
 * B, or pressing Escape.
 *
 * Ported from monolith L34528-34563 (shell paint) + L20992 (top-
 * right tap entry).
 *
 * Tab-body progress: H193 STATUS (player block) done; vehicle block
 * + SWITCH CAR pending in H194. JOBS / RACE / CAL / OPT pending.
 */
import type { LifeState } from '@/state/life';
import { getHealthStatus, getFitnessStatus, getTotalFood } from '@/sim/health';
import { CAR_CATALOG, type CatalogCar } from '@/config/cars/catalog';
import { JOB_SALARY, type JobName } from '@/config/jobs';
import type { JobOpening, DailyJob } from '@/sim/jobsRoller';
import { getEffectiveRHD } from '@/state/effectiveRhd';
import { isTouchPrimary } from '@/input/steerSens';
import { getDefaultRenderScale } from '@/engine/renderScale';
import { drawCharacterBase } from '@/render/characterBase';
import { drawTopCar } from '@/render/carBody/drawTopCar';
import { previewDepsForCar } from '@/render/carBody/previewDeps';
import {
  getRaceTier,
  RACE_TIER_NAMES,
  getEligibleStakeCars,
  getHouseStakeValue,
  normalizeStakeType,
  getCarValue,
  RACE_BET_STEP,
  RACE_BET_MIN,
  type RaceStakeType,
  type RaceStartMode,
} from '@/sim/race';
import { HOUSING_TIERS, type HousingTierKey } from '@/config/housing';
import type { Clock } from '@/state/clock';
import { DAYS_PER_MONTH } from '@/sim/monthlyBills';
import { MONTH_NAMES_FULL as CAL_MONTH_NAMES, getDateString } from '@/config/calendar';
import { getMileageTierLabel as mileageTierLabel } from '@/sim/mileageTier';
import { MILES_PER_GAME_UNIT, KM_PER_GAME_UNIT } from '@/physics/physicsUnits';
import { FAULT_EFFECTS } from '@/sim/faultEffects';
import { FAULT_POOLS } from '@/sim/faultPools';
import { BODY_DAMAGE_FAULTS } from '@/sim/faults';
import { generateCarLot } from '@/sim/carLot';
import { tiltState, TILT_PITCH_DEG_PC, TILT_PITCH_DEG_MOBILE } from '@/engine/tilt';
import {
  drawCellBadges,
  drawNavArrows,
  drawCalendarLegend,
  hitCalendarNav,
} from '@/ui/overlays/calendarBadges';
import {
  GT2_COLORS,
  drawGt2Backdrop,
  getGt2NightPalette,
  setGt2NightPalette,
  type Gt2NightPalette,
} from '@/ui/gt2Chrome';

/** Tab keys. The 'car' key name is legacy (the visible label is
 *  'STATUS' since v8.99.122.43 — the renamed tab kept the internal
 *  key for hotkey + tab-order continuity). 1:1 with monolith
 *  TAB_ORDER at L20115. */
export type MenuTab = 'car' | 'lot' | 'jobs' | 'race' | 'cal' | 'opt';

// H1001: the LOT (used-car) tab was removed from the pause menu — its
// browser is now the drive-in CAR DEALERSHIP venue (src/ui/modals/dealer.ts,
// opened by entering a placed dealership building). 'lot' stays in the union
// + dispatch/click as dormant code (unreachable — not in the tab order) so
// the drawLotTab/optLotInspect deps don't become unused symbols.
export const MENU_TAB_ORDER: readonly MenuTab[] = ['car', 'jobs', 'race', 'cal', 'opt'] as const;

/** Display labels for the tab strip. */
const TAB_LABELS: Record<MenuTab, string> = {
  car: 'STATUS',
  lot: 'LOT',
  jobs: 'JOBS',
  race: 'RACE',
  cal: 'CAL',
  opt: 'OPT',
};

export interface PauseMenuState {
  open: boolean;
  tab: MenuTab;
}

export interface PauseMenuOpts {
  state: PauseMenuState;
  GW: number;
  GH: number;
  /** LIFE — null pre-playing-state. Tab bodies that need LIFE
   *  fall through to the placeholder when null. */
  life: LifeState | null;
  /** Game clock — JOBS / CAL tabs read clock.day for the date line. */
  clock: Clock;
}

export interface PauseMenuDeps {
  setTab(tab: MenuTab): void;
  close(): void;
  /** SWITCH CAR button on STATUS tab. Monolith closes the menu and
   *  opens the carSelect modal (L21733); the modal port still TODO,
   *  so the host passes a stub that closes + notifies. */
  switchCar(): void;
  /** H593: tap on a LOT row → open the inspection modal for that
   *  lot listing. Host wires inspection.openInspection(listing,
   *  'lot', idx). */
  optLotInspect(idx: number): void;
  /** H593: RESHUFFLE LOT button → regenerate life._carLot. */
  optLotReshuffle(): void;
  /** H195: QUIT JOB button on JOBS tab. Sets life.job=null and
   *  notifies. */
  quitJob(): void;
  /** H195: SKIP WORK button on JOBS tab. Monolith decrements rep
   *  and increments consecutiveAbsences (L19xx). Stubbed until that
   *  sim ports — for now just closes the menu + notif. */
  skipWork(): void;
  /** H200: ACCEPT tap on an _availJobs row. Caller sets life.job =
   *  the picked entry and clears _availJobs (one shift per day). */
  acceptJob(job: DailyJob): void;
  /** H200: APPLY tap on a _jobListings row. Caller sets
   *  life.playerJob and clears _jobListings + life._fired. */
  applyForJob(opening: JobOpening): void;
  /** H200: lazy-fill hook called by handlePauseMenuClick on first
   *  tab-switch into JOBS. Caller decides whether to fill listings
   *  (unemployed) or _availJobs (has playerJob) and threads
   *  generateJobListings / generateDailyJob accordingly. */
  fillJobsTab(): void;
  /** H220: lazy-fill hook for the RACE tab. Caller checks
   *  timeSlot==='night' + no active race, then writes a fresh
   *  RaceState (newRaceSetup) to life.race. No-op when conditions
   *  aren't met. */
  fillRaceTab(): void;
  /** H222: re-roll the opponent. Replaces life.race with a fresh
   *  setup-phase state (same player car, new opponent pick). */
  rerollRaceOpponent(): void;
  /** H222: START RACE button. H222 stubs to TODO notif until
   *  H223 wires the phase='ready' transition + finishline gen. */
  startRace(): void;
  /** H198: RESTART button on OPT tab. Monolith clears the save and
   *  reloads the page. Stubbed for now — TODO notif. */
  optRestart(): void;
  /** H198: QUIT button on OPT tab. Saves + returns to title. Same
   *  behavior as the T-key dev shortcut. */
  optQuit(): void;
  /** H198: toggles life.gameplaySettings.xrayBody (mirrors X-key). */
  optToggleXray(): void;
  /** H198: toggles life.gameplaySettings.scanlines. */
  optToggleScanlines(): void;
  /** H560: toggles gameplaySettings.showFPS. The actual FPS counter
   *  render hook isn't ported yet — flag persists so the surface
   *  reads correctly and lights up once the HUD overlay lands. */
  optToggleFPS(): void;
  /** Flips life.gameplaySettings.mapLight (dark ↔ paper-map). The
   *  minimap re-bakes on the next frame. */
  optToggleMapStyle(): void;
  /** H560: cycles the camera tilt mode (currently 0 vs 1 — the
   *  monolith treats TILT_MODE===0 as top-down and !==0 as 20° tilt).
   *  Stored as gameplaySettings.cameraTiltMode; render side reads
   *  it on resize once the tilt config wires through. */
  optToggleCameraTilt(): void;
  /** H960: toggles gameplaySettings.simulationMode (cozy mode).
   *  When ON, races / work shifts / travel grow SIMULATE paths that
   *  resolve off-screen through the same economy + wear code as real
   *  driving (H961-H963 wire the actual resolvers). */
  optToggleSimulationMode(): void;
  /** H560: bicycle-model physics toggle. 1:1 with monolith
   *  L35129+ — independent from dynPhysics0B; the adapter requires
   *  both ON to use Phase 0B. Per H504, flipping bicycleModel OFF
   *  also clears dynPhysics0B (the sub-toggle gates on it). */
  optToggleBicycleModel(): void;
  /** H560: Phase 0B dynamic physics sub-toggle. Only meaningful when
   *  bicycleModel is ON; the click handler no-ops while it's OFF. */
  optToggleDynPhysics0B(): void;
  /** H560: inverts the pedal direction (top-of-bar = full press
   *  when on). Visual-only — touch handlers read this when
   *  computing press fraction. */
  optToggleInvertPedals(): void;
  /** H1021: toggle persistent manual transmission. */
  optToggleManualTransmission(): void;
  /** H560: PC-only toggle that overlays the mobile touch UI
   *  (rotating wheel rim, pedals, e-brake, shift knob) on top of
   *  desktop gameplay for visual feedback. Pointer-events:none so
   *  it doesn't intercept clicks. */
  optTogglePcTouchControls(): void;
  /** H560: steering sensitivity adjuster. The slider stores its
   *  current key (touchSteerSens or padSteerSens) on the cached
   *  hit-rect; the host applies the delta clamped to [0.5, 2.0]. */
  optAdjustSteerSens(delta: number): void;
  /** H560/H817: render-scale ± adjuster — one 0.05 notch per
   *  sign(delta), range [0.5, 2.0]. */
  optAdjustRenderScale(delta: number): void;
  /** H817: absolute render-scale set from a slider-track tap. Host
   *  snaps to the nearest 0.05 and clamps [0.5, 2.0]. */
  optSetRenderScale(value: number): void;
  /** H560: per-category audio volume adjuster. Key is one of
   *  volCarSfx / volMenuSfx / volMusic; delta is the % step
   *  (typically 0.05 = 5%) clamped to [0, 1]. The arcade audio
   *  module's gain pipeline isn't wired yet — flags persist so
   *  audio takes effect the moment per-category gain nodes land. */
  optAdjustVolume(key: string, delta: number): void;
  /** H560: physics-tuning knob adjuster. Key matches the
   *  gameplaySettings field; delta is signed (the row config
   *  carries min/max/step which the host clamps against). */
  optAdjustPhysTune(key: string, delta: number, step: number, min: number, max: number): void;
  /** H560: live physics debug HUD toggle. Reads through to
   *  gameplaySettings.physDebugHUD; render hook lands later. */
  optToggleDebugHUD(): void;
  /** H562: test-mode DEBUG stat slider. Sets life.{engine|tires|
   *  carHP|paint|fuel} directly so the player can dial in any
   *  starting stat state to observe gameplay defaults. */
  optDbgSetStat(key: 'engine' | 'tires' | 'carHP' | 'paint' | 'fuel', value: number): void;
  /** H562: test-mode DEBUG fault toggle. If the fault is currently
   *  active (matched by id in life.faults), removes it; otherwise
   *  pushes the supplied catalog entry. The pause-menu DEBUG
   *  catalog merges FAULT_POOLS + FAULT_EFFECTS + BODY_DAMAGE_FAULTS
   *  into one sorted list. */
  optDbgToggleFault(faultId: string, entry: { id: string; name: string; stat: string; cost: number; days: number; type: string; add: number }): void;
  /** H562: test-mode DEBUG — clears every active fault. */
  optDbgClearFaults(): void;
  /** H591: flips life._testMode so the DEBUG panel renders/hides
   *  immediately. Mirrors the "test" character-creation path but
   *  is reachable mid-run from the OPT tab. */
  optToggleTestMode(): void;
  /** H770: flips life.gameplaySettings.disableTraffic. Clears the
   *  in-flight traffic pool when toggled ON so the streets empty
   *  immediately; gameLoop refills on toggle OFF. Lives in the
   *  OPT-tab DEBUG (test mode) block. */
  optToggleDisableTraffic(): void;
  /** H771: flips life.gameplaySettings.disablePcOverlay. Collapses
   *  pcCanvas to 1×1 + hides it on toggle ON so the gameLoop branches
   *  fall through to the mobile single-canvas path; dispatches a
   *  resize on toggle OFF so fitCanvases restores the K=2.5 buffer. */
  optTogglePcOverlay(): void;
  /** H774: flips life.gameplaySettings.disableTrafficSignals to A/B
   *  test whether drawTrafficSignals' colored bulb dots are the
   *  off-color circles the user reports on highway surfaces. */
  optToggleTrafficSignals(): void;
  /** H775: flips life.gameplaySettings.disableStreetlights to A/B
   *  test whether drawStreetlights' warm-yellow halos are the
   *  lighter circles bleeding onto highway asphalt. */
  optToggleStreetlights(): void;
}

/** Top-right HUD corner — tap target the monolith uses to OPEN the
 *  menu while playing. 1:1 with L20992 / L22078. */
export function isMenuOpenCornerHit(tx: number, ty: number, GW: number): boolean {
  return tx > GW - 82 && ty < 64;
}

/** Paints the shell. 1:1 port of monolith L34534-34563 — full-canvas
 *  black backdrop, big "DRIVER CITY" title, 5-tab strip with the
 *  selected tab highlighted cyan. Below the strip a "TAB BODY (TODO)"
 *  placeholder for H193+. */
export function drawPauseMenu(ctx: CanvasRenderingContext2D, opts: PauseMenuOpts): void {
  const { state, GW, GH } = opts;
  if (!state.open) return;

  // H736: GT2 charcoal backdrop (replaces full black).
  // H780: + faint blueprint grid overlay so the pause menu reads as
  // the same GT2 surface family as the dealer/garage screens.
  ctx.fillStyle = GT2_COLORS.bg;
  ctx.fillRect(0, 0, GW, GH);
  drawGt2Backdrop(ctx, GW, GH);

  // Safe-top inset — pushes the pause-menu title, tab strip, and
  // tab-body content down past the upper 5 % camera-punch band on
  // devices like the Samsung S24+. Without it the title and tabs
  // hugged y=22 / y=28 right under the camera and curved-corner
  // clip zone. dy is added to every header y AND to the cy value
  // passed to each per-tab drawer so the body shifts with the strip.
  // The matching offset in handlePauseMenuClick uses the same
  // formula so tap hit-testing stays in sync.
  const safeTop = Math.max(GH * 0.05, 4);
  const dy = safeTop - 4;

  // Title — italic display "DRIVER CITY" matching the poster
  // treatment H729 / H733 / H734 use for screen titles.
  ctx.textAlign = 'center';
  ctx.fillStyle = GT2_COLORS.text;
  ctx.font = 'italic bold 20px monospace';
  ctx.fillText('DRIVER CITY', GW / 2, 22 + dy);

  // Tab strip — H736: GT2 amber tabs. Per the user's button-state
  // policy, the active tab is rendered DARKER (amberDark) — dark =
  // selected/focused, not random emphasis. Inactive tabs get
  // regular amber so the bar reads as a single continuous control.
  const tabSpacing = Math.floor(GW / MENU_TAB_ORDER.length);
  MENU_TAB_ORDER.forEach((t, i) => {
    const tx = Math.floor(tabSpacing / 2) + i * tabSpacing;
    const tw = tabSpacing - 4;
    const active = state.tab === t;
    ctx.fillStyle = active ? GT2_COLORS.amberDark : GT2_COLORS.amber;
    ctx.fillRect(tx - tw / 2, 28 + dy, tw, 18);
    ctx.fillStyle = active ? GT2_COLORS.text : GT2_COLORS.bgDeep;
    ctx.font = 'bold 9px monospace';
    ctx.fillText(TAB_LABELS[t], tx, 40 + dy);
  });

  // Tab-body dispatch. The monolith branches on `menuTab` inside
  // the same drawPlaying block at L34566+; we mirror that with one
  // helper per tab. Bodies that need LIFE early-return to the
  // placeholder for pre-playing-state opens (shouldn't happen in
  // practice — the open-tap guard requires gameState='playing' —
  // but defensive).
  const cy = 56 + dy; // monolith L34565 — first content y below the tab strip
  if (state.tab === 'car' && opts.life) {
    drawStatusTab(ctx, opts.life, GW, GH, cy);
  } else if (state.tab === 'lot' && opts.life) {
    drawLotTab(ctx, opts.life, GW, GH, cy);
  } else if (state.tab === 'jobs' && opts.life) {
    drawJobsTab(ctx, opts.life, opts.clock, GW, GH, cy);
  } else if (state.tab === 'race' && opts.life) {
    drawRaceTab(ctx, opts.life, GW, GH, cy);
  } else if (state.tab === 'cal') {
    drawCalTab(ctx, opts.clock, opts.life, GW, GH, cy);
  } else if (state.tab === 'opt' && opts.life) {
    drawOptTab(ctx, opts.life, GW, GH, cy);
  } else {
    drawTabPlaceholder(ctx, state.tab, GW, GH);
  }

  // CLOSE — single amber pill at the bottom. H736 collapses the
  // old paired "X CLOSE" red label (at GH-14) and orange-stroked
  // CLOSE button (at GH-40) into one element, eliminating the
  // visible-overlap render bug visible in the user's screenshot.
  const cbx = GW / 2 - 50;
  const cby = GH - 32;
  ctx.fillStyle = GT2_COLORS.amber;
  pmFillRoundRect(ctx, cbx, cby, 100, 24, 5);
  ctx.fillStyle = GT2_COLORS.bgDeep;
  ctx.font = 'bold 11px monospace';
  ctx.fillText('× CLOSE (M)', GW / 2, cby + 16);

  ctx.textAlign = 'left';
}

/** Local rounded-rect helper — same shape as the home overlay's
 *  fillRoundRectHome. Kept module-local to avoid coupling to the
 *  exact gt2Chrome export surface. */
function pmFillRoundRect(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
  ctx.fill();
}

/** H816: GT2 labeled stat bar — charcoal track, amber fill (signal-
 *  orange below 35%), label inside-left on the fill, value inside-right
 *  on the track. Same language as the eat-tab (drawGt2StatBar) and
 *  gas-station (drawCondBar) bars; the pause STATUS tab is the third
 *  consumer, so this is the canonical local copy (hoist to gt2Chrome
 *  if a fourth appears). */
function drawStatusBar(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
  label: string, pct: number, valueText: string,
): void {
  const C = GT2_COLORS;
  const v = Math.max(0, Math.min(100, pct || 0));
  ctx.fillStyle = C.bgDeep;
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = v < 35 ? C.active : C.amber;
  ctx.fillRect(x, y, Math.round((w * v) / 100), h);
  ctx.strokeStyle = C.amberDark;
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  ctx.font = 'bold 8px monospace';
  ctx.textAlign = 'left';
  ctx.fillStyle = C.bgDeep;             // dark label on the fill (left edge)
  ctx.fillText(label, x + 4, y + h - 3);
  ctx.textAlign = 'right';
  // The value sits at the RIGHT edge — only on the amber fill when the
  // bar is nearly full, so dark text only then; light on the track
  // otherwise (fixes the invisible mid-fill value, e.g. fitness 55%).
  ctx.fillStyle = v >= 95 ? C.bgDeep : C.text;
  ctx.fillText(valueText, x + w - 4, y + h - 3);
  ctx.textAlign = 'center';
}

/** H816: small labeled condition bar (for the 5-up car-condition row).
 *  Label above, percent inside — same as the gas-station mechanic tab. */
function drawStatusCondBar(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, label: string, pct: number,
): void {
  const C = GT2_COLORS;
  const v = Math.max(0, Math.min(100, pct || 0));
  ctx.textAlign = 'center';
  ctx.fillStyle = C.textMute;
  ctx.font = '7px monospace';
  ctx.fillText(label, x + w / 2, y);
  const barY = y + 3;
  const h = 10;
  ctx.fillStyle = C.bgDeep;
  ctx.fillRect(x, barY, w, h);
  ctx.fillStyle = v < 35 ? C.active : C.amber;
  ctx.fillRect(x, barY, Math.round((w * v) / 100), h);
  ctx.strokeStyle = C.amberDark;
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, barY + 0.5, w - 1, h - 1);
  ctx.fillStyle = v < 50 ? C.text : C.bgDeep;
  ctx.font = 'bold 7px monospace';
  ctx.fillText(Math.round(v) + '%', x + w / 2, barY + 8);
}

/** H193: STATUS tab — player block (portrait + alias/age/job/money +
 *  Health + Fitness bars + hunger/sleep warnings + divider). Vehicle
 *  block (sprite preview, condition specs, faults, SWITCH CAR
 *  button) ports in H194.
 *
 *  1:1 port of monolith L34576-34628. */
function drawStatusTab(
  ctx: CanvasRenderingContext2D,
  life: LifeState,
  GW: number,
  _GH: number,
  cy: number,
): void {
  // ---- PLAYER BLOCK ----
  // Portrait — 32×32 body sprite cropped from the character-base
  // sheet. Build column auto-selects from current fitness; gender
  // selects the row. H199 (this commit) wired drawCharacterBase in
  // place of the H193 placeholder rect. 1:1 with monolith L34581-
  // 34583.
  const _stPortS = 32;
  drawCharacterBase(ctx, life.gender, life.fitness, life.skinTone, 8, cy + 2, _stPortS);
  ctx.strokeStyle = GT2_COLORS.amber;
  ctx.lineWidth = 1;
  ctx.strokeRect(8, cy + 2, _stPortS, _stPortS);

  // Right-of-portrait info column. H736: GT2 retint — money in
  // amber Cr instead of green $.
  ctx.textAlign = 'left';
  ctx.fillStyle = GT2_COLORS.text;
  ctx.font = 'bold 11px monospace';
  ctx.fillText(life.playerAlias + ' · ' + life.age, 46, cy + 12);
  ctx.fillStyle = GT2_COLORS.textMute;
  ctx.font = '9px monospace';
  ctx.fillText(life.playerJob || 'Unemployed', 46, cy + 24);
  ctx.fillStyle = GT2_COLORS.amber;
  ctx.font = 'bold 10px monospace';
  ctx.fillText('$' + life.money.toLocaleString(), 46, cy + 36);

  ctx.textAlign = 'center';
  const _bX = 10;
  const _bW = GW - 20;
  const _bH = 12;

  // H816: Health / Fitness as GT2 amber bars (were neon green/yellow
  // with embedded green text — the GBC-era look the user flagged). The
  // status word (Excellent / Active / …) rides as the bar value.
  const _hsSt = getHealthStatus(life.health);
  const _hbY = cy + 42;
  drawStatusBar(ctx, _bX, _hbY, _bW, _bH, 'HEALTH',
    life.health, Math.round(life.health) + '% · ' + _hsSt.label);

  const _fsSt = getFitnessStatus(life.fitness);
  const _fbY = cy + 56;
  drawStatusBar(ctx, _bX, _fbY, _bW, _bH, 'FITNESS',
    life.fitness, Math.round(life.fitness) + '% · ' + _fsSt.label);

  // Status warnings (hunger / sleep). H816: emoji dropped, GT2 signal-
  // orange instead of pink.
  const warn: string[] = [];
  if (life.daysSinceEat >= 2) warn.push('STARVING');
  else if (life.daysSinceEat >= 1) warn.push('HUNGRY');
  if (life.daysSinceSleep >= 2) warn.push('EXHAUSTED');
  else if (life.daysSinceSleep >= 1) warn.push('TIRED');
  let extraY = 0;
  if (warn.length > 0) {
    ctx.fillStyle = GT2_COLORS.active;
    ctx.font = 'bold 8px monospace';
    ctx.fillText(warn.join(' · '), GW / 2, cy + 80);
    extraY = 11;
  }

  // Divider — GT2 amber rule (H816: was grey; matches the other
  // polished screens' section rules).
  const divY = cy + 84 + extraY;
  ctx.fillStyle = GT2_COLORS.amberDim;
  ctx.fillRect(10, divY, GW - 20, 1);

  // ---- VEHICLE BLOCK ----
  // Resolves the active car from ownedCars[0] (same convention the
  // rest of the modular runtime uses). When no car is owned we
  // surface a "no vehicle" line so the layout doesn't collapse.
  const activeCarId = life.ownedCars[0];
  const car = activeCarId ? CAR_CATALOG[activeCarId] : undefined;
  if (!car) {
    ctx.fillStyle = GT2_COLORS.textDim;
    ctx.font = '10px monospace';
    ctx.fillText('— no vehicle —', GW / 2, divY + 24);
    return;
  }

  // H736: GT2 italic display car name (was cyan bold).
  const vY = divY + 10;
  ctx.fillStyle = GT2_COLORS.text;
  ctx.font = 'italic bold 13px monospace';
  ctx.fillText(car.name, GW / 2, vY);

  const originLabel = vehicleOriginLabel(car);
  const tierLabel = mileageTierLabel(life.carOdometers?.[activeCarId] ?? 0);
  const odoLabel = fmtOdoFor(activeCarId, life, car);
  ctx.fillStyle = GT2_COLORS.textMute;
  ctx.font = '9px monospace';
  ctx.fillText(originLabel + ' · ' + tierLabel + ' · ' + odoLabel, GW / 2, vY + 12);

  // Sprite preview band. Calls drawTopCar with a static preview-
  // deps bundle (previewDepsForCar) so the actual top-down sprite
  // / V2 vector renders here, not the H194 colored-rect placeholder.
  // 1:1 with monolith L34644-34660: translate + scale to fit a
  // 57-tall band, then drawTopCar at origin with angle=0
  // (front-pointing-right). drawTopCar restores ctx state on
  // return so the post-draw save/restore wrapping isn't needed.
  const spZoneY = vY + 18;
  const spZoneH = 57;
  const sp: readonly [number, number] = car.size ?? [20, 8];
  const spMaxW = GW - 40;
  const spMaxH = spZoneH - 6;
  const spScale = Math.min(spMaxW / sp[0], spMaxH / sp[1]);
  ctx.save();
  ctx.translate(GW / 2, spZoneY + spZoneH / 2);
  ctx.scale(spScale, spScale);
  drawTopCar(
    ctx,
    { cx: 0, cy: 0, angle: 0, color: car.color, isPlayer: true, steerAngle: 0 },
    previewDepsForCar(car),
  );
  ctx.restore();

  // H816: car condition as a 5-up GT2 bar row (was plain
  // "Eng:100% Tire:100% …" text — the other half of the GBC readout
  // the user flagged). Engine/tires/body/paint/fuel each get a small
  // labeled bar, signal-orange when worn.
  const cY = spZoneY + spZoneH + 16;
  const condN = 5;
  const condGap = 5;
  const condW = (GW - 20 - (condN - 1) * condGap) / condN;
  const conds: ReadonlyArray<{ label: string; v: number }> = [
    { label: 'ENG',  v: life.engine },
    { label: 'TIRE', v: life.tires },
    { label: 'BODY', v: life.carHP },
    { label: 'PNT',  v: life.paint },
    { label: 'FUEL', v: life.fuel },
  ];
  for (let i = 0; i < condN; i++) {
    drawStatusCondBar(ctx, 10 + i * (condW + condGap), cY, condW, conds[i].label, conds[i].v);
  }
  ctx.fillStyle = GT2_COLORS.amber;
  ctx.font = 'bold 10px monospace';
  ctx.fillText(
    'Transmission · ' + (life.isManual ? 'MANUAL' : 'AUTOMATIC'),
    GW / 2,
    cY + 30,
  );

  // H255: diagnosed faults section. 1:1 with L34675-34695 including
  // the per-fault FAULT_EFFECTS desc line that landed in H247.
  // Body-damage faults (hl_headlightL etc. from src/sim/faults.ts)
  // don't have FAULT_EFFECTS entries — they fall through to the
  // 11px name-only row, matching the monolith's two-branch layout.
  // H816: GT2 signal-orange + no emoji (was pink + warning glyph),
  // matching the dealership KNOWN ISSUES block.
  let fEndY = cY + 38;
  const faults = (life.faults ?? []) as Array<{ name?: string; id?: string }>;
  if (faults.length > 0) {
    ctx.fillStyle = GT2_COLORS.active;
    ctx.font = 'bold 9px monospace';
    ctx.fillText('DIAGNOSED ISSUES', GW / 2, fEndY + 4);
    let fy = fEndY + 14;
    for (const f of faults) {
      ctx.fillStyle = GT2_COLORS.active;
      ctx.font = 'bold 9px monospace';
      ctx.fillText('· ' + (f.name ?? 'Unknown'), GW / 2, fy);
      const eff = f.id ? FAULT_EFFECTS[f.id] : undefined;
      if (eff?.desc) {
        ctx.fillStyle = GT2_COLORS.textMute;
        ctx.font = '8px monospace';
        ctx.fillText(eff.desc, GW / 2, fy + 9);
        fy += 20;
      } else {
        fy += 11;
      }
    }
    ctx.fillStyle = GT2_COLORS.textDim;
    ctx.font = '8px monospace';
    ctx.fillText('Fix at home garage, mechanic, or dealership', GW / 2, fy + 2);
    fEndY = fy + 8;
  }

  // SWITCH CAR button — GT2 amber pill (was grey-stroked
  // translucent panel). Regular amber face per the H734 button
  // policy (dark = selected, not random emphasis).
  const switchY = fEndY + 4;
  ctx.fillStyle = GT2_COLORS.amber;
  pmFillRoundRect(ctx, 25, switchY, GW - 50, 22, 4);
  ctx.fillStyle = GT2_COLORS.bgDeep;
  ctx.font = 'bold 11px monospace';
  ctx.fillText('SWITCH CAR (C)', GW / 2, switchY + 14);
  (life as { _statusSwitchY?: number })._statusSwitchY = switchY;
}

// H530: mileageTierLabel is now backed by the canonical
// getMileageTierLabel helper in src/sim/mileageTier.ts (both
// pause-menu STATUS + the H535-wired diagnoseFault chain share
// one classifier). Imported below.

/** Origin emoji + label ('🇯🇵 JPN' etc). Falls through to '???'
 *  for the four sub-European catalog tags (ita/fra/ger/gbr) —
 *  matches monolith L34634 `{jpn,usa,eur}[CAR().origin]||'???'`
 *  which only carries flags for the three FAULT_POOLS-aligned
 *  regional buckets. */
function vehicleOriginLabel(car: CatalogCar): string {
  // H816: typographic codes (no flag emoji), matching the dealership.
  if (car.origin === 'jpn') return 'JDM';
  if (car.origin === 'usa') return 'USA';
  if (car.origin === 'eur') return 'EURO';
  return '—';
}

/** Per-car odometer formatter — picks km vs mi via getEffectiveRHD.
 *  1:1 with monolith fmtOdo at L8987. */
function fmtOdoFor(carId: string, life: LifeState, car: CatalogCar): string {
  const raw = life.carOdometers?.[carId] ?? 0;
  const isKm = getEffectiveRHD(carId, life, carId, CAR_CATALOG);
  const dist = isKm ? raw * KM_PER_GAME_UNIT : raw * MILES_PER_GAME_UNIT;
  const label = isKm ? 'km' : 'mi';
  return dist >= 1000 ? (dist / 1000).toFixed(1) + 'k ' + label : dist.toFixed(1) + ' ' + label;
}

/** Per-job perk hint strings. 1:1 with monolith L34729 inline map. */
const JOB_PERKS: Record<JobName, string> = {
  'FOOD DELIVERY':   'Free meal',
  'AUTO PARTS RUN':  '10% part discount',
  'PACKAGE COURIER': '',
  'PARAMEDIC':       '',
  'TOW TRUCK':       '',
  'TRAFFIC COP':     'Ticket bonuses',
  'TRUCK DRIVER':    '',
  'FUEL TANKER':     'Free fuel',
  'OFFICE JOB':      '',
};

/** Short date string for the JOBS-tab header. H521 wired the real
 *  getDateString helper (config/calendar.ts) — now returns
 *  "Day N · DOW MON DD" so the JOBS-tab header surfaces the same
 *  calendar context as the day-rollover notif. */
function shortDateLine(clock: Clock): string {
  return 'Day ' + clock.day + ' · ' + getDateString(clock.day);
}

/** H593: LOT tab. Used-car lot browser inside the pause menu —
 *  8 catalog picks with cond %, age-realistic mileage, and
 *  cond-scaled price. Lazy-fills life._carLot on first open so
 *  the lot stays stable until a row sells (or RESHUFFLE is hit).
 *  Tap a row to open the inspection modal (the modal already
 *  ports H208, owns the buy/walk flow). 1:1 with monolith
 *  L34705-L34720 + L21158-L21167 click handler. */
function drawLotTab(
  ctx: CanvasRenderingContext2D,
  life: LifeState,
  GW: number,
  _GH: number,
  cy: number,
): void {
  if (!life._carLot || life._carLot.length === 0) {
    life._carLot = generateCarLot(0);
  }
  const lot = life._carLot;
  ctx.fillStyle = '#aaa';
  ctx.font = 'bold 12px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('USED CAR LOT', GW / 2, cy);

  const rowH = 30;
  const hits: Array<{ x: number; y: number; w: number; h: number; idx: number }> = [];
  for (let i = 0; i < lot.length; i++) {
    const cl = lot[i];
    const car = CAR_CATALOG[cl.id];
    const ly = cy + 10 + i * rowH;
    const canBuy = life.money >= cl.price;
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(6, ly, GW - 12, 26);
    ctx.strokeStyle = canBuy ? '#888' : '#333';
    ctx.lineWidth = 1;
    ctx.strokeRect(6, ly, GW - 12, 26);
    if (car) {
      ctx.fillStyle = car.color;
      ctx.fillRect(10, ly + 4, 12, 18);
    }
    ctx.fillStyle = canBuy ? '#0f0' : '#666';
    ctx.font = 'bold 9px monospace';
    ctx.textAlign = 'left';
    ctx.fillText(cl.name, 26, ly + 10);
    ctx.fillStyle = '#888';
    ctx.font = '9px monospace';
    const lotMi = cl.isNew
      ? 'NEW'
      : (cl.mileage >= 1000
        ? Math.round(cl.mileage / 1000) + 'k mi'
        : cl.mileage + ' mi');
    const hp = car ? car.hp + 'hp ' : '';
    ctx.fillText(
      '$' + cl.price.toLocaleString() + ' ' + cl.cond + '% ' + hp + lotMi,
      26, ly + 21,
    );
    hits.push({ x: 6, y: ly, w: GW - 12, h: 26, idx: i });
  }

  // RESHUFFLE button so the player can re-roll the lot without
  // sleeping. Monolith reshuffles on day-rollover; the modular
  // doesn't yet, so the button keeps the lot from feeling stale.
  const reY = cy + 10 + lot.length * rowH + 6;
  ctx.fillStyle = 'rgba(0,140,200,0.18)';
  ctx.fillRect(40, reY, GW - 80, 22);
  ctx.strokeStyle = '#08a';
  ctx.strokeRect(40, reY, GW - 80, 22);
  ctx.fillStyle = '#0ff';
  ctx.font = 'bold 10px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('🔁 RESHUFFLE LOT', GW / 2, reY + 14);

  ctx.textAlign = 'left';
  (life as { _lotRowHits?: typeof hits; _lotReshuffleRect?: { x: number; y: number; w: number; h: number } })
    ._lotRowHits = hits;
  (life as { _lotReshuffleRect?: { x: number; y: number; w: number; h: number } })
    ._lotReshuffleRect = { x: 40, y: reY, w: GW - 80, h: 22 };
}

/** H195: JOBS tab. Career header (alias/job, date, salary, perk,
 *  health/food) + state-branch (active job / done today / unemployed
 *  with listings / has-job-not-yet-worked with availJobs). Two
 *  branches dormant: unemployed-listings depends on _jobListings
 *  populator (port pending); has-job availJobs depends on a daily-
 *  job roller (port pending). Both render their empty-state copy.
 *  Mirrors monolith L34721-34791. */
function drawJobsTab(
  ctx: CanvasRenderingContext2D,
  life: LifeState,
  clock: Clock,
  GW: number,
  _GH: number,
  cy: number,
): void {
  ctx.textAlign = 'center';

  // ---- HEADER ----
  // The first line was previously at `cy - 8`, which drew INTO the
  // tab-strip area above (visually overlapping the JOBS tab label —
  // pre-existing rendering bug). Bumped to `cy + 8` so the body
  // starts CLEANLY below the strip, and the subsequent lines shift
  // by the same 16 px so the layout stays cohesive.
  ctx.fillStyle = '#888';
  ctx.font = '10px monospace';
  ctx.fillText(life.playerAlias + ' — ' + (life.playerJob || 'Unemployed'), GW / 2, cy + 8);
  ctx.fillText(shortDateLine(clock), GW / 2, cy + 20);

  const jobKey = life.playerJob as JobName | '' | undefined;
  const sal = jobKey && JOB_SALARY[jobKey as JobName] ? JOB_SALARY[jobKey as JobName] : 0;
  ctx.fillStyle = GT2_COLORS.amber;
  ctx.font = 'bold 11px monospace';
  ctx.fillText('Salary: $' + sal + '/day', GW / 2, cy + 34);

  const perk = jobKey && jobKey in JOB_PERKS ? JOB_PERKS[jobKey as JobName] : '';
  ctx.fillStyle = GT2_COLORS.amber;
  ctx.font = '10px monospace';
  ctx.fillText('Perk: ' + (perk || 'None'), GW / 2, cy + 46);

  const _hs = getHealthStatus(life.health);
  ctx.fillStyle = '#aaa';
  ctx.font = '10px monospace';
  ctx.fillText(
    _hs.icon + ' Health:' + Math.round(life.health) + '% • Food:' + getTotalFood(life.foodStock),
    GW / 2,
    cy + 60,
  );

  // ---- STATE BRANCH ----
  // Body offsets bumped by the same 16 px the header shifted (cy-8
  // → cy+8), so the JOB rows / SKIP WORK / QUIT JOB controls keep
  // their original spacing relative to the header.
  if (life.job) {
    // Active job — show type/pay + status + QUIT JOB. 1:1 with
    // monolith L34735-34743.
    ctx.fillStyle = GT2_COLORS.active;
    ctx.font = 'bold 12px monospace';
    const status = life.job.pickedUp ? 'DELIVERING' : 'GO TO PICKUP';
    ctx.fillText(life.job.type + ' — $' + life.job.pay, GW / 2, cy + 76);
    ctx.fillStyle = GT2_COLORS.amber;
    ctx.font = '11px monospace';
    ctx.fillText(status, GW / 2, cy + 90);
    ctx.fillStyle = 'rgba(247, 166, 35, 0.10)';
    ctx.fillRect(25, cy + 96, GW - 50, 20);
    ctx.strokeStyle = GT2_COLORS.amber;
    ctx.lineWidth = 1;
    ctx.strokeRect(25, cy + 96, GW - 50, 20);
    ctx.fillStyle = GT2_COLORS.amberDark;
    ctx.font = 'bold 11px monospace';
    ctx.fillText('QUIT JOB', GW / 2, cy + 110);
    (life as { _jobsQuitY?: number })._jobsQuitY = cy + 96;
    return;
  }

  if (life.jobDoneToday) {
    // Confirmation. 1:1 with L34744-34748.
    ctx.fillStyle = GT2_COLORS.active;
    ctx.font = 'bold 12px monospace';
    ctx.fillText('JOB DONE TODAY!', GW / 2, cy + 78);
    ctx.fillStyle = GT2_COLORS.amber;
    ctx.font = '11px monospace';
    ctx.fillText('Go Home to start next day', GW / 2, cy + 94);
    return;
  }

  if (!life.playerJob) {
    // Unemployed — show _jobListings to apply for. 1:1 with L34749-
    // 34770. Generator that fills _jobListings is un-ported, so we
    // render the empty state until it lands.
    ctx.fillStyle = GT2_COLORS.amberDark;
    ctx.font = 'bold 12px monospace';
    ctx.fillText(life._fired ? 'YOU GOT FIRED' : 'UNEMPLOYED', GW / 2, cy + 70);
    ctx.fillStyle = '#aaa';
    ctx.font = '10px monospace';
    ctx.fillText('Apply for available positions:', GW / 2, cy + 84);
    const listings = life._jobListings ?? [];
    if (listings.length === 0) {
      ctx.fillStyle = '#888';
      ctx.font = '10px monospace';
      ctx.fillText('No openings today. Sleep & try tomorrow.', GW / 2, cy + 104);
    } else {
      const listingYs: number[] = [];
      listings.forEach((j, i) => {
        const jy = cy + 94 + i * 36;
        listingYs.push(jy);
        ctx.fillStyle = 'rgba(247, 166, 35, 0.10)';
        ctx.fillRect(15, jy, GW - 30, 30);
        ctx.strokeStyle = GT2_COLORS.amber;
        ctx.lineWidth = 1;
        ctx.strokeRect(15, jy, GW - 30, 30);
        ctx.fillStyle = GT2_COLORS.amber;
        ctx.font = 'bold 11px monospace';
        ctx.fillText(j.name, GW / 2, jy + 13);
        ctx.fillStyle = '#888';
        ctx.font = '10px monospace';
        const sep = j.perk ? ' • ' : ' ';
        ctx.fillText(j.pay + sep + (j.perk ?? '') + (j.perk ? ' • ' : '') + 'TAP TO APPLY', GW / 2, jy + 25);
      });
      (life as { _jobsListingYs?: number[] })._jobsListingYs = listingYs;
    }
    return;
  }

  // Has-job-not-yet-worked branch. 1:1 port of monolith L34772-
  // 34791. Iterates life._availJobs cards + SKIP WORK button below.
  // H200 wired generateDailyJob — caller lazy-fills _availJobs on
  // tab-open when empty. Cached row Y values on life._jobsAvailY
  // so the click router can dispatch ACCEPT taps.
  const availJobs = life._availJobs ?? [];
  const rowYs: number[] = [];
  availJobs.forEach((j, i) => {
    const jy = cy + 68 + i * 36;
    rowYs.push(jy);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
    ctx.fillRect(15, jy, GW - 30, 30);
    ctx.strokeStyle = '#888';
    ctx.lineWidth = 1;
    ctx.strokeRect(15, jy, GW - 30, 30);
    ctx.fillStyle = GT2_COLORS.active;
    ctx.font = 'bold 11px monospace';
    ctx.fillText(j.type + ' — $' + j.pay, GW / 2, jy + 13);
    ctx.fillStyle = '#888';
    ctx.font = '10px monospace';
    ctx.fillText('TAP to accept', GW / 2, jy + 25);
  });
  (life as { _jobsAvailYs?: number[] })._jobsAvailYs = rowYs;

  // SKIP WORK button — anchored after the avail-job rows. 1:1
  // with L34783-34790.
  const skipY = cy + 68 + availJobs.length * 36 + 8;
  ctx.fillStyle = 'rgba(247, 166, 35, 0.10)';
  ctx.fillRect(25, skipY, GW - 50, 26);
  ctx.strokeStyle = GT2_COLORS.amber;
  ctx.strokeRect(25, skipY, GW - 50, 26);
  ctx.fillStyle = GT2_COLORS.amberDark;
  ctx.font = 'bold 11px monospace';
  ctx.fillText('SKIP WORK TODAY', GW / 2, skipY + 12);
  ctx.fillStyle = '#888';
  ctx.font = '9px monospace';
  const repWarn = life.workRep < 20
    ? 'LOW REP — high fire risk!'
    : 'Rep: ' + life.workRep + ' (' + life.consecutiveAbsences + ' consecutive)';
  ctx.fillText('No pay. ' + repWarn, GW / 2, skipY + 22);
  (life as { _jobsSkipY?: number })._jobsSkipY = skipY;
}

/** H196: RACE tab. Three monolith states (L34794-end of race tab):
 *   - life.timeSlot !== 'night' — show "NIGHT SLOT ONLY" gate.
 *   - night + RACE.phase === 'setup' — opponent + stake selector +
 *     accept/decline. RACE struct not on ctx yet — dormant.
 *   - night + active race — handed off to RACE HUD, no menu paint.
 *
 *  H196 ports the always-on gate + a "race subsystem ports later"
 *  placeholder for the night-but-no-race-yet case. The full setup
 *  UI (stake selector with money/car/house tabs, bet controls,
 *  accept/decline) lands when the RACE state machine ports. */
function drawRaceTab(
  ctx: CanvasRenderingContext2D,
  life: LifeState,
  GW: number,
  _GH: number,
  cy: number,
): void {
  ctx.textAlign = 'center';
  const isNight = life.timeSlot === 'night';

  if (!isNight) {
    // NIGHT SLOT ONLY gate. 1:1 with monolith L34798-34803.
    ctx.fillStyle = GT2_COLORS.amber;
    ctx.font = 'bold 12px monospace';
    ctx.fillText('NIGHT SLOT ONLY', GW / 2, cy + 10);
    ctx.fillStyle = '#888';
    ctx.font = '10px monospace';
    ctx.fillText('Street races happen at night.', GW / 2, cy + 26);
    ctx.fillStyle = '#666';
    ctx.font = '9px monospace';
    ctx.fillText('Go home and choose the NIGHT slot.', GW / 2, cy + 42);
    return;
  }

  // H220: setup-phase top section — opponent + tier comparison.
  // 1:1 port of monolith L34806-34820. Stake selector + bet ±
  // controls + accept/decline land in H221+ commits; for now the
  // setup body shows who the player would race and how the tiers
  // line up. Without a race written to life.race, render a "TAP
  // TO START" prompt that fillRaceTab triggers on tab entry.
  const race = life.race;
  ctx.fillStyle = GT2_COLORS.active;
  ctx.font = 'bold 14px monospace';
  ctx.fillText('1v1 STREET RACE', GW / 2, cy);

  if (!race || race.phase !== 'setup') {
    ctx.fillStyle = '#666';
    ctx.font = '10px monospace';
    ctx.fillText('No race rolled yet — re-enter tab to pick an opponent.', GW / 2, cy + 24);
    return;
  }

  const oppCar = CAR_CATALOG[race.oppId];
  if (!oppCar) {
    ctx.fillStyle = GT2_COLORS.amberDark;
    ctx.font = '10px monospace';
    ctx.fillText('Opponent missing from catalog — re-enter tab.', GW / 2, cy + 24);
    return;
  }

  // VS line.
  ctx.fillStyle = GT2_COLORS.text;
  ctx.font = 'bold 11px monospace';
  ctx.fillText('VS: ' + race.oppName, GW / 2, cy + 18);
  ctx.fillStyle = '#aaa';
  ctx.font = '10px monospace';
  ctx.fillText(oppCar.hp + 'hp ' + oppCar.kg + 'kg ' + oppCar.drv, GW / 2, cy + 32);

  // Player car line.
  const activeCarId = life.ownedCars[0];
  const playerCar = activeCarId ? CAR_CATALOG[activeCarId] : undefined;
  ctx.fillStyle = GT2_COLORS.amber;
  ctx.font = '10px monospace';
  if (playerCar) {
    ctx.fillText('YOU: ' + playerCar.name + ' (' + playerCar.hp + 'hp)', GW / 2, cy + 48);
  } else {
    ctx.fillText('YOU: — no car —', GW / 2, cy + 48);
  }

  // Tier match indicator — active when matched, amberDark on mismatch.
  if (playerCar) {
    const pTier = getRaceTier(playerCar.hp);
    const oTier = getRaceTier(oppCar.hp);
    ctx.fillStyle = pTier === oTier ? GT2_COLORS.active : GT2_COLORS.amberDark;
    ctx.font = 'bold 9px monospace';
    ctx.fillText('TIER: ' + RACE_TIER_NAMES[pTier] + ' vs ' + RACE_TIER_NAMES[oTier], GW / 2, cy + 62);
  }

  // H221: stake-type tab strip (MONEY / CAR / HOUSE).
  // Auto-snaps to MONEY when the current selection becomes
  // ineligible (sold last eligible car, etc). 1:1 port of monolith
  // L34832-34850. Tab rects cached on life._raceStakeTabRects for
  // the click router; only eligible tabs land in the cache so a
  // tap on a greyed-out tab falls through silently.
  normalizeStakeType(life);
  const stakeCars = getEligibleStakeCars(life);
  const houseVal = getHouseStakeValue(life);
  const canStakeCar = stakeCars.length > 0;
  const canStakeHouse = houseVal > 0;

  const stakeTabs: Array<{ key: RaceStakeType; label: string; enabled: boolean }> = [
    { key: 'money', label: 'MONEY', enabled: true },
    { key: 'car',   label: 'CAR',   enabled: canStakeCar },
    { key: 'house', label: 'HOUSE', enabled: canStakeHouse },
  ];
  const stTW = (GW - 40) / 3;
  const stTY = cy + 72;
  const stTabRects: Array<{ x: number; y: number; w: number; h: number; key: RaceStakeType }> = [];
  stakeTabs.forEach((tb, i) => {
    const stTx = 20 + i * stTW;
    const active = race.stakeType === tb.key;
    const col = !tb.enabled ? '#333' : active ? GT2_COLORS.active : '#888';
    ctx.fillStyle = active
      ? 'rgba(255, 122, 24, 0.18)'
      : tb.enabled
        ? 'rgba(255, 255, 255, 0.04)'
        : 'rgba(60, 60, 60, 0.15)';
    ctx.fillRect(stTx, stTY, stTW - 4, 20);
    ctx.strokeStyle = col;
    ctx.lineWidth = active ? 1.2 : 0.5;
    ctx.strokeRect(stTx, stTY, stTW - 4, 20);
    ctx.fillStyle = col;
    ctx.font = 'bold 9px monospace';
    ctx.fillText(tb.label, stTx + (stTW - 4) / 2, stTY + 13);
    if (tb.enabled) {
      stTabRects.push({ x: stTx, y: stTY, w: stTW - 4, h: 20, key: tb.key });
    }
  });
  ctx.lineWidth = 1;
  (life as { _raceStakeTabRects?: typeof stTabRects })._raceStakeTabRects = stTabRects;

  // H222: stake-specific body at y=cy+96..cy+138 + cash line +
  // START RACE button + DIFFERENT OPPONENT button. Rects cached
  // on life._raceStakeRects for the click router (covers ALL
  // taps on the bet/cycle/start/reroll widgets — keeps the
  // dispatcher table flat).
  const stakeRects: Record<string, { x: number; y: number; w: number; h: number }> = {};
  const bY = cy + 96;
  const activeCarIdForVal = life.ownedCars[0] ?? null;

  if (race.stakeType === 'money') {
    // BET text + ± buttons.
    ctx.fillStyle = GT2_COLORS.amber;
    ctx.font = 'bold 14px monospace';
    ctx.fillText('BET: $' + race.betInput, GW / 2, bY + 10);
    const minusX = 40;
    const plusX = GW - 90;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.15)';
    ctx.fillRect(minusX, bY + 20, 50, 22);
    ctx.fillRect(plusX, bY + 20, 50, 22);
    ctx.strokeStyle = '#888';
    ctx.lineWidth = 1;
    ctx.strokeRect(minusX, bY + 20, 50, 22);
    ctx.strokeRect(plusX, bY + 20, 50, 22);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 14px monospace';
    ctx.fillText('−', minusX + 25, bY + 35);
    ctx.fillText('+', plusX + 25, bY + 35);
    stakeRects.minus = { x: minusX, y: bY + 20, w: 50, h: 22 };
    stakeRects.plus = { x: plusX, y: bY + 20, w: 50, h: 22 };
  } else if (race.stakeType === 'car') {
    // Auto-pick / re-sync stakeCarId if missing or no longer
    // eligible. 1:1 with monolith L34872.
    if (!race.stakeCarId || !stakeCars.includes(race.stakeCarId)) {
      race.stakeCarId = stakeCars[0];
    }
    const sc = race.stakeCarId;
    const scCar = sc ? CAR_CATALOG[sc] : undefined;
    if (scCar && sc) {
      const scVal = getCarValue(life, sc, activeCarIdForVal);
      ctx.fillStyle = GT2_COLORS.amber;
      ctx.font = 'bold 11px monospace';
      ctx.fillText('STAKING: ' + scCar.name, GW / 2, bY + 10);
      ctx.fillStyle = GT2_COLORS.active;
      ctx.font = '10px monospace';
      ctx.fillText(
        'Value: $' + scVal.toLocaleString() + (sc === activeCarIdForVal ? ' (your current ride)' : ''),
        GW / 2, bY + 26,
      );
      if (stakeCars.length > 1) {
        const prevX = 40;
        const nextX = GW - 90;
        ctx.fillStyle = 'rgba(255, 255, 255, 0.15)';
        ctx.fillRect(prevX, bY + 34, 50, 20);
        ctx.fillRect(nextX, bY + 34, 50, 20);
        ctx.strokeStyle = '#888';
        ctx.strokeRect(prevX, bY + 34, 50, 20);
        ctx.strokeRect(nextX, bY + 34, 50, 20);
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 11px monospace';
        ctx.fillText('◀ PREV', prevX + 25, bY + 48);
        ctx.fillText('NEXT ▶', nextX + 25, bY + 48);
        ctx.fillStyle = '#888';
        ctx.font = '8px monospace';
        ctx.fillText(
          (stakeCars.indexOf(sc) + 1) + ' / ' + stakeCars.length,
          GW / 2, bY + 48,
        );
        stakeRects.prevCar = { x: prevX, y: bY + 34, w: 50, h: 20 };
        stakeRects.nextCar = { x: nextX, y: bY + 34, w: 50, h: 20 };
      } else {
        ctx.fillStyle = '#666';
        ctx.font = '8px monospace';
        ctx.fillText('(only eligible car)', GW / 2, bY + 42);
      }
    }
  } else if (race.stakeType === 'house') {
    const tier = HOUSING_TIERS[life.housingType as HousingTierKey];
    ctx.fillStyle = GT2_COLORS.amber;
    ctx.font = 'bold 11px monospace';
    ctx.fillText('STAKING: ' + (tier?.name ?? 'home'), GW / 2, bY + 10);
    ctx.fillStyle = GT2_COLORS.active;
    ctx.font = '10px monospace';
    ctx.fillText('Value: $' + houseVal.toLocaleString() + ' (owned free & clear)', GW / 2, bY + 26);
    ctx.fillStyle = GT2_COLORS.amberDark;
    ctx.font = '8px monospace';
    ctx.fillText('Lose = downgrade to 1BR Apartment', GW / 2, bY + 42);
  }

  // Cash display.
  ctx.fillStyle = GT2_COLORS.amber;
  ctx.font = '10px monospace';
  ctx.fillText('Cash: $' + life.money.toLocaleString(), GW / 2, cy + 148);

  const canRace = race.stakeType === 'money'
    ? life.money >= race.betInput && race.betInput >= RACE_BET_MIN
    : race.stakeType === 'car'
      ? !!race.stakeCarId
      : houseVal > 0;

  // H829/H830: START-MODE selector — three segments for how the rival
  // appears. BESIDE (L1) spawns alongside; TRAFFIC (L2) peels out of
  // traffic and pulls up; MEET (L3) waits parked at a spot you drive to.
  const modeDefs: Array<{ key: RaceStartMode; label: string }> = [
    { key: 'instant', label: 'BESIDE' },
    { key: 'rolling', label: 'TRAFFIC' },
    { key: 'meet',    label: 'MEET' },
  ];
  const mW = (GW - 40) / 3;
  const mY = cy + 150;
  const modeRects: Array<{ x: number; y: number; w: number; h: number; key: RaceStartMode }> = [];
  modeDefs.forEach((md, i) => {
    const mx = 20 + i * mW;
    const active = race.startMode === md.key;
    ctx.fillStyle = active ? 'rgba(255, 122, 24, 0.20)' : 'rgba(255, 255, 255, 0.04)';
    ctx.fillRect(mx, mY, mW - 4, 22);
    ctx.strokeStyle = active ? GT2_COLORS.active : '#666';
    ctx.lineWidth = active ? 1.2 : 0.5;
    ctx.strokeRect(mx, mY, mW - 4, 22);
    ctx.fillStyle = active ? GT2_COLORS.active : '#888';
    ctx.font = 'bold 9px monospace';
    ctx.fillText(md.label, mx + (mW - 4) / 2, mY + 14);
    modeRects.push({ x: mx, y: mY, w: mW - 4, h: 22, key: md.key });
  });
  ctx.lineWidth = 1;
  (life as { _raceModeRects?: typeof modeRects })._raceModeRects = modeRects;

  // START RACE button — uses the selected mode.
  ctx.fillStyle = canRace ? 'rgba(255, 122, 24, 0.20)' : 'rgba(100, 100, 100, 0.2)';
  ctx.fillRect(30, cy + 178, GW - 60, 26);
  ctx.strokeStyle = canRace ? GT2_COLORS.active : '#444';
  ctx.lineWidth = 2;
  ctx.strokeRect(30, cy + 178, GW - 60, 26);
  ctx.fillStyle = canRace ? GT2_COLORS.active : '#666';
  ctx.font = 'bold 14px monospace';
  ctx.fillText('START RACE', GW / 2, cy + 195);
  ctx.lineWidth = 1;
  if (canRace) stakeRects.startRace = { x: 30, y: cy + 178, w: GW - 60, h: 26 };

  // DIFFERENT OPPONENT button — re-rolls the opponent.
  ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
  ctx.fillRect(30, cy + 210, GW - 60, 18);
  ctx.strokeStyle = '#666';
  ctx.strokeRect(30, cy + 210, GW - 60, 18);
  ctx.fillStyle = '#888';
  ctx.font = '10px monospace';
  ctx.fillText('DIFFERENT OPPONENT', GW / 2, cy + 222);
  stakeRects.rerollOpp = { x: 30, y: cy + 210, w: GW - 60, h: 18 };

  (life as { _raceStakeRects?: typeof stakeRects })._raceStakeRects = stakeRects;
}

// H520: CAL_MONTH_NAMES dedupe landed — both this file and
// src/ui/screens/home/overlay.ts now import MONTH_NAMES_FULL from
// the canonical src/config/calendar.ts. The CAL_ alias prefix is
// kept for callsite readability (drawCalTab vs drawCalendarTab
// distinction) but the source is shared.

/** H197: CAL tab. Month grid with today highlighted (cyan) and the
 *  1st of each month flagged with a 'B' bill-due badge. Mirrors the
 *  home-overlay calendar grid (src/ui/screens/home/overlay.ts
 *  drawCalendarTab) but with a tighter top-offset for the pause-menu
 *  shell and no BACK button (the menu's CLOSE button at the bottom
 *  handles exit). 1:1 scope-wise with the monolith CAL tab gate at
 *  L34957 (`drawCalendar()` call from inside the menu paint).
 *
 *  DORMANT: month navigation arrows (LIFE.calViewMonth) — the
 *  modular calendar viewer is current-month-only until that field
 *  + the prev/next arrow taps port. Per-day event badges
 *  (getCalEventsForDay) also defer; only the bill-due badge on the
 *  1st renders. */
function drawCalTab(
  ctx: CanvasRenderingContext2D,
  clock: Clock,
  life: LifeState | null,
  GW: number,
  GH: number,
  cy: number,
): void {
  ctx.textAlign = 'center';

  // H566: calViewMonth offset selects which month to render. The
  // "current" month index is derived from clock.day; the offset
  // lands us on the requested month. Mirrors monolith L46338.
  const currentMonthIdx = Math.floor((clock.day - 1) / DAYS_PER_MONTH);
  const viewOffset = life?.calViewMonth ?? 0;
  const viewMonthIdx = currentMonthIdx + viewOffset;
  const viewMonthOfYear = ((viewMonthIdx % 12) + 12) % 12;
  const monthName = CAL_MONTH_NAMES[viewMonthOfYear];
  const dayOfMonth = ((clock.day - 1) % DAYS_PER_MONTH) + 1;
  // First in-game day of the view month, used to derive its grid col.
  const firstDayGlobal = viewMonthIdx * DAYS_PER_MONTH + 1;
  // Day 1 = Friday (monolith convention). dayNames index 0..6 maps to
  // FRI, SAT, SUN, MON, TUE, WED, THU. Map to a Sun-start grid col:
  // FRI=5, SAT=6, SUN=0, MON=1, TUE=2, WED=3, THU=4.
  const firstWeekIdx = ((firstDayGlobal - 1) % 7 + 7) % 7;
  const TO_GRID_COL = [5, 6, 0, 1, 2, 3, 4] as const;
  const firstCol = TO_GRID_COL[firstWeekIdx];

  // Header — month + year + (viewing) tag when offset.
  const yearNum = 1999 + Math.floor(viewMonthIdx / 12);
  const titleY = cy + 6;
  ctx.fillStyle = GT2_COLORS.amber;
  ctx.font = 'bold 14px monospace';
  ctx.fillText(monthName.toUpperCase() + ' ' + yearNum, GW / 2, titleY);
  if (viewOffset !== 0) {
    ctx.fillStyle = '#666';
    ctx.font = '9px monospace';
    ctx.fillText('(viewing)', GW / 2, cy + 18);
  } else {
    ctx.fillStyle = '#666';
    ctx.font = '9px monospace';
    ctx.fillText('Today: the ' + ordinalDay(dayOfMonth), GW / 2, cy + 18);
  }

  // H566: ◀ ▶ nav arrows on either side of the title row. Cached
  // rects stashed on life so handlePauseMenuClick can hit-test.
  const navRects = drawNavArrows(ctx, GW, titleY);
  if (life) life._calNavRects = navRects;

  // Day-of-week headers.
  const headers = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
  const gridX = 8;
  const gridW = GW - 16;
  const cellW = Math.floor(gridW / 7);
  const headerY = cy + 30;
  ctx.fillStyle = '#888';
  ctx.font = 'bold 8px monospace';
  for (let c = 0; c < 7; c++) {
    ctx.fillText(headers[c], gridX + c * cellW + cellW / 2, headerY);
  }

  // Grid. cellH sized to fit 6 rows + legend + CLOSE button within
  // GH. Pause menu CLOSE button anchors at GH-40 (height 24); legend
  // at ~GH-72 above it (grew from -60 to fit the legend strip).
  const gridYTop = cy + 36;
  const gridYBot = GH - 92;
  const cellH = Math.max(20, Math.floor((gridYBot - gridYTop) / 6));
  let col = firstCol;
  let row = 0;
  const isCurrentMonth = viewOffset === 0;
  for (let d = 1; d <= DAYS_PER_MONTH; d++) {
    const cx2 = gridX + col * cellW;
    const cy2 = gridYTop + row * cellH;
    const isToday = isCurrentMonth && d === dayOfMonth;
    const isBillDay = d === 1;
    if (isToday) ctx.fillStyle = 'rgba(247, 166, 35, 0.18)';
    else if (isBillDay) ctx.fillStyle = 'rgba(163, 110, 21, 0.14)';
    else ctx.fillStyle = 'rgba(255, 255, 255, 0.04)';
    ctx.fillRect(cx2 + 1, cy2, cellW - 2, cellH - 1);
    if (isToday) {
      ctx.strokeStyle = GT2_COLORS.amber;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(cx2 + 1, cy2, cellW - 2, cellH - 1);
    }
    ctx.fillStyle = isToday ? GT2_COLORS.active : col === 0 ? GT2_COLORS.amberDark : '#ccc';
    ctx.font = 'bold 9px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(String(d), cx2 + cellW / 2, cy2 + 11);
    // H566: per-day event badges from calendarLog. The helper auto-
    // pre-pends a synthetic B (bills) on day 1 if no real one is in
    // the log yet, so the legacy bill-day cue still lands.
    if (life) drawCellBadges(ctx, life, viewMonthOfYear, d, cx2, cy2, cellW, cellH);
    col++;
    if (col > 6) { col = 0; row++; }
  }

  // H566: legend strip just above the CLOSE button.
  drawCalendarLegend(ctx, GW, GH - 72);
}

/** Ordinal-day suffix ('1st', '2nd', '23rd'). Inline so the pause
 *  menu doesn't depend on the home-overlay's private helper. */
function ordinalDay(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return n + 'th';
  const ones = n % 10;
  if (ones === 1) return n + 'st';
  if (ones === 2) return n + 'nd';
  if (ones === 3) return n + 'rd';
  return n + 'th';
}

/** H560: full OPT tab — 1:1 port of monolith L34959-35720 minus the
 *  test-mode DEBUG panel (fault toggles + stat sliders need the
 *  FAULT_POOLS / BODY_DAMAGE_FAULTS catalogs which port separately).
 *  Sections: DISPLAY (X-Ray, Scanlines, FPS, Camera Tilt), PHYSICS
 *  (Bicycle, Dyn 0B), INPUT (Invert Pedals, PC Touch Controls,
 *  Steering Sens, PC Render Scale), AUDIO (3 volumes), PHYSICS
 *  TUNING (5 knobs + Debug HUD).
 *
 *  Cached hit rects on life._opt* so the click router doesn't
 *  duplicate layout math. */
/** OPT-tab scroll bookkeeping. Clip + translate range mirrors the
 *  monolith's L34964-34968 — content paints between y=48 (just below
 *  the tab strip) and GH-28 (just above the CLOSE button). */
const OPT_CLIP_TOP = 48;
const OPT_CLIP_BOT_MARGIN = 28;

/** PC detection — same proxy the camera module uses (viewport
 *  landscape ratio). Matches monolith's `document.body.classList
 *  .contains('pc')` since the modular tree doesn't manage that
 *  body class yet. PC-only rows (PC Touch Controls, PC Render
 *  Scale) read this. */
function isPC(): boolean {
  if (typeof window === 'undefined') return false;
  return window.innerWidth >= window.innerHeight;
}

/** H819: touch detection for the steering-sens slider now delegates to
 *  the shared resolver (pointer:coarse) so the slider's key matches
 *  what the physics reads. Was `'ontouchstart' in window`, which is
 *  true on desktop Chrome + touchscreen laptops and split the key from
 *  the physics read. */
function isTouchDevice(): boolean {
  return isTouchPrimary();
}

/** Render-scale step ladder. H817: continuous 0.05 increments from
 *  0.5 to 2.0 (user request), replacing the old sparse
 *  [0.5,0.75,0.85,1.0,1.25,1.5] ladder. Boot default is 1.0. The ±
 *  buttons step one notch (0.05); the slider drag snaps to the
 *  nearest notch. */
const RS_STEP = 0.05;
const RS_MIN_V = 0.5;
const RS_MAX_V = 2.0;
const RS_STEPS: readonly number[] = (() => {
  const out: number[] = [];
  for (let v = RS_MIN_V; v <= RS_MAX_V + 1e-9; v += RS_STEP) out.push(Math.round(v * 100) / 100);
  return out;
})();

/** Audio volume row definitions. 1:1 with monolith L35430-35434. */
const AUDIO_ROWS: ReadonlyArray<{ key: string; label: string; desc: string }> = [
  { key: 'volCarSfx',  label: 'Car SFX',   desc: 'Engine, exhaust, tires, brakes, crashes' },
  { key: 'volMenuSfx', label: 'Menu SFX',  desc: 'UI clicks, navigation beeps' },
  { key: 'volMusic',   label: 'Music',     desc: 'Background music tracks' },
];

/** Physics tuning row definitions. 1:1 with monolith L35512-35518.
 *  `inverted` flips the +/− direction so the displayed number
 *  matches the user's expectation (Grip at Speed shows 11-internal). */
interface PhysTuneRow {
  key: string;
  label: string;
  desc: string;
  min: number;
  max: number;
  step: number;
  fmt: (v: number) => string;
  inverted?: boolean;
  /** Default applied when the gameplaySettings field is unset. */
  defaultV: number;
}
const PHYS_TUNE_ROWS: readonly PhysTuneRow[] = [
  { key: 'physMuBase',           label: 'Tire Grip',       desc: 'μ baseline (try 1.15)',         min: 0.70,   max: 1.50,   step: 0.05,   fmt: v => v.toFixed(2) + '×',     defaultV: 1.0 },
  { key: 'physMomentumCoef',     label: 'Grip at Speed',   desc: 'High-speed tracking (try 8)',   min: 1.0,    max: 10.0,   step: 0.5,    fmt: v => (11 - v).toFixed(1),     inverted: true, defaultV: 6.0 },
  { key: 'physMassMomentum',     label: 'Weight Feel',     desc: 'Heavy-car feel (try 8)',        min: 0.0001, max: 0.0015, step: 0.0001, fmt: v => Math.round(v * 10000).toString(), defaultV: 0.0003 },
  { key: 'physTopSpeedCap',      label: 'Top Speed Cap',   desc: 'km/h ceiling (try 400)',        min: 250,    max: 450,    step: 10,     fmt: v => Math.round(v) + ' km/h', defaultV: 350 },
  { key: 'physDriftEnterThresh', label: 'Drift Threshold', desc: 'Slip to enter drift (try 0.50)', min: 0.20,   max: 0.70,   step: 0.02,   fmt: v => v.toFixed(2) + ' rad',  defaultV: 0.32 },
  { key: 'physBrakeDrift',       label: 'Brake Drift',     desc: 'Brake-stab slide (0 = off)',    min: 0.0,    max: 2.0,    step: 0.1,    fmt: v => v <= 0 ? 'OFF' : v.toFixed(1) + '×', defaultV: 1.0 },
  { key: 'physArcadeAssist',     label: 'Arcade Assist',   desc: 'Auto-catch slides (0 = sim)',   min: 0.0,    max: 1.0,    step: 0.05,   fmt: v => v <= 0 ? 'SIM' : Math.round(v * 100) + '%', defaultV: 0.3 },
];

/** Cached hit-rect bag stashed on life._opt* during paint and
 *  consumed by handlePauseMenuClick. The renderer writes Y values
 *  in CONTENT space (pre-translate); the click router shifts the
 *  event Y by +scrollY before hit-test. */
interface OptHitRect { x: number; y: number; w: number; h: number; key?: string }
interface OptHitCache {
  _optRestartRect?: OptHitRect;
  _optQuitRect?: OptHitRect;
  _optXrayRowY?: number;
  _optScanRowY?: number;
  _optFPSRowY?: number;
  _optMapStyleRowY?: number;
  _optTopDownRowY?: number;
  _optSimModeRowY?: number;
  _optBicycleRowY?: number;
  _optDyn0BRowY?: number;
  _optInvertPedalsRowY?: number;
  _optManualTransRowY?: number;
  _optPcTouchControlsRowY?: number | null;
  _optSensTrack?: OptHitRect & { min: number; max: number; key: string };
  _optSensMinus?: OptHitRect;
  _optSensPlus?: OptHitRect;
  _optRenderScaleTrack?: OptHitRect | null;
  _optRenderScaleMinus?: OptHitRect | null;
  _optRenderScalePlus?: OptHitRect | null;
  _optAudioHits?: Array<{ trk: OptHitRect; mns: OptHitRect; pls: OptHitRect }>;
  _optPhysHits?: Array<{ key: string; dir: number; x: number; y: number; w: number; h: number; step: number; min: number; max: number }>;
  _optDbgHudRect?: OptHitRect;
  _optTestModeRect?: OptHitRect;
  _optDbgStats?: Array<{ k: 'engine' | 'tires' | 'carHP' | 'paint' | 'fuel'; x: number; y: number; w: number; h: number; tx: number; tw: number }>;
  _optDbgFaultHits?: Array<{ id: string; entry: DbgCatalogEntry; x: number; y: number; w: number; h: number }>;
  _optDbgClearRect?: OptHitRect | null;
  _optDisableTrafficRect?: OptHitRect | null;
  _optDisablePcOverlayRect?: OptHitRect | null;
  _optDisableSignalsRect?: OptHitRect | null;
  _optDisableStreetlightsRect?: OptHitRect | null;
  _dbgFaultCatalog?: DbgCatalogEntry[];
  _menuTabScrollY?: number;
  _menuTabScrollMax?: number;
  /** H744: night-cluster palette selector — three pills (green /
   *  yellow / orange) anchored below the debug catalog. Tapping a
   *  pill calls setGt2NightPalette() and persists to localStorage. */
  _optNightPaletteRects?: Array<OptHitRect & { palette: 'green' | 'amber' | 'orange' }>;
}

/** Shape stored on life._dbgFaultCatalog — one row per known fault
 *  id, merging FAULT_POOLS + FAULT_EFFECTS + BODY_DAMAGE_FAULTS. */
interface DbgCatalogEntry {
  id: string;
  name: string;
  stat: string;
  cost: number;
  days: number;
  type: string;
  add: number;
}

/** Stat lane → short display label. 'hp' maps to 'BODY' per v8.99.x
 *  monolith (_statLbl at L42423) since "hp" is internal-only; the
 *  player-facing label everywhere else is "Body". */
function dbgStatLabel(stat: string): string {
  if (stat === 'hp') return 'BODY';
  if (stat === 'all') return 'ALL';
  return stat.toUpperCase();
}

/** Build the DEBUG fault catalog once per session, cached on
 *  life._dbgFaultCatalog. Walks FAULT_POOLS (origin × stat ×
 *  entries), then fills any remaining FAULT_EFFECTS ids, then
 *  appends BODY_DAMAGE_FAULTS. Sorted by stat+name to keep related
 *  fault rows adjacent. 1:1 with monolith L35641-L35666. */
function buildDbgFaultCatalog(): DbgCatalogEntry[] {
  const cat: Record<string, DbgCatalogEntry> = {};
  for (const origin in FAULT_POOLS) {
    const byStat = FAULT_POOLS[origin as keyof typeof FAULT_POOLS];
    for (const stat in byStat) {
      const entries = (byStat as Record<string, ReadonlyArray<{ id: string; name: string; stat: string; cost: number; days: number; type: string; add: number }>>)[stat];
      for (const f of entries) {
        if (!cat[f.id]) {
          cat[f.id] = { id: f.id, name: f.name, stat: f.stat, cost: f.cost, days: f.days, type: f.type, add: f.add };
        }
      }
    }
  }
  for (const id in FAULT_EFFECTS) {
    if (!cat[id]) {
      const d = FAULT_EFFECTS[id].desc ?? id;
      cat[id] = {
        id,
        name: d.split('—')[0].trim().slice(0, 32),
        stat: 'engine',
        cost: 100,
        days: 1,
        type: 'mechanic',
        add: 20,
      };
    }
  }
  for (const f of BODY_DAMAGE_FAULTS) {
    if (!cat[f.id]) {
      cat[f.id] = { id: f.id, name: f.name, stat: f.stat, cost: f.cost, days: f.days, type: f.type, add: f.add };
    }
  }
  return Object.values(cat).sort((a, b) => (a.stat + a.name).localeCompare(b.stat + b.name));
}

function drawOptTab(
  ctx: CanvasRenderingContext2D,
  life: LifeState,
  GW: number,
  GH: number,
  cy: number,
): void {
  const cache = life as unknown as OptHitCache;
  const gp = life.gameplaySettings as Record<string, number | boolean | undefined>;
  const scrollY = cache._menuTabScrollY ?? 0;
  const clipTop = OPT_CLIP_TOP;
  const clipBot = GH - OPT_CLIP_BOT_MARGIN;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, clipTop, GW, clipBot - clipTop);
  ctx.clip();
  ctx.translate(0, -scrollY);

  ctx.textAlign = 'center';
  ctx.fillStyle = '#0ff';
  ctx.font = 'bold 12px monospace';
  ctx.fillText('SETTINGS', GW / 2, cy);
  ctx.fillStyle = '#888';
  ctx.font = '9px monospace';
  ctx.fillText('Debug & display options', GW / 2, cy + 14);

  // RESTART / QUIT side-by-side. 1:1 with monolith L34979-35001.
  const gpY = cy + 20;
  const gpH = 18;
  const gpGap = 6;
  const gpW = Math.floor((GW - 24 - gpGap) / 2);
  const rsX = 12;
  ctx.fillStyle = 'rgba(200, 120, 0, 0.18)';
  ctx.fillRect(rsX, gpY, gpW, gpH);
  ctx.strokeStyle = '#f80';
  ctx.lineWidth = 1;
  ctx.strokeRect(rsX, gpY, gpW, gpH);
  ctx.fillStyle = '#f80';
  ctx.font = 'bold 9px monospace';
  ctx.fillText('RESTART', rsX + gpW / 2, gpY + 12);
  cache._optRestartRect = { x: rsX, y: gpY, w: gpW, h: gpH };

  const qtX = rsX + gpW + gpGap;
  ctx.fillStyle = 'rgba(200, 40, 40, 0.18)';
  ctx.fillRect(qtX, gpY, gpW, gpH);
  ctx.strokeStyle = '#f44';
  ctx.lineWidth = 1;
  ctx.strokeRect(qtX, gpY, gpW, gpH);
  ctx.fillStyle = '#f44';
  ctx.fillText('QUIT', qtX + gpW / 2, gpY + 12);
  cache._optQuitRect = { x: qtX, y: gpY, w: gpW, h: gpH };

  // DISPLAY section header.
  ctx.fillStyle = '#ff0';
  ctx.font = 'bold 10px monospace';
  ctx.textAlign = 'left';
  ctx.fillText('DISPLAY', 14, cy + 50);
  ctx.textAlign = 'center';

  // X-Ray Body toggle. 1:1 with monolith L35009-35039.
  const xrOn = gp.xrayBody === true;
  const xrY = cy + 58;
  drawSettingToggleRow(ctx, GW, xrY, 36, 'X-Ray Body', 'Hide car body to inspect tire motion', xrOn);
  cache._optXrayRowY = xrY;

  // CRT Scanlines toggle. 1:1 with monolith L35041-35063.
  const scOn = gp.scanlines === true;
  const scY = cy + 98;
  drawSettingToggleRow(ctx, GW, scY, 24, 'CRT Scanlines', 'Retro overlay (heavier GPU load)', scOn);
  cache._optScanRowY = scY;

  // FPS Counter toggle (v8.99.123.41). 1:1 with monolith L35065-35088.
  // H684: default on (matches the renderer's `!== false` check) — an
  // undefined showFPS reads as "ON" in the toggle row so first-launch
  // shows the user's actual state instead of an OFF that doesn't
  // match the visible HUD.
  const fpOn = gp.showFPS !== false;
  const fpY = cy + 126;
  drawSettingToggleRow(ctx, GW, fpY, 24, 'FPS Counter', 'Live frame-rate readout (top-left)', fpOn);
  cache._optFPSRowY = fpY;

  // Map Style toggle — flips the minimap palette between dark
  // (default, current) and paper-map (1990s road-atlas: cream
  // background, red interstates, navy state routes, brown minor
  // streets). paintMinimap re-bakes on flip; runtime cost negligible.
  const msOn = gp.mapLight === true;
  const msY = cy + 154;
  drawSettingToggleRow(ctx, GW, msY, 24, 'Map: Light', 'Paper-map style (off = dark)', msOn);
  cache._optMapStyleRowY = msY;

  // Camera Tilt row (v8.98.31). 1:1 with monolith L35090-35121. The
  // monolith reads TILT_MODE (a global numeric); we store as
  // gameplaySettings.cameraTiltMode.
  //
  // H686: source from tiltState.mode (the live state of record), not
  // gp.cameraTiltMode — pre-H686 read defaulted undefined → 0 (top-
  // down) while tiltState.mode initialized to 1, so the row showed
  // "top-down ON" on a freshly-tilted view. Also detect mobile vs PC
  // viewport so the subtitle / toggle indicator reflect the actual
  // device-tilt angle that "OFF" will land on.
  // H809: three-mode cycle row (Top-down → 20° → 35°). Was a binary
  // "Top-down View" ON/OFF; 35° returned as an explicit option.
  const tdOn = tiltState.mode === 0;
  const isPortrait = (typeof window !== 'undefined') && (window.innerWidth < window.innerHeight);
  const tiltArr = isPortrait ? TILT_PITCH_DEG_MOBILE : TILT_PITCH_DEG_PC;
  const curTilt = tiltArr[tiltState.mode] ?? 0;
  const tdY = cy + 182;
  const tdH = 36;
  ctx.fillStyle = tdOn ? 'rgba(180,80,255,0.15)' : 'rgba(255,200,0,0.12)';
  ctx.fillRect(12, tdY, GW - 24, tdH);
  ctx.strokeStyle = tdOn ? '#c8f' : '#fa0';
  ctx.lineWidth = 1;
  ctx.strokeRect(12, tdY, GW - 24, tdH);
  ctx.fillStyle = tdOn ? '#d8f' : '#fc4';
  ctx.font = 'bold 11px monospace';
  ctx.textAlign = 'left';
  ctx.fillText('Camera Tilt', 20, tdY + 14);
  ctx.fillStyle = '#888';
  ctx.font = '8px monospace';
  ctx.fillText(
    tdOn
      ? 'Top-down — flat overhead (no perspective)'
      : `${curTilt}° perspective tilt — tap to cycle`,
    20, tdY + 26,
  );
  const tdTogW = 36, tdTogH = 16;
  const tdTogX = GW - 20 - tdTogW;
  const tdTogY = tdY + 10;
  ctx.fillStyle = tdOn ? '#630' : '#333';
  ctx.fillRect(tdTogX, tdTogY, tdTogW, tdTogH);
  ctx.strokeStyle = tdOn ? '#fa0' : '#666';
  ctx.strokeRect(tdTogX, tdTogY, tdTogW, tdTogH);
  ctx.fillStyle = tdOn ? '#fc4' : '#ddd';
  ctx.font = 'bold 9px monospace';
  ctx.textAlign = 'center';
  ctx.fillText(tdOn ? 'TOP' : `${curTilt}°`, tdTogX + tdTogW / 2, tdTogY + 11);
  cache._optTopDownRowY = tdY;
  ctx.textAlign = 'center';

  // GAMEPLAY section header (H960).
  ctx.fillStyle = '#ff0';
  ctx.font = 'bold 10px monospace';
  ctx.textAlign = 'left';
  ctx.fillText('GAMEPLAY', 14, cy + 232);
  ctx.textAlign = 'center';

  // Simulation Mode toggle (H960 — "cozy" mode). Flag only for now:
  // the SIMULATE buttons it unlocks land in H961 (fast travel),
  // H962 (work shifts), H963 (races). Rows below shifted +58.
  const smOn = gp.simulationMode === true;
  const smY = cy + 240;
  drawSettingToggleRow(ctx, GW, smY, 36, 'Simulation Mode', 'Cozy: simulate races/work/travel, no driving', smOn);
  cache._optSimModeRowY = smY;

  // PHYSICS section header.
  ctx.fillStyle = '#ff0';
  ctx.font = 'bold 10px monospace';
  ctx.textAlign = 'left';
  ctx.fillText('PHYSICS', 14, cy + 290);
  ctx.textAlign = 'center';

  // Bicycle Model toggle. 1:1 with monolith L35129-35154.
  const bmOn = gp.bicycleModel === true;
  const bmY = cy + 298;
  drawSettingToggleRow(ctx, GW, bmY, 36, 'Bicycle Model', 'Rear axle rolls along heading (v8.40)', bmOn);
  cache._optBicycleRowY = bmY;

  // Dynamic Physics (0B) sub-toggle. 1:1 with monolith L35156-35180.
  // Gated visually + functionally by bicycleModel: greyed out when
  // BM is off, and the click handler ignores taps then.
  const dpOn = gp.dynPhysics0B === true && bmOn;
  const dpY = cy + 338;
  const dpH = 24;
  ctx.fillStyle = dpOn ? 'rgba(255,160,0,0.15)' : 'rgba(255,255,255,0.05)';
  ctx.fillRect(12, dpY, GW - 24, dpH);
  ctx.strokeStyle = dpOn ? '#f80' : (bmOn ? '#444' : '#333');
  ctx.lineWidth = 1;
  ctx.strokeRect(12, dpY, GW - 24, dpH);
  ctx.fillStyle = bmOn ? (dpOn ? '#fa3' : '#ddd') : '#666';
  ctx.font = 'bold 10px monospace';
  ctx.textAlign = 'left';
  ctx.fillText(bmOn ? 'Dynamic Physics (0B)' : 'Dynamic Physics (requires Bicycle)', 20, dpY + 15);
  const dpTogX = GW - 20 - 36;
  const dpTogY = dpY + 5;
  ctx.fillStyle = dpOn ? '#a60' : '#333';
  ctx.fillRect(dpTogX, dpTogY, 36, 14);
  ctx.strokeStyle = dpOn ? '#f80' : '#666';
  ctx.strokeRect(dpTogX, dpTogY, 36, 14);
  ctx.fillStyle = dpOn ? '#fa3' : '#999';
  ctx.fillRect(dpOn ? dpTogX + 23 : dpTogX + 2, dpTogY + 2, 11, 10);
  cache._optDyn0BRowY = dpY;
  ctx.textAlign = 'center';

  // INPUT section header.
  ctx.fillStyle = '#ff0';
  ctx.font = 'bold 10px monospace';
  ctx.textAlign = 'left';
  ctx.fillText('INPUT', 14, cy + 378);
  ctx.textAlign = 'center';

  // Invert Pedals toggle. 1:1 with monolith L35193-35216.
  const ipOn = gp.invertPedals === true;
  const ipY = cy + 386;
  const ipH = 24;
  ctx.fillStyle = ipOn ? 'rgba(0,255,255,0.15)' : 'rgba(255,255,255,0.05)';
  ctx.fillRect(12, ipY, GW - 24, ipH);
  ctx.strokeStyle = ipOn ? '#0ff' : '#444';
  ctx.lineWidth = 1;
  ctx.strokeRect(12, ipY, GW - 24, ipH);
  ctx.fillStyle = ipOn ? '#0ff' : '#ddd';
  ctx.font = 'bold 10px monospace';
  ctx.textAlign = 'left';
  ctx.fillText('Invert Pedals', 20, ipY + 15);
  ctx.fillStyle = '#888';
  ctx.font = '8px monospace';
  ctx.fillText(ipOn ? 'top = full press' : 'bottom = full press', 104, ipY + 15);
  const ipTogX = GW - 20 - 36;
  const ipTogY = ipY + 5;
  ctx.fillStyle = ipOn ? '#044' : '#333';
  ctx.fillRect(ipTogX, ipTogY, 36, 14);
  ctx.strokeStyle = ipOn ? '#0ff' : '#666';
  ctx.strokeRect(ipTogX, ipTogY, 36, 14);
  ctx.fillStyle = ipOn ? '#0ff' : '#999';
  ctx.fillRect(ipOn ? ipTogX + 23 : ipTogX + 2, ipTogY + 2, 11, 10);
  cache._optInvertPedalsRowY = ipY;
  ctx.textAlign = 'center';

  // H1021: Manual Transmission toggle.
  const mtOn = gp.manualTransmission === true;
  const mtY = cy + 418;
  const mtH = 24;
  ctx.fillStyle = mtOn ? 'rgba(0,255,255,0.15)' : 'rgba(255,255,255,0.05)';
  ctx.fillRect(12, mtY, GW - 24, mtH);
  ctx.strokeStyle = mtOn ? '#0ff' : '#444';
  ctx.lineWidth = 1;
  ctx.strokeRect(12, mtY, GW - 24, mtH);
  ctx.fillStyle = mtOn ? '#0ff' : '#ddd';
  ctx.font = 'bold 10px monospace';
  ctx.textAlign = 'left';
  ctx.fillText('Manual Transmission', 20, mtY + 15);
  ctx.fillStyle = '#888';
  ctx.font = '8px monospace';
  ctx.fillText(mtOn ? 'shift: E/Q · knob · stick flick' : 'automatic', 150, mtY + 15);
  const mtTogX = GW - 20 - 36;
  const mtTogY = mtY + 5;
  ctx.fillStyle = mtOn ? '#044' : '#333';
  ctx.fillRect(mtTogX, mtTogY, 36, 14);
  ctx.strokeStyle = mtOn ? '#0ff' : '#666';
  ctx.strokeRect(mtTogX, mtTogY, 36, 14);
  ctx.fillStyle = mtOn ? '#0ff' : '#999';
  ctx.fillRect(mtOn ? mtTogX + 23 : mtTogX + 2, mtTogY + 2, 11, 10);
  cache._optManualTransRowY = mtY;
  ctx.textAlign = 'center';

  // PC Touch Controls toggle (PC-only). 1:1 with monolith L35229-35259.
  let ssYOffset = 0;
  if (isPC()) {
    // ON by default — undefined / true → on; only explicit false reads as off.
    const ptcOn = gp.pcShowMobileControls !== false;
    const ptcY = cy + 450;
    const ptcH = 24;
    ctx.fillStyle = ptcOn ? 'rgba(0,255,255,0.15)' : 'rgba(255,255,255,0.05)';
    ctx.fillRect(12, ptcY, GW - 24, ptcH);
    ctx.strokeStyle = ptcOn ? '#0ff' : '#444';
    ctx.lineWidth = 1;
    ctx.strokeRect(12, ptcY, GW - 24, ptcH);
    ctx.fillStyle = ptcOn ? '#0ff' : '#ddd';
    ctx.font = 'bold 10px monospace';
    ctx.textAlign = 'left';
    ctx.fillText('PC Touch Controls', 20, ptcY + 15);
    ctx.fillStyle = '#888';
    ctx.font = '8px monospace';
    ctx.fillText(ptcOn ? 'wheel/pedals/e-brake/shift visible' : 'desktop default (no touch UI)', 128, ptcY + 15);
    const ptcTogX = GW - 20 - 36;
    const ptcTogY = ptcY + 5;
    ctx.fillStyle = ptcOn ? '#044' : '#333';
    ctx.fillRect(ptcTogX, ptcTogY, 36, 14);
    ctx.strokeStyle = ptcOn ? '#0ff' : '#666';
    ctx.strokeRect(ptcTogX, ptcTogY, 36, 14);
    ctx.fillStyle = ptcOn ? '#0ff' : '#999';
    ctx.fillRect(ptcOn ? ptcTogX + 23 : ptcTogX + 2, ptcTogY + 2, 11, 10);
    cache._optPcTouchControlsRowY = ptcY;
    ctx.textAlign = 'center';
    ssYOffset = 32;
  } else {
    cache._optPcTouchControlsRowY = null;
  }

  // Steering Sensitivity slider. 1:1 with monolith L35261-35320.
  const isT = isTouchDevice();
  const sensKey = isT ? 'touchSteerSens' : 'padSteerSens';
  const sensLabel = isT ? 'Touch Steering Sens.' : 'Keyboard/Pad Sens.';
  const sensValRaw = gp[sensKey];
  const sensVal = typeof sensValRaw === 'number' ? sensValRaw : 1.0;
  const SENS_MIN = 0.5;
  const SENS_MAX = 2.0;
  const ssY = cy + 450 + ssYOffset;
  const ssH = 46;
  ctx.fillStyle = 'rgba(255,255,255,0.06)';
  ctx.fillRect(12, ssY, GW - 24, ssH);
  ctx.strokeStyle = '#444';
  ctx.lineWidth = 1;
  ctx.strokeRect(12, ssY, GW - 24, ssH);
  ctx.fillStyle = '#ddd';
  ctx.font = 'bold 11px monospace';
  ctx.textAlign = 'left';
  ctx.fillText(sensLabel, 20, ssY + 12);
  ctx.fillStyle = '#0ff';
  ctx.font = 'bold 11px monospace';
  ctx.textAlign = 'right';
  ctx.fillText(sensVal.toFixed(1) + 'x', GW - 20, ssY + 12);
  const trkX = 34, trkY = ssY + 24, trkW = GW - 24 - 44 - 34, trkH = 6;
  ctx.fillStyle = '#222';
  ctx.fillRect(trkX, trkY, trkW, trkH);
  ctx.strokeStyle = '#555';
  ctx.strokeRect(trkX, trkY, trkW, trkH);
  const sensFrac = (sensVal - SENS_MIN) / (SENS_MAX - SENS_MIN);
  ctx.fillStyle = '#0a6';
  ctx.fillRect(trkX, trkY, trkW * sensFrac, trkH);
  const thumbX = trkX + trkW * sensFrac;
  ctx.fillStyle = '#0ff';
  ctx.fillRect(thumbX - 3, trkY - 4, 6, trkH + 8);
  const defFrac = (1.0 - SENS_MIN) / (SENS_MAX - SENS_MIN);
  ctx.strokeStyle = '#888';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(trkX + trkW * defFrac, trkY - 2);
  ctx.lineTo(trkX + trkW * defFrac, trkY + trkH + 2);
  ctx.stroke();
  ctx.fillStyle = '#888';
  ctx.font = '8px monospace';
  ctx.textAlign = 'left';
  ctx.fillText('0.5', trkX - 2, trkY + trkH + 12);
  ctx.textAlign = 'right';
  ctx.fillText('2.0', trkX + trkW + 2, trkY + trkH + 12);
  const btnW = 20, btnH = 20;
  const minusX = 14, plusX = GW - 14 - btnW;
  const btnY = ssY + 16;
  ctx.fillStyle = 'rgba(0,180,180,0.2)';
  ctx.fillRect(minusX, btnY, btnW, btnH);
  ctx.fillRect(plusX, btnY, btnW, btnH);
  ctx.strokeStyle = '#088';
  ctx.strokeRect(minusX, btnY, btnW, btnH);
  ctx.strokeRect(plusX, btnY, btnW, btnH);
  ctx.fillStyle = '#0ff';
  ctx.font = 'bold 13px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('−', minusX + btnW / 2, btnY + 14);
  ctx.fillText('+', plusX + btnW / 2, btnY + 14);
  cache._optSensTrack = { x: trkX, y: trkY - 6, w: trkW, h: trkH + 12, min: SENS_MIN, max: SENS_MAX, key: sensKey };
  cache._optSensMinus = { x: minusX, y: btnY, w: btnW, h: btnH, key: sensKey };
  cache._optSensPlus = { x: plusX, y: btnY, w: btnW, h: btnH, key: sensKey };
  ctx.textAlign = 'center';

  // Render Scale slider. 1:1 with monolith L35322-35412, but H728
  // drops the PC-only gate — mobile fitCanvases also multiplies by
  // pcRenderScale (main.ts mobile branch:
  // `mainCanvas.width = mobWORLD_GW * _rs`), so mobile players need
  // the same slider to tune perf vs crispness. Pre-H728 mobile got
  // the 0.85 default with no way to change it.
  let rsBlockH = 0;
  {
    const RS_MIN = RS_STEPS[0];
    const RS_MAX = RS_STEPS[RS_STEPS.length - 1];
    const rsValRaw = gp.pcRenderScale;
    // H1008: fall back to the platform default (1.10 PC / 1.0 mobile) so
    // the readout matches the effective scale when the user hasn't set one.
    const rsVal = typeof rsValRaw === 'number' ? rsValRaw : getDefaultRenderScale();
    const rsY = ssY + ssH + 10;
    const rsH = 46;
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.fillRect(12, rsY, GW - 24, rsH);
    ctx.strokeStyle = '#444';
    ctx.lineWidth = 1;
    ctx.strokeRect(12, rsY, GW - 24, rsH);
    ctx.fillStyle = '#ddd';
    ctx.font = 'bold 11px monospace';
    ctx.textAlign = 'left';
    ctx.fillText('Render Scale', 20, rsY + 12);
    ctx.fillStyle = '#0ff';
    ctx.font = 'bold 11px monospace';
    ctx.textAlign = 'right';
    ctx.fillText(rsVal.toFixed(2) + 'x', GW - 20, rsY + 12);
    const rsTrkX = 34, rsTrkY = rsY + 24, rsTrkW = GW - 24 - 44 - 34, rsTrkH = 6;
    ctx.fillStyle = '#222';
    ctx.fillRect(rsTrkX, rsTrkY, rsTrkW, rsTrkH);
    ctx.strokeStyle = '#555';
    ctx.strokeRect(rsTrkX, rsTrkY, rsTrkW, rsTrkH);
    const rsFrac = (rsVal - RS_MIN) / (RS_MAX - RS_MIN);
    ctx.fillStyle = '#0a6';
    ctx.fillRect(rsTrkX, rsTrkY, rsTrkW * rsFrac, rsTrkH);
    // H817: 31 notches (0.05 step) is too dense to tick individually —
    // draw major marks at 0.5/1.0/1.5/2.0 only.
    ctx.strokeStyle = '#666';
    ctx.lineWidth = 1;
    for (const major of [0.5, 1.0, 1.5, 2.0]) {
      const f = (major - RS_MIN) / (RS_MAX - RS_MIN);
      ctx.beginPath();
      ctx.moveTo(rsTrkX + rsTrkW * f, rsTrkY - 2);
      ctx.lineTo(rsTrkX + rsTrkW * f, rsTrkY + rsTrkH + 2);
      ctx.stroke();
    }
    const rsThumbX = rsTrkX + rsTrkW * rsFrac;
    ctx.fillStyle = '#0ff';
    ctx.fillRect(rsThumbX - 3, rsTrkY - 4, 6, rsTrkH + 8);
    const rsDefFrac = (getDefaultRenderScale() - RS_MIN) / (RS_MAX - RS_MIN);
    ctx.strokeStyle = '#aaa';
    ctx.beginPath();
    ctx.moveTo(rsTrkX + rsTrkW * rsDefFrac, rsTrkY - 3);
    ctx.lineTo(rsTrkX + rsTrkW * rsDefFrac, rsTrkY + rsTrkH + 3);
    ctx.stroke();
    ctx.fillStyle = '#888';
    ctx.font = '8px monospace';
    ctx.textAlign = 'left';
    ctx.fillText('0.5', rsTrkX - 2, rsTrkY + rsTrkH + 12);
    ctx.textAlign = 'right';
    ctx.fillText('2.0', rsTrkX + rsTrkW + 2, rsTrkY + rsTrkH + 12);
    ctx.fillStyle = '#666';
    ctx.textAlign = 'center';
    ctx.fillText('lower = more FPS, less crisp', rsTrkX + rsTrkW / 2, rsTrkY + rsTrkH + 12);
    const rsMinusX = 14, rsPlusX = GW - 14 - btnW;
    const rsBtnY = rsY + 16;
    ctx.fillStyle = 'rgba(0,180,180,0.2)';
    ctx.fillRect(rsMinusX, rsBtnY, btnW, btnH);
    ctx.fillRect(rsPlusX, rsBtnY, btnW, btnH);
    ctx.strokeStyle = '#088';
    ctx.strokeRect(rsMinusX, rsBtnY, btnW, btnH);
    ctx.strokeRect(rsPlusX, rsBtnY, btnW, btnH);
    ctx.fillStyle = '#0ff';
    ctx.font = 'bold 13px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('−', rsMinusX + btnW / 2, rsBtnY + 14);
    ctx.fillText('+', rsPlusX + btnW / 2, rsBtnY + 14);
    cache._optRenderScaleTrack = { x: rsTrkX, y: rsTrkY - 6, w: rsTrkW, h: rsTrkH + 12 };
    cache._optRenderScaleMinus = { x: rsMinusX, y: rsBtnY, w: btnW, h: btnH };
    cache._optRenderScalePlus = { x: rsPlusX, y: rsBtnY, w: btnW, h: btnH };
    ctx.textAlign = 'center';
    rsBlockH = rsH + 10;
  }

  // AUDIO section — 3 per-category volume sliders. 1:1 with monolith
  // L35413-35497. Audio gain nodes aren't connected to this surface
  // yet; the toggles persist the value so the moment per-category
  // gain wiring lands, the user's preference is honored.
  const auY0 = ssY + ssH + 10 + rsBlockH;
  ctx.fillStyle = '#ff0';
  ctx.font = 'bold 10px monospace';
  ctx.textAlign = 'left';
  ctx.fillText('AUDIO', 14, auY0);
  ctx.fillStyle = '#888';
  ctx.font = '8px monospace';
  ctx.fillText('Per-category volume — 0% mutes that category', 14, auY0 + 10);
  ctx.textAlign = 'center';
  const auRowH = 46;
  const auRowGap = 4;
  cache._optAudioHits = [];
  for (let ai = 0; ai < AUDIO_ROWS.length; ai++) {
    const ar = AUDIO_ROWS[ai];
    const valRaw = gp[ar.key];
    const val = typeof valRaw === 'number' ? valRaw : 1.0;
    const arY = auY0 + 14 + ai * (auRowH + auRowGap);
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.fillRect(12, arY, GW - 24, auRowH);
    ctx.strokeStyle = '#444';
    ctx.lineWidth = 1;
    ctx.strokeRect(12, arY, GW - 24, auRowH);
    ctx.fillStyle = '#ddd';
    ctx.font = 'bold 11px monospace';
    ctx.textAlign = 'left';
    ctx.fillText(ar.label, 20, arY + 12);
    ctx.fillStyle = '#888';
    ctx.font = '8px monospace';
    ctx.fillText(ar.desc, 20, arY + 22);
    ctx.fillStyle = '#0ff';
    ctx.font = 'bold 11px monospace';
    ctx.textAlign = 'right';
    ctx.fillText(Math.round(val * 100) + '%', GW - 20, arY + 12);
    const tx_ = 34, ty_ = arY + 34, tw_ = GW - 24 - 44 - 34, th_ = 6;
    ctx.fillStyle = '#222';
    ctx.fillRect(tx_, ty_, tw_, th_);
    ctx.strokeStyle = '#555';
    ctx.strokeRect(tx_, ty_, tw_, th_);
    ctx.fillStyle = '#0a6';
    ctx.fillRect(tx_, ty_, tw_ * val, th_);
    const auThumbX = tx_ + tw_ * val;
    ctx.fillStyle = '#0ff';
    ctx.fillRect(auThumbX - 3, ty_ - 4, 6, th_ + 8);
    ctx.strokeStyle = '#888';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(tx_ + tw_, ty_ - 2);
    ctx.lineTo(tx_ + tw_, ty_ + th_ + 2);
    ctx.stroke();
    ctx.fillStyle = '#888';
    ctx.font = '8px monospace';
    ctx.textAlign = 'left';
    ctx.fillText('0%', tx_ - 2, ty_ + th_ + 12);
    ctx.textAlign = 'right';
    ctx.fillText('100%', tx_ + tw_ + 2, ty_ + th_ + 12);
    const amX = 14, apX = GW - 14 - btnW;
    const abY = arY + 22;
    ctx.fillStyle = 'rgba(0,180,180,0.2)';
    ctx.fillRect(amX, abY, btnW, btnH);
    ctx.fillRect(apX, abY, btnW, btnH);
    ctx.strokeStyle = '#088';
    ctx.strokeRect(amX, abY, btnW, btnH);
    ctx.strokeRect(apX, abY, btnW, btnH);
    ctx.fillStyle = '#0ff';
    ctx.font = 'bold 13px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('−', amX + btnW / 2, abY + 14);
    ctx.fillText('+', apX + btnW / 2, abY + 14);
    cache._optAudioHits.push({
      trk: { x: tx_, y: ty_ - 6, w: tw_, h: th_ + 12, key: ar.key },
      mns: { x: amX, y: abY, w: btnW, h: btnH, key: ar.key },
      pls: { x: apX, y: abY, w: btnW, h: btnH, key: ar.key },
    });
    ctx.textAlign = 'center';
  }
  const auBlockBot = auY0 + 14 + AUDIO_ROWS.length * (auRowH + auRowGap);

  // PHYSICS TUNING section — 5 knob rows. 1:1 with monolith L35499-35562.
  const phY0 = auBlockBot + 10;
  ctx.fillStyle = '#ff0';
  ctx.font = 'bold 10px monospace';
  ctx.textAlign = 'left';
  ctx.fillText('PHYSICS TUNING', 14, phY0);
  ctx.fillStyle = '#888';
  ctx.font = '8px monospace';
  ctx.fillText('Higher = grippier / heavier / faster top end', 14, phY0 + 10);
  ctx.textAlign = 'center';
  const phRowH = 32;
  const phStart = phY0 + 14;
  cache._optPhysHits = [];
  for (let pi = 0; pi < PHYS_TUNE_ROWS.length; pi++) {
    const r = PHYS_TUNE_ROWS[pi];
    const rY = phStart + pi * (phRowH + 3);
    const rawV = gp[r.key];
    const v = typeof rawV === 'number' ? rawV : r.defaultV;
    ctx.fillStyle = 'rgba(100,180,255,0.08)';
    ctx.fillRect(12, rY, GW - 24, phRowH);
    ctx.strokeStyle = '#147';
    ctx.lineWidth = 1;
    ctx.strokeRect(12, rY, GW - 24, phRowH);
    ctx.fillStyle = '#8cf';
    ctx.font = 'bold 10px monospace';
    ctx.textAlign = 'left';
    ctx.fillText(r.label, 18, rY + 11);
    ctx.fillStyle = '#678';
    ctx.font = '8px monospace';
    ctx.fillText(r.desc, 18, rY + 22);
    ctx.fillStyle = '#0ff';
    ctx.font = 'bold 10px monospace';
    ctx.textAlign = 'right';
    ctx.fillText(r.fmt(v), GW - 46, rY + 12);
    const phBtnW = 18, phBtnH = 14;
    const phMinusX = GW - 20 - phBtnW * 2 - 3;
    const phPlusX = GW - 20 - phBtnW;
    const phBtnY = rY + 16;
    ctx.fillStyle = 'rgba(0,140,200,0.25)';
    ctx.fillRect(phMinusX, phBtnY, phBtnW, phBtnH);
    ctx.fillRect(phPlusX, phBtnY, phBtnW, phBtnH);
    ctx.strokeStyle = '#08a';
    ctx.lineWidth = 1;
    ctx.strokeRect(phMinusX, phBtnY, phBtnW, phBtnH);
    ctx.strokeRect(phPlusX, phBtnY, phBtnW, phBtnH);
    ctx.fillStyle = '#0ff';
    ctx.font = 'bold 11px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('−', phMinusX + phBtnW / 2, phBtnY + 11);
    ctx.fillText('+', phPlusX + phBtnW / 2, phBtnY + 11);
    const phInv = r.inverted ? -1 : 1;
    cache._optPhysHits.push({ key: r.key, dir: -1 * phInv, x: phMinusX, y: phBtnY, w: phBtnW, h: phBtnH, step: r.step, min: r.min, max: r.max });
    cache._optPhysHits.push({ key: r.key, dir: 1 * phInv, x: phPlusX, y: phBtnY, w: phBtnW, h: phBtnH, step: r.step, min: r.min, max: r.max });
  }
  const phBot = phStart + PHYS_TUNE_ROWS.length * (phRowH + 3);

  // Debug HUD toggle (v8.99.88). 1:1 with monolith L35563-35583.
  const dhY = phBot + 4;
  const dhH = 22;
  const dhOn = gp.physDebugHUD === true;
  ctx.fillStyle = dhOn ? 'rgba(0,255,255,0.18)' : 'rgba(100,180,255,0.06)';
  ctx.fillRect(12, dhY, GW - 24, dhH);
  ctx.strokeStyle = dhOn ? '#0ff' : '#147';
  ctx.lineWidth = 1;
  ctx.strokeRect(12, dhY, GW - 24, dhH);
  ctx.fillStyle = dhOn ? '#0ff' : '#8cf';
  ctx.font = 'bold 10px monospace';
  ctx.textAlign = 'left';
  ctx.fillText('Debug HUD (live physics)', 18, dhY + 14);
  const dhTogW = 32, dhTogH = 12;
  const dhTogX = GW - 20 - dhTogW;
  const dhTogY = dhY + 5;
  ctx.fillStyle = dhOn ? '#066' : '#333';
  ctx.fillRect(dhTogX, dhTogY, dhTogW, dhTogH);
  ctx.strokeStyle = dhOn ? '#0ff' : '#666';
  ctx.strokeRect(dhTogX, dhTogY, dhTogW, dhTogH);
  ctx.fillStyle = dhOn ? '#0ff' : '#999';
  ctx.fillRect(dhOn ? dhTogX + dhTogW - 11 : dhTogX + 2, dhTogY + 2, 9, dhTogH - 4);
  cache._optDbgHudRect = { x: 12, y: dhY, w: GW - 24, h: dhH };
  ctx.textAlign = 'center';

  // H591: test-mode (DEBUG fault toggles + stat sliders) runtime
  // enable toggle. The monolith only entered test mode by typing
  // "test" as the player name during character creation; modular
  // exposes a live toggle here so the player can flip the DEBUG
  // panel on without restarting the run. Reads/writes
  // life._testMode directly so the existing panel-gating check
  // (L1777) immediately observes the change.
  const tmY = dhY + dhH + 4;
  const tmH = 22;
  const tmOn = (life as { _testMode?: boolean })._testMode === true;
  ctx.fillStyle = tmOn ? 'rgba(255,0,255,0.18)' : 'rgba(200,80,255,0.06)';
  ctx.fillRect(12, tmY, GW - 24, tmH);
  ctx.strokeStyle = tmOn ? '#f0f' : '#527';
  ctx.lineWidth = 1;
  ctx.strokeRect(12, tmY, GW - 24, tmH);
  ctx.fillStyle = tmOn ? '#f0f' : '#caf';
  ctx.font = 'bold 10px monospace';
  ctx.textAlign = 'left';
  ctx.fillText('Fault DEBUG (test mode)', 18, tmY + 14);
  const tmTogW = 32, tmTogH = 12;
  const tmTogX = GW - 20 - tmTogW;
  const tmTogY = tmY + 5;
  ctx.fillStyle = tmOn ? '#606' : '#333';
  ctx.fillRect(tmTogX, tmTogY, tmTogW, tmTogH);
  ctx.strokeStyle = tmOn ? '#f0f' : '#666';
  ctx.strokeRect(tmTogX, tmTogY, tmTogW, tmTogH);
  ctx.fillStyle = tmOn ? '#f0f' : '#999';
  ctx.fillRect(tmOn ? tmTogX + tmTogW - 11 : tmTogX + 2, tmTogY + 2, 9, tmTogH - 4);
  cache._optTestModeRect = { x: 12, y: tmY, w: GW - 24, h: tmH };
  ctx.textAlign = 'center';

  // H562: test-mode DEBUG panel. Only renders when life._testMode
  // is true (set by character creation's test-mode commit path).
  // Five stat sliders (engine/tires/carHP/paint/fuel) over a
  // scrollable fault toggle grid, with CLEAR ALL FAULTS at the
  // bottom. 1:1 with monolith L35587-L35702.
  let dbgBot = tmY + tmH + 4;
  cache._optDbgStats = [];
  cache._optDbgFaultHits = [];
  const testMode = (life as { _testMode?: boolean })._testMode === true;
  if (testMode) {
    const dbgY = tmY + tmH + 4;
    // Section header.
    ctx.fillStyle = '#f0f';
    ctx.font = 'bold 10px monospace';
    ctx.textAlign = 'left';
    ctx.fillText('DEBUG (test mode)', 14, dbgY);
    ctx.textAlign = 'center';

    // Stat sliders. Stat keys match the LIFE field names directly
    // (engine/tires/carHP/paint/fuel) so the click handler can
    // write through without a key-map indirection.
    const statKeys: Array<'engine' | 'tires' | 'carHP' | 'paint' | 'fuel'> = ['engine', 'tires', 'carHP', 'paint', 'fuel'];
    const statLabels: Record<typeof statKeys[number], string> = {
      engine: 'Engine', tires: 'Tires', carHP: 'Body', paint: 'Paint', fuel: 'Fuel',
    };
    const rowH = 20;
    const statsTop = dbgY + 8;
    for (let si = 0; si < statKeys.length; si++) {
      const k = statKeys[si];
      const rY = statsTop + si * rowH;
      ctx.fillStyle = 'rgba(255,0,255,0.06)';
      ctx.fillRect(12, rY, GW - 24, rowH - 2);
      ctx.strokeStyle = '#606';
      ctx.lineWidth = 1;
      ctx.strokeRect(12, rY, GW - 24, rowH - 2);
      ctx.fillStyle = '#ddd';
      ctx.font = 'bold 9px monospace';
      ctx.textAlign = 'left';
      ctx.fillText(statLabels[k], 18, rY + 12);
      const v = Math.round((life[k] as number | undefined) ?? 0);
      ctx.fillStyle = '#0ff';
      ctx.textAlign = 'right';
      ctx.fillText(v + '%', GW - 52, rY + 12);
      const tKX = 70, tKY = rY + 8, tKW = GW - 24 - 70 - 50, tKH = 4;
      ctx.fillStyle = '#222';
      ctx.fillRect(tKX, tKY, tKW, tKH);
      ctx.strokeStyle = '#555';
      ctx.strokeRect(tKX, tKY, tKW, tKH);
      ctx.fillStyle = '#a0a';
      ctx.fillRect(tKX, tKY, tKW * (v / 100), tKH);
      ctx.fillStyle = '#f0f';
      ctx.fillRect(tKX + tKW * (v / 100) - 2, tKY - 2, 4, tKH + 4);
      cache._optDbgStats.push({ k, x: tKX, y: rY, w: tKW, h: rowH - 2, tx: tKX, tw: tKW });
      ctx.textAlign = 'center';
    }
    const statsBot = statsTop + statKeys.length * rowH + 4;

    // Faults header.
    ctx.fillStyle = '#f0f';
    ctx.font = 'bold 10px monospace';
    ctx.textAlign = 'left';
    ctx.fillText('FAULTS (tap to toggle)', 14, statsBot + 12);
    ctx.textAlign = 'center';

    // Build catalog once and cache on life (monolith stashes on
    // LIFE._dbgFaultCatalog L35641 — same memo lifetime).
    if (!cache._dbgFaultCatalog) cache._dbgFaultCatalog = buildDbgFaultCatalog();
    const faults = cache._dbgFaultCatalog;
    const activeIds = new Set<string>(
      ((life.faults ?? []) as Array<{ id?: string }>).map((f) => f.id ?? '').filter(Boolean),
    );

    const fTop = statsBot + 20;
    const fRowH = 14;
    for (let fi = 0; fi < faults.length; fi++) {
      const f = faults[fi];
      const fY = fTop + fi * fRowH;
      const on = activeIds.has(f.id);
      ctx.fillStyle = on ? 'rgba(200,0,100,0.25)' : 'rgba(60,0,80,0.15)';
      ctx.fillRect(12, fY, GW - 24, fRowH - 2);
      ctx.strokeStyle = on ? '#f0a' : '#505';
      ctx.lineWidth = 1;
      ctx.strokeRect(12, fY, GW - 24, fRowH - 2);
      ctx.fillStyle = on ? '#f6c' : '#aaa';
      ctx.font = 'bold 8px monospace';
      ctx.textAlign = 'left';
      const nm = f.name.length > 34 ? f.name.slice(0, 33) + '…' : f.name;
      ctx.fillText((on ? '● ' : '○ ') + nm, 16, fY + 9);
      ctx.fillStyle = on ? '#fff' : '#777';
      ctx.font = '7px monospace';
      ctx.textAlign = 'right';
      ctx.fillText(dbgStatLabel(f.stat), GW - 18, fY + 9);
      cache._optDbgFaultHits.push({ id: f.id, entry: f, x: 12, y: fY, w: GW - 24, h: fRowH - 2 });
      ctx.textAlign = 'center';
    }

    // CLEAR ALL FAULTS button.
    const caY = fTop + faults.length * fRowH + 4;
    ctx.fillStyle = 'rgba(220,80,0,0.25)';
    ctx.fillRect(12, caY, GW - 24, 16);
    ctx.strokeStyle = '#f80';
    ctx.lineWidth = 1;
    ctx.strokeRect(12, caY, GW - 24, 16);
    ctx.fillStyle = '#fa0';
    ctx.font = 'bold 9px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('CLEAR ALL FAULTS', GW / 2, caY + 11);
    cache._optDbgClearRect = { x: 12, y: caY, w: GW - 24, h: 16 };

    // H770: Disable Traffic toggle. Debug-only kill switch — empties
    // ctx.traffic + skips tickTraffic so the player can isolate
    // physics / collision / road-rendering without 20 cars cluttering
    // the camera. Toggle OFF refills the pool.
    const dtY = caY + 22;
    const dtH = 22;
    const dtOn = gp.disableTraffic === true;
    ctx.fillStyle = dtOn ? 'rgba(255,0,255,0.18)' : 'rgba(200,80,255,0.06)';
    ctx.fillRect(12, dtY, GW - 24, dtH);
    ctx.strokeStyle = dtOn ? '#f0f' : '#527';
    ctx.lineWidth = 1;
    ctx.strokeRect(12, dtY, GW - 24, dtH);
    ctx.fillStyle = dtOn ? '#f0f' : '#caf';
    ctx.font = 'bold 10px monospace';
    ctx.textAlign = 'left';
    ctx.fillText('Disable Traffic', 18, dtY + 14);
    const dtTogW = 32, dtTogH = 12;
    const dtTogX = GW - 20 - dtTogW;
    const dtTogY = dtY + 5;
    ctx.fillStyle = dtOn ? '#606' : '#333';
    ctx.fillRect(dtTogX, dtTogY, dtTogW, dtTogH);
    ctx.strokeStyle = dtOn ? '#f0f' : '#666';
    ctx.strokeRect(dtTogX, dtTogY, dtTogW, dtTogH);
    ctx.fillStyle = dtOn ? '#f0f' : '#999';
    ctx.fillRect(dtOn ? dtTogX + dtTogW - 11 : dtTogX + 2, dtTogY + 2, 9, dtTogH - 4);
    cache._optDisableTrafficRect = { x: 12, y: dtY, w: GW - 24, h: dtH };
    ctx.textAlign = 'center';

    // H771: PC Overlay (K=2.5 pcCanvas) A/B kill switch — only
    // meaningful on the PC pipeline; mobile already collapses the
    // overlay via fitCanvases. Toggle ON forces the mobile single-
    // canvas path so the player can isolate the overlay's per-frame
    // cost vs. the monolith baseline.
    const poY = dtY + dtH + 4;
    const poH = 22;
    const poOn = gp.disablePcOverlay === true;
    ctx.fillStyle = poOn ? 'rgba(255,0,255,0.18)' : 'rgba(200,80,255,0.06)';
    ctx.fillRect(12, poY, GW - 24, poH);
    ctx.strokeStyle = poOn ? '#f0f' : '#527';
    ctx.lineWidth = 1;
    ctx.strokeRect(12, poY, GW - 24, poH);
    ctx.fillStyle = poOn ? '#f0f' : '#caf';
    ctx.font = 'bold 10px monospace';
    ctx.textAlign = 'left';
    ctx.fillText('Disable PC Overlay (A/B)', 18, poY + 14);
    const poTogW = 32, poTogH = 12;
    const poTogX = GW - 20 - poTogW;
    const poTogY = poY + 5;
    ctx.fillStyle = poOn ? '#606' : '#333';
    ctx.fillRect(poTogX, poTogY, poTogW, poTogH);
    ctx.strokeStyle = poOn ? '#f0f' : '#666';
    ctx.strokeRect(poTogX, poTogY, poTogW, poTogH);
    ctx.fillStyle = poOn ? '#f0f' : '#999';
    ctx.fillRect(poOn ? poTogX + poTogW - 11 : poTogX + 2, poTogY + 2, 9, poTogH - 4);
    cache._optDisablePcOverlayRect = { x: 12, y: poY, w: GW - 24, h: poH };
    ctx.textAlign = 'center';

    // H774: Disable Traffic Signals A/B — flips the bulb-dot painter
    // that fires at every ROAD_CROSSING within 600px. Confirms whether
    // those colored dots are the off-color circles on highways.
    const tsY = poY + poH + 4;
    const tsH = 22;
    const tsOn = gp.disableTrafficSignals === true;
    ctx.fillStyle = tsOn ? 'rgba(255,0,255,0.18)' : 'rgba(200,80,255,0.06)';
    ctx.fillRect(12, tsY, GW - 24, tsH);
    ctx.strokeStyle = tsOn ? '#f0f' : '#527';
    ctx.lineWidth = 1;
    ctx.strokeRect(12, tsY, GW - 24, tsH);
    ctx.fillStyle = tsOn ? '#f0f' : '#caf';
    ctx.font = 'bold 10px monospace';
    ctx.textAlign = 'left';
    ctx.fillText('Disable Traffic Signals (A/B)', 18, tsY + 14);
    const tsTogW = 32, tsTogH = 12;
    const tsTogX = GW - 20 - tsTogW;
    const tsTogY = tsY + 5;
    ctx.fillStyle = tsOn ? '#606' : '#333';
    ctx.fillRect(tsTogX, tsTogY, tsTogW, tsTogH);
    ctx.strokeStyle = tsOn ? '#f0f' : '#666';
    ctx.strokeRect(tsTogX, tsTogY, tsTogW, tsTogH);
    ctx.fillStyle = tsOn ? '#f0f' : '#999';
    ctx.fillRect(tsOn ? tsTogX + tsTogW - 11 : tsTogX + 2, tsTogY + 2, 9, tsTogH - 4);
    cache._optDisableSignalsRect = { x: 12, y: tsY, w: GW - 24, h: tsH };
    ctx.textAlign = 'center';

    // H775: Disable Streetlights A/B — strongest current hypothesis
    // for the off-color circles on highway asphalt. Toggle ON skips
    // the entire drawStreetlights pass.
    const slY = tsY + tsH + 4;
    const slH = 22;
    const slOn = gp.disableStreetlights === true;
    ctx.fillStyle = slOn ? 'rgba(255,0,255,0.18)' : 'rgba(200,80,255,0.06)';
    ctx.fillRect(12, slY, GW - 24, slH);
    ctx.strokeStyle = slOn ? '#f0f' : '#527';
    ctx.lineWidth = 1;
    ctx.strokeRect(12, slY, GW - 24, slH);
    ctx.fillStyle = slOn ? '#f0f' : '#caf';
    ctx.font = 'bold 10px monospace';
    ctx.textAlign = 'left';
    ctx.fillText('Disable Streetlights (A/B)', 18, slY + 14);
    const slTogW = 32, slTogH = 12;
    const slTogX = GW - 20 - slTogW;
    const slTogY = slY + 5;
    ctx.fillStyle = slOn ? '#606' : '#333';
    ctx.fillRect(slTogX, slTogY, slTogW, slTogH);
    ctx.strokeStyle = slOn ? '#f0f' : '#666';
    ctx.strokeRect(slTogX, slTogY, slTogW, slTogH);
    ctx.fillStyle = slOn ? '#f0f' : '#999';
    ctx.fillRect(slOn ? slTogX + slTogW - 11 : slTogX + 2, slTogY + 2, 9, slTogH - 4);
    cache._optDisableStreetlightsRect = { x: 12, y: slY, w: GW - 24, h: slH };
    ctx.textAlign = 'center';

    dbgBot = slY + slH + 4;
  } else {
    cache._optDbgClearRect = null;
    cache._optDisableTrafficRect = null;
    cache._optDisablePcOverlayRect = null;
    cache._optDisableSignalsRect = null;
    cache._optDisableStreetlightsRect = null;
  }

  // H744: NIGHT CLUSTER palette selector — 3 amber/yellow/orange/
  // green pills the player can tap to swap the cluster glow color
  // that lights the menus + SVG gauges + minimap gray roads at
  // night. Persists to localStorage via setGt2NightPalette so the
  // pick survives reload. Appended after the debug block so it
  // sits at the bottom of the OPT panel.
  const npHdrY = dbgBot + 12;
  ctx.fillStyle = '#ff0';
  ctx.font = 'bold 10px monospace';
  ctx.textAlign = 'left';
  ctx.fillText('NIGHT CLUSTER GLOW', 14, npHdrY);
  ctx.fillStyle = '#888';
  ctx.font = '8px monospace';
  ctx.fillText('Bulb color of the menus + gauges at night.', 14, npHdrY + 11);
  const npY = npHdrY + 18;
  const npH = 30;
  const npGap = 6;
  const npW = Math.floor((GW - 24 - npGap * 2) / 3);
  const npChoices: ReadonlyArray<{
    name: Gt2NightPalette; label: string; sub: string; sample: string;
  }> = [
    { name: 'green',  label: 'GREEN',  sub: 'JDM',  sample: '#5cff6a' },
    { name: 'amber',  label: 'YELLOW', sub: 'Honda 90s', sample: '#d9b860' },
    { name: 'orange', label: 'ORANGE', sub: 'BMW 90s',   sample: '#ff8533' },
  ];
  const npCurrent = getGt2NightPalette();
  cache._optNightPaletteRects = [];
  for (let i = 0; i < 3; i++) {
    const ch = npChoices[i];
    const x = 12 + i * (npW + npGap);
    const active = ch.name === npCurrent;
    ctx.fillStyle = active ? ch.sample : 'rgba(255, 255, 255, 0.06)';
    ctx.fillRect(x, npY, npW, npH);
    ctx.strokeStyle = active ? ch.sample : '#555';
    ctx.lineWidth = active ? 2 : 1;
    ctx.strokeRect(x, npY, npW, npH);
    ctx.fillStyle = active ? '#000' : ch.sample;
    ctx.font = 'bold 10px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(ch.label, x + npW / 2, npY + 13);
    ctx.fillStyle = active ? '#222' : '#888';
    ctx.font = '7px monospace';
    ctx.fillText(ch.sub, x + npW / 2, npY + 24);
    cache._optNightPaletteRects.push({ x, y: npY, w: npW, h: npH, palette: ch.name });
  }
  const npBot = npY + npH;

  const contentBot = npBot;
  ctx.restore();
  const visibleH = clipBot - clipTop;
  const scrollMax = Math.max(0, contentBot - clipBot);
  cache._menuTabScrollMax = scrollMax;
  if (cache._menuTabScrollY !== undefined && cache._menuTabScrollY > scrollMax) {
    cache._menuTabScrollY = scrollMax;
  }
  if (scrollMax > 0) {
    const pct = scrollY / scrollMax;
    const totalH = contentBot - cy;
    const barH = Math.max(20, visibleH * (visibleH / totalH));
    const barY = clipTop + pct * (visibleH - barH);
    ctx.fillStyle = 'rgba(0,200,255,0.35)';
    ctx.fillRect(GW - 4, barY, 3, barH);
  }
}

/** Shared two-line toggle row painter. Box + cyan-when-on tint, label
 *  on the left, sub-line description, on/off pill on the right. Used
 *  by the X-Ray Body row and the CRT Scanlines row.  */
function drawSettingToggleRow(
  ctx: CanvasRenderingContext2D,
  GW: number,
  y: number,
  h: number,
  label: string,
  sub: string,
  on: boolean,
): void {
  ctx.fillStyle = on ? 'rgba(0, 255, 255, 0.15)' : 'rgba(255, 255, 255, 0.06)';
  ctx.fillRect(12, y, GW - 24, h);
  ctx.strokeStyle = on ? '#0ff' : '#444';
  ctx.lineWidth = 1;
  ctx.strokeRect(12, y, GW - 24, h);
  ctx.fillStyle = on ? '#0ff' : '#ddd';
  ctx.font = 'bold 11px monospace';
  ctx.textAlign = 'left';
  ctx.fillText(label, 20, y + 14);
  if (h >= 32) {
    ctx.fillStyle = '#888';
    ctx.font = '8px monospace';
    ctx.fillText(sub, 20, y + 26);
  }
  // Toggle pill on the right.
  const togW = 36;
  const togH = 16;
  const togX = GW - 20 - togW;
  const togY = y + (h - togH) / 2;
  ctx.fillStyle = on ? '#0a4' : '#333';
  ctx.fillRect(togX, togY, togW, togH);
  ctx.strokeStyle = on ? '#0f8' : '#666';
  ctx.strokeRect(togX, togY, togW, togH);
  ctx.fillStyle = on ? '#0ff' : '#999';
  ctx.fillRect(on ? togX + togW - 14 : togX + 2, togY + 2, 12, togH - 4);
  ctx.fillStyle = on ? '#0ff' : '#888';
  ctx.font = 'bold 8px monospace';
  ctx.textAlign = 'center';
  ctx.fillText(on ? 'ON' : 'OFF', togX + togW / 2, togY + togH + 10);
  ctx.textAlign = 'center';
}

/** Tab-body placeholder for not-yet-ported tabs. Keeps the menu
 *  shell usable while bodies land one-by-one. */
function drawTabPlaceholder(
  ctx: CanvasRenderingContext2D,
  tab: MenuTab,
  GW: number,
  GH: number,
): void {
  ctx.fillStyle = '#666';
  ctx.font = 'bold 12px monospace';
  ctx.textAlign = 'center';
  ctx.fillText(TAB_LABELS[tab] + ' tab — body ports next', GW / 2, GH / 2);
  ctx.fillStyle = '#555';
  ctx.font = '10px monospace';
  ctx.fillText('(tap top-right corner or CLOSE to exit)', GW / 2, GH / 2 + 16);
}

/** Tab-strip rect for tap dispatch. H643: divisor matches the draw
 *  pass (MENU_TAB_ORDER.length, not the hard-coded 5). */
function tabRect(GW: number, i: number): { x: number; w: number } {
  const tabSpacing = Math.floor(GW / MENU_TAB_ORDER.length);
  const cx = Math.floor(tabSpacing / 2) + i * tabSpacing;
  const tw = tabSpacing - 4;
  return { x: cx - tw / 2, w: tw };
}

/** Hit-tests the tab strip + close button. Returns true when the
 *  tap was consumed (either route fired or tap landed inside the
 *  menu's canvas — the full-screen modal eats all taps). 1:1 port
 *  of the monolith's main-menu tap dispatch at L20771-20800ish for
 *  the shell parts only — tab-body hit-tests port per tab. */
export function handlePauseMenuClick(
  tx: number,
  ty: number,
  opts: PauseMenuOpts,
  deps: PauseMenuDeps,
): boolean {
  const { state, GW, GH } = opts;
  if (!state.open) return false;

  // H668: close-menu zone is the BOTTOM 28 px of the canvas — matches
  // monolith L21147 (`if(ty > GH_BASE - 28){ menuOpen = false; ... }`).
  // Pre-H668 the close hit reused isMenuOpenCornerHit (tx > GW-82 &&
  // ty < 64), but the tab strip lives at y ∈ [28, 46] and OPT is the
  // rightmost tab (x near GW-20 on the 6-tab strip) — so OPT's rect
  // was ENTIRELY inside the close zone and every OPT tap routed to
  // close instead of switch-tab. User reported "can't select OPT tab,
  // invisible exit button blocks it." Moving close to the bottom
  // de-overlaps the tab strip permanently.
  if (ty > GH - 28) {
    deps.close();
    return true;
  }

  // Tab strip hit. The strip's y range was originally [28, 46] but
  // gets shifted down by the safe-top inset in drawPauseMenu —
  // mirror that here so taps hit the visually-shifted tabs.
  const _safeTopHit = Math.max(GH * 0.05, 4);
  const _dyHit = _safeTopHit - 4;
  if (ty >= 28 + _dyHit && ty <= 46 + _dyHit) {
    for (let i = 0; i < MENU_TAB_ORDER.length; i++) {
      const { x, w } = tabRect(GW, i);
      if (tx >= x && tx <= x + w) {
        const newTab = MENU_TAB_ORDER[i];
        deps.setTab(newTab);
        // H200: lazy-fill the JOBS tab on entry so the player sees
        // today's listings / assignments without a day-rollover
        // trigger. The host inspects life.playerJob / life.job /
        // life.jobDoneToday and calls the right roller.
        if (newTab === 'jobs') deps.fillJobsTab();
        if (newTab === 'race') deps.fillRaceTab();
        // H219: reset OPT scroll on entry so each visit starts
        // at the top. The cap is recomputed on the next paint
        // pass so wheel events thereafter clamp correctly.
        if (opts.life) {
          (opts.life as { _menuTabScrollY?: number })._menuTabScrollY = 0;
        }
        return true;
      }
    }
  }

  // H194: SWITCH CAR button on STATUS tab. Cached Y stashed on
  // life._statusSwitchY by drawStatusTab during paint. 1:1 with
  // monolith L21733 (button height 22, x from 25 to GW-25).
  if (state.tab === 'car' && opts.life) {
    const swY = (opts.life as { _statusSwitchY?: number })._statusSwitchY;
    if (typeof swY === 'number' && ty >= swY && ty <= swY + 22 && tx >= 25 && tx <= GW - 25) {
      deps.switchCar();
      return true;
    }
  }

  // H593: LOT tab — row taps open inspection; RESHUFFLE re-rolls.
  // Cached rects on life._lotRowHits / life._lotReshuffleRect from
  // the last paint.
  if (state.tab === 'lot' && opts.life) {
    const reRect = (opts.life as { _lotReshuffleRect?: { x: number; y: number; w: number; h: number } })
      ._lotReshuffleRect;
    if (reRect && tx >= reRect.x && tx <= reRect.x + reRect.w
        && ty >= reRect.y && ty <= reRect.y + reRect.h) {
      deps.optLotReshuffle();
      return true;
    }
    const rowHits = (opts.life as { _lotRowHits?: Array<{ x: number; y: number; w: number; h: number; idx: number }> })
      ._lotRowHits;
    if (rowHits) {
      for (const r of rowHits) {
        if (tx >= r.x && tx <= r.x + r.w && ty >= r.y && ty <= r.y + r.h) {
          deps.optLotInspect(r.idx);
          return true;
        }
      }
    }
  }

  // H221/H222: RACE tab taps — stake-type tabs first, then the
  // stake-body widgets (bet ± / prev-next car / START RACE / reroll
  // opponent). Only eligible rects land in the cache so greyed-out
  // controls fall through silently.
  if (state.tab === 'race' && opts.life?.race) {
    const race = opts.life.race;
    const tabRects = (opts.life as {
      _raceStakeTabRects?: Array<{ x: number; y: number; w: number; h: number; key: RaceStakeType }>;
    })._raceStakeTabRects;
    if (tabRects) {
      for (const r of tabRects) {
        if (tx >= r.x && tx <= r.x + r.w && ty >= r.y && ty <= r.y + r.h) {
          race.stakeType = r.key;
          return true;
        }
      }
    }
    // H829/H830: start-mode selector (BESIDE / TRAFFIC / MEET).
    const modeRects = (opts.life as {
      _raceModeRects?: Array<{ x: number; y: number; w: number; h: number; key: RaceStartMode }>;
    })._raceModeRects;
    if (modeRects) {
      for (const r of modeRects) {
        if (tx >= r.x && tx <= r.x + r.w && ty >= r.y && ty <= r.y + r.h) {
          race.startMode = r.key;
          return true;
        }
      }
    }
    const stakeRects = (opts.life as {
      _raceStakeRects?: Record<string, { x: number; y: number; w: number; h: number }>;
    })._raceStakeRects;
    if (stakeRects) {
      const hit = (k: string): boolean => {
        const r = stakeRects[k];
        return !!r && tx >= r.x && tx <= r.x + r.w && ty >= r.y && ty <= r.y + r.h;
      };
      if (hit('minus')) {
        race.betInput = Math.max(RACE_BET_MIN, race.betInput - RACE_BET_STEP);
        return true;
      }
      if (hit('plus')) {
        race.betInput = Math.min(opts.life.money, race.betInput + RACE_BET_STEP);
        return true;
      }
      if (hit('prevCar')) {
        const cars = getEligibleStakeCars(opts.life);
        if (cars.length > 1 && race.stakeCarId) {
          const idx = cars.indexOf(race.stakeCarId);
          race.stakeCarId = cars[(idx - 1 + cars.length) % cars.length];
        }
        return true;
      }
      if (hit('nextCar')) {
        const cars = getEligibleStakeCars(opts.life);
        if (cars.length > 1 && race.stakeCarId) {
          const idx = cars.indexOf(race.stakeCarId);
          race.stakeCarId = cars[(idx + 1) % cars.length];
        }
        return true;
      }
      if (hit('startRace')) {
        deps.startRace();
        return true;
      }
      if (hit('rerollOpp')) {
        deps.rerollRaceOpponent();
        return true;
      }
    }
  }

  // H566: CAL tab — ◀ ▶ month navigation arrows. Cached rects on
  // life._calNavRects from the last paint. Increment / decrement
  // life.calViewMonth and consume the tap.
  if (state.tab === 'cal' && opts.life) {
    const dir = hitCalendarNav(tx, ty, opts.life._calNavRects);
    if (dir !== 0) {
      opts.life.calViewMonth = (opts.life.calViewMonth ?? 0) + dir;
      return true;
    }
  }

  // H560: OPT tab click routing. Cached Y values are in CONTENT
  // space — the H219 scroll wrapper translates paint by -scrollY,
  // so tap Y is shifted by +scrollY before hit-test. Taps outside
  // the clip range stay reachable for the tab strip + CLOSE button.
  if (state.tab === 'opt' && opts.life) {
    const cache = opts.life as unknown as OptHitCache;
    const clipBot = opts.GH - OPT_CLIP_BOT_MARGIN;
    if (ty >= OPT_CLIP_TOP && ty <= clipBot) {
      const tyContent = ty + (cache._menuTabScrollY ?? 0);
      const hitRect = (r?: { x: number; y: number; w: number; h: number } | null): boolean =>
        !!r && tx >= r.x && tx <= r.x + r.w && tyContent >= r.y && tyContent <= r.y + r.h;
      const hitRow = (y: number | undefined | null, h: number): boolean =>
        typeof y === 'number'
        && tyContent >= y
        && tyContent <= y + h
        && tx >= 12 && tx <= GW - 12;

      // Top buttons.
      if (hitRect(cache._optRestartRect)) { deps.optRestart(); return true; }
      if (hitRect(cache._optQuitRect)) { deps.optQuit(); return true; }

      // DISPLAY toggles.
      if (hitRow(cache._optXrayRowY, 36)) { deps.optToggleXray(); return true; }
      if (hitRow(cache._optScanRowY, 24)) { deps.optToggleScanlines(); return true; }
      if (hitRow(cache._optFPSRowY, 24)) { deps.optToggleFPS(); return true; }
      if (hitRow(cache._optMapStyleRowY, 24)) { deps.optToggleMapStyle(); return true; }
      if (hitRow(cache._optTopDownRowY, 36)) { deps.optToggleCameraTilt(); return true; }

      // GAMEPLAY toggle (H960).
      if (hitRow(cache._optSimModeRowY, 36)) { deps.optToggleSimulationMode(); return true; }

      // PHYSICS toggles. Dynamic Physics row only fires when bicycle
      // model is on (the row is greyed otherwise — mirror that gate).
      if (hitRow(cache._optBicycleRowY, 36)) { deps.optToggleBicycleModel(); return true; }
      const gp = opts.life.gameplaySettings as Record<string, number | boolean | undefined>;
      if (hitRow(cache._optDyn0BRowY, 24)) {
        if (gp.bicycleModel === true) deps.optToggleDynPhysics0B();
        return true;
      }

      // INPUT toggles.
      if (hitRow(cache._optInvertPedalsRowY, 24)) { deps.optToggleInvertPedals(); return true; }
      if (hitRow(cache._optManualTransRowY, 24)) { deps.optToggleManualTransmission(); return true; }
      if (hitRow(cache._optPcTouchControlsRowY, 24)) { deps.optTogglePcTouchControls(); return true; }

      // Steering sens.
      if (hitRect(cache._optSensMinus)) { deps.optAdjustSteerSens(-0.1); return true; }
      if (hitRect(cache._optSensPlus)) { deps.optAdjustSteerSens(0.1); return true; }
      const sensTrack = cache._optSensTrack;
      if (hitRect(sensTrack) && sensTrack) {
        const frac = Math.max(0, Math.min(1, (tx - sensTrack.x) / sensTrack.w));
        const target = sensTrack.min + frac * (sensTrack.max - sensTrack.min);
        const current = (gp[sensTrack.key] as number | undefined) ?? 1.0;
        deps.optAdjustSteerSens(target - current);
        return true;
      }

      // PC render scale (step ladder).
      if (hitRect(cache._optRenderScaleMinus ?? undefined)) { deps.optAdjustRenderScale(-1); return true; }
      if (hitRect(cache._optRenderScalePlus ?? undefined)) { deps.optAdjustRenderScale(1); return true; }
      // H817: tap/drag the track to set an absolute scale (snapped to
      // 0.05 host-side). Maps tap-x across the track to [0.5, 2.0].
      {
        const trk = cache._optRenderScaleTrack;
        if (trk && hitRect(trk)) {
          const frac = Math.max(0, Math.min(1, (tx - trk.x) / trk.w));
          deps.optSetRenderScale(0.5 + frac * (2.0 - 0.5));
          return true;
        }
      }

      // H744: NIGHT CLUSTER palette pills — green / yellow / orange.
      // Calls setGt2NightPalette directly (palette state lives in
      // gt2Chrome.ts, not on LifeState, so no deps dispatch needed).
      const npRects = cache._optNightPaletteRects;
      if (npRects) {
        for (const r of npRects) {
          if (hitRect(r)) {
            setGt2NightPalette(r.palette);
            return true;
          }
        }
      }

      // Audio rows.
      if (cache._optAudioHits) {
        for (const row of cache._optAudioHits) {
          if (hitRect(row.mns) && row.mns.key) { deps.optAdjustVolume(row.mns.key, -0.05); return true; }
          if (hitRect(row.pls) && row.pls.key) { deps.optAdjustVolume(row.pls.key, 0.05); return true; }
          if (hitRect(row.trk) && row.trk.key) {
            const frac = Math.max(0, Math.min(1, (tx - row.trk.x) / row.trk.w));
            const current = (gp[row.trk.key] as number | undefined) ?? 1.0;
            deps.optAdjustVolume(row.trk.key, frac - current);
            return true;
          }
        }
      }

      // Physics tuning ± buttons.
      if (cache._optPhysHits) {
        for (const h of cache._optPhysHits) {
          if (tx >= h.x && tx <= h.x + h.w && tyContent >= h.y && tyContent <= h.y + h.h) {
            deps.optAdjustPhysTune(h.key, h.dir, h.step, h.min, h.max);
            return true;
          }
        }
      }

      // Debug HUD toggle.
      if (hitRect(cache._optDbgHudRect)) { deps.optToggleDebugHUD(); return true; }

      // H591: Fault DEBUG (test mode) enable/disable toggle.
      if (hitRect(cache._optTestModeRect)) { deps.optToggleTestMode(); return true; }

      // H562: test-mode DEBUG hits. Order: CLEAR ALL FAULTS first
      // (sits below the fault list, no overlap risk but explicit
      // priority), then stat sliders, then fault rows. Each slider
      // sets value to (tx - track.tx) / track.tw * 100 clamped to
      // [0, 100]. Fault rows toggle the entry in life.faults.
      if (hitRect(cache._optDbgClearRect)) { deps.optDbgClearFaults(); return true; }
      if (hitRect(cache._optDisableTrafficRect)) { deps.optToggleDisableTraffic(); return true; }
      if (hitRect(cache._optDisablePcOverlayRect)) { deps.optTogglePcOverlay(); return true; }
      if (hitRect(cache._optDisableSignalsRect)) { deps.optToggleTrafficSignals(); return true; }
      if (hitRect(cache._optDisableStreetlightsRect)) { deps.optToggleStreetlights(); return true; }
      if (cache._optDbgStats) {
        for (const s of cache._optDbgStats) {
          if (tx >= s.x && tx <= s.x + s.w && tyContent >= s.y && tyContent <= s.y + s.h) {
            const frac = Math.max(0, Math.min(1, (tx - s.tx) / s.tw));
            deps.optDbgSetStat(s.k, Math.round(frac * 100));
            return true;
          }
        }
      }
      if (cache._optDbgFaultHits) {
        for (const f of cache._optDbgFaultHits) {
          if (tx >= f.x && tx <= f.x + f.w && tyContent >= f.y && tyContent <= f.y + f.h) {
            deps.optDbgToggleFault(f.id, f.entry);
            return true;
          }
        }
      }
    }
  }

  // H195/H200: JOBS tab buttons. Hit-test order matters: QUIT JOB
  // first (active assignment); then ACCEPT taps on _availJobs rows;
  // then APPLY taps on _jobListings rows; then SKIP WORK. All
  // cached Y values populated by drawJobsTab.
  if (state.tab === 'jobs' && opts.life) {
    const life = opts.life as {
      _jobsQuitY?: number;
      _jobsSkipY?: number;
      _jobsAvailYs?: number[];
      _jobsListingYs?: number[];
    };
    const qY = life._jobsQuitY;
    if (typeof qY === 'number' && opts.life.job && ty >= qY && ty <= qY + 20 && tx >= 25 && tx <= GW - 25) {
      deps.quitJob();
      return true;
    }
    // ACCEPT — row hit-test against the cached _availJobs Ys.
    if (life._jobsAvailYs && opts.life._availJobs && !opts.life.job) {
      for (let i = 0; i < life._jobsAvailYs.length; i++) {
        const jy = life._jobsAvailYs[i];
        if (ty >= jy && ty <= jy + 30 && tx >= 15 && tx <= GW - 15) {
          const picked = opts.life._availJobs[i];
          if (picked) deps.acceptJob(picked);
          return true;
        }
      }
    }
    // APPLY — row hit-test against the cached _jobListings Ys.
    if (life._jobsListingYs && opts.life._jobListings && !opts.life.playerJob) {
      for (let i = 0; i < life._jobsListingYs.length; i++) {
        const jy = life._jobsListingYs[i];
        if (ty >= jy && ty <= jy + 30 && tx >= 15 && tx <= GW - 15) {
          const opening = opts.life._jobListings[i];
          if (opening) deps.applyForJob(opening as JobOpening);
          return true;
        }
      }
    }
    const skY = life._jobsSkipY;
    if (typeof skY === 'number' && !opts.life.job && opts.life.playerJob && ty >= skY && ty <= skY + 26 && tx >= 25 && tx <= GW - 25) {
      deps.skipWork();
      return true;
    }
  }

  // CLOSE button (centered). H736 moved the y anchor from GH-40 to
  // GH-32 so the single consolidated pill replaces the prior
  // overlapping "X CLOSE" label + button pair.
  const cbx = GW / 2 - 50;
  const cby = GH - 32;
  if (tx >= cbx && tx <= cbx + 100 && ty >= cby && ty <= cby + 24) {
    deps.close();
    return true;
  }

  // Full-screen modal eats every tap.
  return true;
}
