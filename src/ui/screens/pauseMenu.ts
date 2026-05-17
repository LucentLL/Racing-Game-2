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
} from '@/sim/race';
import { HOUSING_TIERS, type HousingTierKey } from '@/config/housing';
import type { Clock } from '@/state/clock';
import { DAYS_PER_MONTH } from '@/sim/monthlyBills';

/** Tab keys. The 'car' key name is legacy (the visible label is
 *  'STATUS' since v8.99.122.43 — the renamed tab kept the internal
 *  key for hotkey + tab-order continuity). 1:1 with monolith
 *  TAB_ORDER at L20115. */
export type MenuTab = 'car' | 'jobs' | 'race' | 'cal' | 'opt';

export const MENU_TAB_ORDER: readonly MenuTab[] = ['car', 'jobs', 'race', 'cal', 'opt'] as const;

/** Display labels for the tab strip. */
const TAB_LABELS: Record<MenuTab, string> = {
  car: 'STATUS',
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

  // Full-canvas black backdrop.
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, GW, GH);

  ctx.textAlign = 'center';
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 20px monospace';
  ctx.fillText('DRIVER CITY', GW / 2, 22);

  // Tab strip — 5 evenly spaced. Cyan-highlight on the active tab,
  // dim white otherwise. 1:1 with L34552-34563.
  const tabSpacing = Math.floor(GW / 5);
  MENU_TAB_ORDER.forEach((t, i) => {
    const tx = Math.floor(tabSpacing / 2) + i * tabSpacing;
    const tw = tabSpacing - 4;
    const active = state.tab === t;
    ctx.fillStyle = active ? 'rgba(0, 200, 255, 0.2)' : 'rgba(255, 255, 255, 0.1)';
    ctx.fillRect(tx - tw / 2, 28, tw, 18);
    ctx.strokeStyle = active ? '#0ff' : '#444';
    ctx.lineWidth = 1;
    ctx.strokeRect(tx - tw / 2, 28, tw, 18);
    ctx.fillStyle = active ? '#0ff' : '#888';
    ctx.font = 'bold 9px monospace';
    ctx.fillText(TAB_LABELS[t], tx, 40);
  });

  // Tab-body dispatch. The monolith branches on `menuTab` inside
  // the same drawPlaying block at L34566+; we mirror that with one
  // helper per tab. Bodies that need LIFE early-return to the
  // placeholder for pre-playing-state opens (shouldn't happen in
  // practice — the open-tap guard requires gameState='playing' —
  // but defensive).
  const cy = 56; // monolith L34565 — first content y below the tab strip
  if (state.tab === 'car' && opts.life) {
    drawStatusTab(ctx, opts.life, GW, GH, cy);
  } else if (state.tab === 'jobs' && opts.life) {
    drawJobsTab(ctx, opts.life, opts.clock, GW, GH, cy);
  } else if (state.tab === 'race' && opts.life) {
    drawRaceTab(ctx, opts.life, GW, GH, cy);
  } else if (state.tab === 'cal') {
    drawCalTab(ctx, opts.clock, GW, GH, cy);
  } else if (state.tab === 'opt' && opts.life) {
    drawOptTab(ctx, opts.life, GW, GH, cy);
  } else {
    drawTabPlaceholder(ctx, state.tab, GW, GH);
  }

  // CLOSE button at bottom-center.
  const cbx = GW / 2 - 50;
  const cby = GH - 40;
  ctx.fillStyle = 'rgba(255, 80, 0, 0.2)';
  ctx.fillRect(cbx, cby, 100, 24);
  ctx.strokeStyle = '#f80';
  ctx.lineWidth = 2;
  ctx.strokeRect(cbx, cby, 100, 24);
  ctx.fillStyle = '#f80';
  ctx.font = 'bold 11px monospace';
  ctx.fillText('CLOSE', GW / 2, cby + 16);
  ctx.lineWidth = 1;

  ctx.textAlign = 'left';
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
  ctx.strokeStyle = '#0ff';
  ctx.lineWidth = 1;
  ctx.strokeRect(8, cy + 2, _stPortS, _stPortS);

  // Right-of-portrait info column. 1:1 with L34585-34591.
  ctx.textAlign = 'left';
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 11px monospace';
  ctx.fillText(life.playerAlias + ' • ' + life.age, 46, cy + 12);
  ctx.fillStyle = '#888';
  ctx.font = '9px monospace';
  ctx.fillText(life.playerJob || 'Unemployed', 46, cy + 24);
  ctx.fillStyle = '#0f0';
  ctx.font = 'bold 10px monospace';
  ctx.fillText('$' + life.money.toLocaleString(), 46, cy + 36);

  ctx.textAlign = 'center';
  const _bX = 10;
  const _bW = GW - 20;
  const _bH = 10;

  // Health bar. 1:1 with L34594-34602.
  const _hsSt = getHealthStatus(life.health);
  const _hPctSt = Math.max(0, Math.min(1, life.health / 100));
  const _hbY = cy + 42;
  ctx.fillStyle = '#222';
  ctx.fillRect(_bX, _hbY, _bW, _bH);
  ctx.fillStyle = _hsSt.color;
  ctx.fillRect(_bX, _hbY, Math.round(_bW * _hPctSt), _bH);
  ctx.strokeStyle = '#444';
  ctx.lineWidth = 1;
  ctx.strokeRect(_bX, _hbY, _bW, _bH);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 8px monospace';
  ctx.fillText(
    _hsSt.icon + ' Health ' + Math.round(life.health) + '% — ' + _hsSt.label,
    GW / 2,
    _hbY + 8,
  );

  // Fitness bar. 1:1 with L34604-34611.
  const _fsSt = getFitnessStatus(life.fitness);
  const _fPctSt = Math.max(0, Math.min(1, life.fitness / 100));
  const _fbY = cy + 54;
  ctx.fillStyle = '#222';
  ctx.fillRect(_bX, _fbY, _bW, _bH);
  ctx.fillStyle = _fsSt.color;
  ctx.fillRect(_bX, _fbY, Math.round(_bW * _fPctSt), _bH);
  ctx.strokeStyle = '#444';
  ctx.lineWidth = 1;
  ctx.strokeRect(_bX, _fbY, _bW, _bH);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 8px monospace';
  ctx.fillText(
    '💪 Fitness ' + Math.round(life.fitness) + '% — ' + _fsSt.label,
    GW / 2,
    _fbY + 8,
  );

  // Status warnings (hunger / sleep). 1:1 with L34613-34623.
  const warn: string[] = [];
  if (life.daysSinceEat >= 2) warn.push('🚨 Starving');
  else if (life.daysSinceEat >= 1) warn.push('⚠ Hungry');
  if (life.daysSinceSleep >= 2) warn.push('🚨 Exhausted');
  else if (life.daysSinceSleep >= 1) warn.push('⚠ Tired');
  let extraY = 0;
  if (warn.length > 0) {
    ctx.fillStyle = '#f88';
    ctx.font = '8px monospace';
    ctx.fillText(warn.join(' • '), GW / 2, cy + 74);
    extraY = 10;
  }

  // Divider. 1:1 with L34626-34628.
  const divY = cy + 76 + extraY;
  ctx.strokeStyle = '#444';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(10, divY);
  ctx.lineTo(GW - 10, divY);
  ctx.stroke();

  // ---- VEHICLE BLOCK ----
  // Resolves the active car from ownedCars[0] (same convention the
  // rest of the modular runtime uses). When no car is owned we
  // surface a "no vehicle" line so the layout doesn't collapse.
  const activeCarId = life.ownedCars[0];
  const car = activeCarId ? CAR_CATALOG[activeCarId] : undefined;
  if (!car) {
    ctx.fillStyle = '#666';
    ctx.font = '10px monospace';
    ctx.fillText('— no vehicle —', GW / 2, divY + 24);
    return;
  }

  const vY = divY + 10;
  ctx.fillStyle = '#0ff';
  ctx.font = 'bold 12px monospace';
  ctx.fillText(car.name, GW / 2, vY);

  // Origin / tier / odo line. 1:1 with monolith L34634-34637. Origin
  // emoji falls through to '???' when CatalogCar.origin is missing
  // (the modular catalog hasn't grown origin yet — same fallback the
  // monolith uses at L34634).
  const originLabel = vehicleOriginLabel(car);
  const tierLabel = mileageTierLabel(life.carOdometers?.[activeCarId] ?? 0);
  const odoLabel = fmtOdoFor(activeCarId, life, car);
  ctx.fillStyle = '#888';
  ctx.font = '9px monospace';
  ctx.fillText(originLabel + ' • ' + tierLabel + ' • ' + odoLabel, GW / 2, vY + 12);

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

  // Condition specs. 1:1 with L34662-34673.
  const cY = spZoneY + spZoneH + 10;
  ctx.fillStyle = '#aaa';
  ctx.font = 'bold 10px monospace';
  ctx.fillText(
    'Eng:' + Math.round(life.engine) + '% '
      + 'Tire:' + Math.round(life.tires) + '% '
      + 'Paint:' + Math.round(life.paint) + '%',
    GW / 2,
    cY,
  );
  ctx.fillText(
    'Body:' + Math.round(life.carHP) + '%  Fuel:' + Math.round(life.fuel) + '%',
    GW / 2,
    cY + 12,
  );
  ctx.fillStyle = '#0ff';
  ctx.font = 'bold 10px monospace';
  ctx.fillText(
    'Transmission: ' + (life.isManual ? 'MANUAL' : 'AUTOMATIC'),
    GW / 2,
    cY + 24,
  );

  // Diagnosed faults section. 1:1 with L34675-34695, minus the
  // per-fault FAULT_EFFECTS desc line (FAULT_EFFECTS isn't ported
  // yet — names only for now).
  let fEndY = cY + 30;
  const faults = (life.faults ?? []) as Array<{ name?: string }>;
  if (faults.length > 0) {
    ctx.fillStyle = '#f44';
    ctx.font = 'bold 9px monospace';
    ctx.fillText('⚠ DIAGNOSED ISSUES:', GW / 2, fEndY + 4);
    let fy = fEndY + 14;
    for (const f of faults) {
      ctx.fillStyle = '#f88';
      ctx.font = 'bold 9px monospace';
      ctx.fillText('• ' + (f.name ?? 'Unknown'), GW / 2, fy);
      fy += 11;
    }
    ctx.fillStyle = '#666';
    ctx.font = '8px monospace';
    ctx.fillText('Fix at home garage, mechanic, or dealership', GW / 2, fy + 2);
    fEndY = fy + 8;
  }

  // SWITCH CAR button. Stashes Y on LIFE._statusSwitchY for the
  // click router. 1:1 with L34697-34704.
  const switchY = fEndY + 4;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
  ctx.fillRect(25, switchY, GW - 50, 22);
  ctx.strokeStyle = '#888';
  ctx.lineWidth = 1;
  ctx.strokeRect(25, switchY, GW - 50, 22);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 11px monospace';
  ctx.fillText('SWITCH CAR (C)', GW / 2, switchY + 14);
  (life as { _statusSwitchY?: number })._statusSwitchY = switchY;
}

