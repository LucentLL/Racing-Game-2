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
import { getEffectiveRHD } from '@/state/effectiveRhd';
import type { Clock } from '@/state/clock';

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
 *  1:1 port of monolith L34576-34628 minus the drawCharacterBase
 *  call — portrait renders as a stub colored rect with the gender
 *  letter for now (drawCharacterBase isn't ported yet). */
function drawStatusTab(
  ctx: CanvasRenderingContext2D,
  life: LifeState,
  GW: number,
  _GH: number,
  cy: number,
): void {
  // ---- PLAYER BLOCK ----
  // Portrait STUB. The monolith calls
  //   drawCharacterBase(ctx, LIFE.gender, LIFE.fitness, LIFE.skinTone, 8, cy+2, 32);
  // which paints a top-down body sprite scaled to fitness. Not
  // ported yet — H<followup> picks this up. For now a 32×32 cyan-
  // bordered placeholder with the gender initial keeps the layout
  // stable.
  const _stPortS = 32;
  ctx.fillStyle = '#234';
  ctx.fillRect(8, cy + 2, _stPortS, _stPortS);
  ctx.strokeStyle = '#0ff';
  ctx.lineWidth = 1;
  ctx.strokeRect(8, cy + 2, _stPortS, _stPortS);
  ctx.fillStyle = '#aaa';
  ctx.font = 'bold 18px monospace';
  ctx.textAlign = 'center';
  ctx.fillText(life.gender, 8 + _stPortS / 2, cy + 2 + 22);

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

  // Sprite preview band. Monolith calls drawTopCar at L34659 to
  // paint the actual top-down car sprite scaled into a fixed-height
  // band; the modular drawTopCar takes a rich deps bundle (player
  // state, hour, sprite-cache lookups) that doesn't fit a static
  // menu helper. Until that gets factored, the band paints a flat
  // car-color rectangle sized like the chassis footprint so the
  // layout below stays anchored. Sprite-wiring follow-up.
  const spZoneY = vY + 18;
  const spZoneH = 57;
  const sp: readonly [number, number] = car.size ?? [20, 8];
  const spMaxW = GW - 40;
  const spMaxH = spZoneH - 6;
  const spScale = Math.min(spMaxW / sp[0], spMaxH / sp[1]);
  const rectW = sp[0] * spScale;
  const rectH = sp[1] * spScale;
  ctx.fillStyle = car.color;
  ctx.fillRect(GW / 2 - rectW / 2, spZoneY + spZoneH / 2 - rectH / 2, rectW, rectH);
  ctx.strokeStyle = '#222';
  ctx.lineWidth = 1;
  ctx.strokeRect(GW / 2 - rectW / 2, spZoneY + spZoneH / 2 - rectH / 2, rectW, rectH);

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
      listings.forEach((j, i) => {
        const jy = cy + 76 + i * 36;
        ctx.fillStyle = 'rgba(255, 140, 0, 0.12)';
        ctx.fillRect(15, jy, GW - 30, 30);
        ctx.strokeStyle = '#f80';
        ctx.strokeRect(15, jy, GW - 30, 30);
        ctx.fillStyle = '#f80';
        ctx.font = 'bold 11px monospace';
        ctx.fillText(j.name, GW / 2, jy + 13);
        ctx.fillStyle = '#888';
        ctx.font = '10px monospace';
        const sep = j.perk ? ' • ' : ' ';
        ctx.fillText(j.pay + sep + (j.perk ?? '') + (j.perk ? ' • ' : '') + 'TAP TO APPLY', GW / 2, jy + 25);
      });
    }
    return;
  }

  // Has-job-not-yet-worked branch. Monolith L34771-34791 iterates
  // a daily-rolled `availJobs` list + SKIP WORK button. The daily-
  // job roller isn't ported yet — placeholder + visible SKIP WORK
  // button so the UI stays operable. Real job options land when
  // the daily generator ports.
  ctx.fillStyle = '#888';
  ctx.font = '10px monospace';
  ctx.fillText('Today\'s assignments — daily roller pending port', GW / 2, cy + 60);
  const skipY = cy + 80;
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
        deps.setTab(MENU_TAB_ORDER[i]);
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

  // H195: JOBS tab buttons — QUIT JOB (when life.job) or SKIP WORK
  // (when has-job + not-yet-worked). Both Y positions cached on
  // life by drawJobsTab. Button widths 25..GW-25 with heights 20/26.
  if (state.tab === 'jobs' && opts.life) {
    const qY = (opts.life as { _jobsQuitY?: number })._jobsQuitY;
    if (typeof qY === 'number' && opts.life.job && ty >= qY && ty <= qY + 20 && tx >= 25 && tx <= GW - 25) {
      deps.quitJob();
      return true;
    }
    const skY = (opts.life as { _jobsSkipY?: number })._jobsSkipY;
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