/** Mileage-tier label — 'LOW MILES' / 'MID MILES' / 'HIGH MILES'.
 *  1:1 with monolith L42862-42866 + L34635 label map. */
function mileageTierLabel(rawOdoUnits: number): string {
  const mi = rawOdoUnits * 0.0001278;
  if (mi < 60000) return 'LOW MILES';
  if (mi < 150000) return 'MID MILES';
  return 'HIGH MILES';
}

/** Origin emoji + label ('🇯🇵 JPN' etc). Falls through to '???' when
 *  the catalog entry doesn't carry origin yet. */
function vehicleOriginLabel(car: CatalogCar): string {
  const origin = (car as { origin?: 'jpn' | 'usa' | 'eur' }).origin;
  if (origin === 'jpn') return '🇯🇵 JPN';
  if (origin === 'usa') return '🇺🇸 USA';
  if (origin === 'eur') return '🇪🇺 EUR';
  return '???';
}

/** Per-car odometer formatter — picks km vs mi via getEffectiveRHD.
 *  1:1 with monolith fmtOdo at L8987. */
function fmtOdoFor(carId: string, life: LifeState, car: CatalogCar): string {
  const raw = life.carOdometers?.[carId] ?? 0;
  const isKm = getEffectiveRHD(carId, life, carId, CAR_CATALOG);
  const dist = isKm ? raw * 0.0002056 : raw * 0.0001278;
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

/** Short date string — placeholder for the un-ported getDateString
 *  at monolith L45467 (`dayNames[day-1 % 7] + monthNames[month] +
 *  dayOfMonth`). The modular clock doesn't carry month/dayOfMonth/
 *  dayNames yet; "Day N" matches the home-overlay header convention
 *  until those fields port. */
function shortDateLine(clock: Clock): string {
  return 'Day ' + clock.day;
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
  ctx.fillStyle = '#888';
  ctx.font = '10px monospace';
  ctx.fillText(life.playerAlias + ' — ' + (life.playerJob || 'Unemployed'), GW / 2, cy - 8);
  ctx.fillText(shortDateLine(clock), GW / 2, cy + 2);

  const jobKey = life.playerJob as JobName | '' | undefined;
  const sal = jobKey && JOB_SALARY[jobKey as JobName] ? JOB_SALARY[jobKey as JobName] : 0;
  ctx.fillStyle = '#ff0';
  ctx.font = 'bold 11px monospace';
  ctx.fillText('Salary: $' + sal + '/day', GW / 2, cy + 16);

  const perk = jobKey && jobKey in JOB_PERKS ? JOB_PERKS[jobKey as JobName] : '';
  ctx.fillStyle = '#0ff';
  ctx.font = '10px monospace';
  ctx.fillText('Perk: ' + (perk || 'None'), GW / 2, cy + 28);

  const _hs = getHealthStatus(life.health);
  ctx.fillStyle = '#aaa';
  ctx.font = '10px monospace';
  ctx.fillText(
    _hs.icon + ' Health:' + Math.round(life.health) + '% • Food:' + getTotalFood(life.foodStock),
    GW / 2,
    cy + 42,
  );

  // ---- STATE BRANCH ----
  if (life.job) {
    // Active job — show type/pay + status + QUIT JOB. 1:1 with
    // monolith L34735-34743.
    ctx.fillStyle = '#ff0';
    ctx.font = 'bold 12px monospace';
    const status = life.job.pickedUp ? 'DELIVERING' : 'GO TO PICKUP';
    ctx.fillText(life.job.type + ' — $' + life.job.pay, GW / 2, cy + 58);
    ctx.fillStyle = '#0ff';
    ctx.font = '11px monospace';
    ctx.fillText(status, GW / 2, cy + 72);
    ctx.fillStyle = 'rgba(255, 0, 0, 0.15)';
    ctx.fillRect(25, cy + 78, GW - 50, 20);
    ctx.strokeStyle = '#f44';
    ctx.lineWidth = 1;
    ctx.strokeRect(25, cy + 78, GW - 50, 20);
    ctx.fillStyle = '#f44';
    ctx.font = 'bold 11px monospace';
    ctx.fillText('QUIT JOB', GW / 2, cy + 92);
    (life as { _jobsQuitY?: number })._jobsQuitY = cy + 78;
    return;
  }

  if (life.jobDoneToday) {
    // Green confirmation. 1:1 with L34744-34748.
    ctx.fillStyle = '#0f0';
    ctx.font = 'bold 12px monospace';
    ctx.fillText('JOB DONE TODAY!', GW / 2, cy + 60);
    ctx.fillStyle = '#0ff';
    ctx.font = '11px monospace';
    ctx.fillText('Go Home to start next day', GW / 2, cy + 76);
    return;
  }

  if (!life.playerJob) {
    // Unemployed — show _jobListings to apply for. 1:1 with L34749-
    // 34770. Generator that fills _jobListings is un-ported, so we
    // render the empty state until it lands.
    ctx.fillStyle = '#f80';
    ctx.font = 'bold 12px monospace';
    ctx.fillText(life._fired ? '⚠ YOU GOT FIRED' : 'UNEMPLOYED', GW / 2, cy + 52);
    ctx.fillStyle = '#aaa';
    ctx.font = '10px monospace';
    ctx.fillText('Apply for available positions:', GW / 2, cy + 66);
    const listings = life._jobListings ?? [];
    if (listings.length === 0) {
      ctx.fillStyle = '#888';
      ctx.font = '10px monospace';
      ctx.fillText('No openings today. Sleep & try tomorrow.', GW / 2, cy + 86);
    } else {
      const listingYs: number[] = [];
      listings.forEach((j, i) => {
        const jy = cy + 76 + i * 36;
        listingYs.push(jy);
        ctx.fillStyle = 'rgba(255, 140, 0, 0.12)';
        ctx.fillRect(15, jy, GW - 30, 30);
        ctx.strokeStyle = '#f80';
        ctx.lineWidth = 1;
        ctx.strokeRect(15, jy, GW - 30, 30);
        ctx.fillStyle = '#f80';
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
    const jy = cy + 50 + i * 36;
    rowYs.push(jy);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
    ctx.fillRect(15, jy, GW - 30, 30);
    ctx.strokeStyle = '#888';
    ctx.lineWidth = 1;
    ctx.strokeRect(15, jy, GW - 30, 30);
    ctx.fillStyle = '#0f0';
    ctx.font = 'bold 11px monospace';
    ctx.fillText(j.type + ' — $' + j.pay, GW / 2, jy + 13);
    ctx.fillStyle = '#888';
    ctx.font = '10px monospace';
    ctx.fillText('TAP to accept', GW / 2, jy + 25);
  });
  (life as { _jobsAvailYs?: number[] })._jobsAvailYs = rowYs;

  // SKIP WORK button — anchored after the avail-job rows. 1:1
  // with L34783-34790.
  const skipY = cy + 50 + availJobs.length * 36 + 8;
  ctx.fillStyle = 'rgba(255, 80, 0, 0.15)';
  ctx.fillRect(25, skipY, GW - 50, 26);
  ctx.strokeStyle = '#f80';
  ctx.strokeRect(25, skipY, GW - 50, 26);
  ctx.fillStyle = '#f80';
  ctx.font = 'bold 11px monospace';
  ctx.fillText('⚠ SKIP WORK TODAY', GW / 2, skipY + 12);
  ctx.fillStyle = '#888';
  ctx.font = '9px monospace';
  const repWarn = life.workRep < 20
    ? '⚠ LOW REP — high fire risk!'
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
    ctx.fillStyle = '#88f';
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
  ctx.fillStyle = '#f80';
  ctx.font = 'bold 14px monospace';
  ctx.fillText('🏁 1v1 STREET RACE', GW / 2, cy);

  if (!race || race.phase !== 'setup') {
    ctx.fillStyle = '#666';
    ctx.font = '10px monospace';
    ctx.fillText('No race rolled yet — re-enter tab to pick an opponent.', GW / 2, cy + 24);
    return;
  }

  const oppCar = CAR_CATALOG[race.oppId];
  if (!oppCar) {
    ctx.fillStyle = '#f44';
    ctx.font = '10px monospace';
    ctx.fillText('Opponent missing from catalog — re-enter tab.', GW / 2, cy + 24);
    return;
  }

  // VS line.
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 11px monospace';
  ctx.fillText('VS: ' + race.oppName, GW / 2, cy + 18);
  ctx.fillStyle = '#aaa';
  ctx.font = '10px monospace';
  ctx.fillText(oppCar.hp + 'hp ' + oppCar.kg + 'kg ' + oppCar.drv, GW / 2, cy + 32);

  // Player car line.
  const activeCarId = life.ownedCars[0];
  const playerCar = activeCarId ? CAR_CATALOG[activeCarId] : undefined;
  ctx.fillStyle = '#0ff';
  ctx.font = '10px monospace';
  if (playerCar) {
    ctx.fillText('YOU: ' + playerCar.name + ' (' + playerCar.hp + 'hp)', GW / 2, cy + 48);
  } else {
    ctx.fillText('YOU: — no car —', GW / 2, cy + 48);
  }

  // Tier match indicator — green when matched, yellow on mismatch.
  if (playerCar) {
    const pTier = getRaceTier(playerCar.hp);
    const oTier = getRaceTier(oppCar.hp);
    ctx.fillStyle = pTier === oTier ? '#0f0' : '#ff0';
    ctx.font = 'bold 9px monospace';
    ctx.fillText('TIER: ' + RACE_TIER_NAMES[pTier] + ' vs ' + RACE_TIER_NAMES[oTier], GW / 2, cy + 62);
  }

  // H221: stake-type tab strip (💵 MONEY / 🚗 CAR / 🏠 HOUSE).
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
    { key: 'money', label: '💵 MONEY', enabled: true },
    { key: 'car',   label: '🚗 CAR',   enabled: canStakeCar },
    { key: 'house', label: '🏠 HOUSE', enabled: canStakeHouse },
  ];
  const stTW = (GW - 40) / 3;
  const stTY = cy + 72;
  const stTabRects: Array<{ x: number; y: number; w: number; h: number; key: RaceStakeType }> = [];
  stakeTabs.forEach((tb, i) => {
    const stTx = 20 + i * stTW;
    const active = race.stakeType === tb.key;
    const col = !tb.enabled ? '#333' : active ? '#ff0' : '#888';
    ctx.fillStyle = active
      ? 'rgba(255, 240, 0, 0.18)'
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
    ctx.fillStyle = '#ff0';
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
      ctx.fillStyle = '#ff0';
      ctx.font = 'bold 11px monospace';
      ctx.fillText('STAKING: ' + scCar.name, GW / 2, bY + 10);
      ctx.fillStyle = '#8f8';
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
    ctx.fillStyle = '#ff0';
    ctx.font = 'bold 11px monospace';
    ctx.fillText('STAKING: ' + (tier?.name ?? 'home'), GW / 2, bY + 10);
    ctx.fillStyle = '#8f8';
    ctx.font = '10px monospace';
    ctx.fillText('Value: $' + houseVal.toLocaleString() + ' (owned free & clear)', GW / 2, bY + 26);
    ctx.fillStyle = '#f88';
    ctx.font = '8px monospace';
    ctx.fillText('⚠ Lose = downgrade to 1BR Apartment', GW / 2, bY + 42);
  }

  // Cash display.
  ctx.fillStyle = '#0f0';
  ctx.font = '10px monospace';
  ctx.fillText('Cash: $' + life.money.toLocaleString(), GW / 2, cy + 148);

  // START RACE button — gated on stake-type-specific affordability.
  const canRace = race.stakeType === 'money'
    ? life.money >= race.betInput && race.betInput >= RACE_BET_MIN
    : race.stakeType === 'car'
      ? !!race.stakeCarId
      : houseVal > 0;
  ctx.fillStyle = canRace ? 'rgba(0, 255, 0, 0.2)' : 'rgba(100, 100, 100, 0.2)';
  ctx.fillRect(30, cy + 156, GW - 60, 28);
  ctx.strokeStyle = canRace ? '#0f0' : '#444';
  ctx.lineWidth = 2;
  ctx.strokeRect(30, cy + 156, GW - 60, 28);
  ctx.fillStyle = canRace ? '#0f0' : '#666';
  ctx.font = 'bold 14px monospace';
  ctx.fillText('🏁 START RACE', GW / 2, cy + 174);
  ctx.lineWidth = 1;
  if (canRace) stakeRects.startRace = { x: 30, y: cy + 156, w: GW - 60, h: 28 };

  // DIFFERENT OPPONENT button — re-rolls the opponent.
  ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
  ctx.fillRect(30, cy + 190, GW - 60, 20);
  ctx.strokeStyle = '#666';
  ctx.strokeRect(30, cy + 190, GW - 60, 20);
  ctx.fillStyle = '#888';
  ctx.font = '10px monospace';
  ctx.fillText('🔄 DIFFERENT OPPONENT', GW / 2, cy + 204);
  stakeRects.rerollOpp = { x: 30, y: cy + 190, w: GW - 60, h: 20 };

  (life as { _raceStakeRects?: typeof stakeRects })._raceStakeRects = stakeRects;
}

/** Inline month names — the home overlay has the same constant but
 *  doesn't export it. Cleaner to dedupe in a config follow-up. */
const CAL_MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

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
  GW: number,
  GH: number,
  cy: number,
): void {
  ctx.textAlign = 'center';

  const monthIdx = Math.floor((clock.day - 1) / DAYS_PER_MONTH);
  const monthName = CAL_MONTH_NAMES[monthIdx % 12];
  const dayOfMonth = ((clock.day - 1) % DAYS_PER_MONTH) + 1;
  const firstDayGlobal = clock.day - (dayOfMonth - 1);
  // Day 1 = Friday (monolith convention). dayNames index 0..6 maps to
  // FRI, SAT, SUN, MON, TUE, WED, THU. Map to a Sun-start grid col:
  // FRI=5, SAT=6, SUN=0, MON=1, TUE=2, WED=3, THU=4.
  const firstWeekIdx = ((firstDayGlobal - 1) % 7 + 7) % 7;
  const TO_GRID_COL = [5, 6, 0, 1, 2, 3, 4] as const;
  const firstCol = TO_GRID_COL[firstWeekIdx];

  // Header — month + year.
  const yearNum = 1999 + Math.floor(monthIdx / 12);
  ctx.fillStyle = '#0ff';
  ctx.font = 'bold 14px monospace';
  ctx.fillText('📅 ' + monthName.toUpperCase() + ' ' + yearNum, GW / 2, cy + 6);
  ctx.fillStyle = '#666';
  ctx.font = '9px monospace';
  ctx.fillText('Today: the ' + ordinalDay(dayOfMonth), GW / 2, cy + 18);

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
  // at ~GH-60 above it. Reserve ~80px below the grid.
  const gridYTop = cy + 36;
  const gridYBot = GH - 80;
  const cellH = Math.max(20, Math.floor((gridYBot - gridYTop) / 6));
  let col = firstCol;
  let row = 0;
  for (let d = 1; d <= DAYS_PER_MONTH; d++) {
    const cx2 = gridX + col * cellW;
    const cy2 = gridYTop + row * cellH;
    const isToday = d === dayOfMonth;
    const isBillDay = d === 1;
    if (isToday) ctx.fillStyle = 'rgba(0, 255, 255, 0.18)';
    else if (isBillDay) ctx.fillStyle = 'rgba(255, 80, 80, 0.10)';
    else ctx.fillStyle = 'rgba(255, 255, 255, 0.04)';
    ctx.fillRect(cx2 + 1, cy2, cellW - 2, cellH - 1);
    if (isToday) {
      ctx.strokeStyle = '#0ff';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(cx2 + 1, cy2, cellW - 2, cellH - 1);
    }
    ctx.fillStyle = isToday ? '#0ff' : col === 0 ? '#f88' : '#ccc';
    ctx.font = 'bold 9px monospace';
    ctx.fillText(String(d), cx2 + cellW / 2, cy2 + 11);
    if (isBillDay) {
      const bSize = 10;
      const bx = cx2 + cellW - bSize - 2;
      const by = cy2 + cellH - bSize - 2;
      ctx.fillStyle = '#640';
      ctx.fillRect(bx, by, bSize, bSize);
      ctx.fillStyle = '#fa0';
      ctx.font = 'bold 8px monospace';
      ctx.fillText('B', bx + bSize / 2, by + bSize - 2);
    }
    col++;
    if (col > 6) { col = 0; row++; }
  }

  // Legend — just above the CLOSE button.
  const legY = GH - 56;
  ctx.fillStyle = '#888';
  ctx.font = '8px monospace';
  ctx.fillText('B = bills due  •  cyan = today  •  red column = Sunday', GW / 2, legY);
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

/** H198: OPT tab. Mirrors monolith L34959+ but without the scroll-
 *  clip wrapper — content is sized to fit unscrolled at typical
 *  HUD heights. RESTART + QUIT buttons at top, then a DISPLAY
 *  section with X-Ray Body + CRT Scanlines toggles. More rows
 *  (audio volumes, debug flags) port in a follow-up if needed —
 *  scroll-clip lands when content grows past GH-40 (CLOSE button).
 *
 *  Cached hit rects on life._opt* so the click router doesn't
 *  duplicate layout math. */
/** OPT-tab scroll bookkeeping. Clip + translate range mirrors the
 *  monolith's L34964-34968 — content paints between y=48 (just below
 *  the tab strip) and GH-44 (just above the CLOSE button). */
const OPT_CLIP_TOP = 48;
const OPT_CLIP_BOT_MARGIN = 44;

function drawOptTab(
  ctx: CanvasRenderingContext2D,
  life: LifeState,
  GW: number,
  GH: number,
  cy: number,
): void {
  // H219: wrap the OPT body in a clip + translate so taller content
  // (audio rows, debug flags, controls list — all pending ports)
  // can scroll past the CLOSE button. Cached rect Ys are written
  // in CONTENT space; the click router shifts the tap Y by
  // life._menuTabScrollY before hit-test.
  const scrollY = (life as { _menuTabScrollY?: number })._menuTabScrollY ?? 0;
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
  (life as { _optRestartRect?: { x: number; y: number; w: number; h: number } })._optRestartRect = { x: rsX, y: gpY, w: gpW, h: gpH };

  const qtX = rsX + gpW + gpGap;
  ctx.fillStyle = 'rgba(200, 40, 40, 0.18)';
  ctx.fillRect(qtX, gpY, gpW, gpH);
  ctx.strokeStyle = '#f44';
  ctx.lineWidth = 1;
  ctx.strokeRect(qtX, gpY, gpW, gpH);
  ctx.fillStyle = '#f44';
  ctx.fillText('QUIT', qtX + gpW / 2, gpY + 12);
  (life as { _optQuitRect?: { x: number; y: number; w: number; h: number } })._optQuitRect = { x: qtX, y: gpY, w: gpW, h: gpH };

  // DISPLAY section header.
  ctx.fillStyle = '#ff0';
  ctx.font = 'bold 10px monospace';
  ctx.textAlign = 'left';
  ctx.fillText('DISPLAY', 14, cy + 50);
  ctx.textAlign = 'center';

  // X-Ray Body toggle (mirrors X-key keystroke at gameLoop L478).
  // 1:1 with monolith L35009-35039.
  const xrOn = life.gameplaySettings.xrayBody === true;
  const xrY = cy + 58;
  drawSettingToggleRow(ctx, GW, xrY, 36, 'X-Ray Body', 'Hide car body to inspect tire motion', xrOn);
  (life as { _optXrayRowY?: number })._optXrayRowY = xrY;

  // Scanlines toggle. 1:1 with monolith L35041-35060ish.
  const scOn = life.gameplaySettings.scanlines === true;
  const scY = cy + 98;
  drawSettingToggleRow(ctx, GW, scY, 24, 'CRT Scanlines', 'Retro overlay (heavier GPU load)', scOn);
  (life as { _optScanRowY?: number })._optScanRowY = scY;

  // Footer — more rows pending port.
  ctx.fillStyle = '#555';
  ctx.font = '9px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('More settings ports later — audio, debug, controls', GW / 2, cy + 138);

  // H219: close the clip + translate. Content height = bottom of
  // last paint (cy + 138 + ~12px font-height ≈ cy + 150). The
  // scrollMax cap clamps wheel/drag adjustments.
  ctx.restore();
  const contentHeight = cy + 150;
  const scrollMaxRaw = Math.max(0, contentHeight - (clipBot - clipTop) - clipTop);
  (life as { _menuTabScrollMax?: number })._menuTabScrollMax = scrollMaxRaw;

  // Scrollbar — only draws when content overflows. 1:1 with monolith
  // L34931-34935 (sized as a fraction of viewport / content).
  if (scrollMaxRaw > 0) {
    const viewport = clipBot - clipTop;
    const pct = scrollY / scrollMaxRaw;
    const barH = Math.max(20, viewport * (viewport / contentHeight));
    const barY = clipTop + pct * (viewport - barH);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.2)';
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

/** Tab-strip rect for tap dispatch. */
function tabRect(GW: number, i: number): { x: number; w: number } {
  const tabSpacing = Math.floor(GW / 5);
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

  // Top-right corner tap closes the menu (same target that opens it
  // from the playing-state HUD).
  if (isMenuOpenCornerHit(tx, ty, GW)) {
    deps.close();
    return true;
  }

  // Tab strip hit (y ∈ [28, 46]).
  if (ty >= 28 && ty <= 46) {
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

  // H198/H219: OPT tab buttons. RESTART / QUIT rects + X-Ray +
  // Scanlines toggle rows. Cached Y values are in CONTENT space —
  // the H219 scroll wrapper translates the paint by -scrollY, so
  // hit-test shifts the event Y to content space by ADDING scrollY.
  // Taps outside the clip range (y < clipTop or y > clipBot) are
  // ignored so the tab strip + CLOSE button stay reachable.
  if (state.tab === 'opt' && opts.life) {
    const life = opts.life as {
      _optRestartRect?: { x: number; y: number; w: number; h: number };
      _optQuitRect?: { x: number; y: number; w: number; h: number };
      _optXrayRowY?: number;
      _optScanRowY?: number;
      _menuTabScrollY?: number;
    };
    const clipBot = opts.GH - OPT_CLIP_BOT_MARGIN;
    if (ty >= OPT_CLIP_TOP && ty <= clipBot) {
      const tyContent = ty + (life._menuTabScrollY ?? 0);
      const insideRect = (r?: { x: number; y: number; w: number; h: number }): boolean =>
        !!r && tx >= r.x && tx <= r.x + r.w && tyContent >= r.y && tyContent <= r.y + r.h;
      if (insideRect(life._optRestartRect)) { deps.optRestart(); return true; }
      if (insideRect(life._optQuitRect)) { deps.optQuit(); return true; }
      if (typeof life._optXrayRowY === 'number'
          && tyContent >= life._optXrayRowY
          && tyContent <= life._optXrayRowY + 36
          && tx >= 12 && tx <= GW - 12) {
        deps.optToggleXray();
        return true;
      }
      if (typeof life._optScanRowY === 'number'
          && tyContent >= life._optScanRowY
          && tyContent <= life._optScanRowY + 24
          && tx >= 12 && tx <= GW - 12) {
        deps.optToggleScanlines();
        return true;
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

  // CLOSE button (centered, GH-40 to GH-16).
  const cbx = GW / 2 - 50;
  const cby = GH - 40;
  if (tx >= cbx && tx <= cbx + 100 && ty >= cby && ty <= cby + 24) {
    deps.close();
    return true;
  }

  // Full-screen modal eats every tap.
  return true;
}
