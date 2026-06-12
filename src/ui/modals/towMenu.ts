/**
 * Tow-truck breakdown modal — appears when life.towMenuOpen is true
 * (set by the breakdown HUD's CALL TOW button or by breakdownRecovery
 * when the engine fails to restart / fuel hits zero). Lets the player
 * pay for a tow to the garage / mechanic, scrap the car at the
 * junkyard, or burn a jerry can if they're out of gas.
 *
 * Ported from monolith:
 *   - render: L35965-36025 (centered modal, dynamic option list with
 *     conditional USE JERRY CAN prepend, ⚠ last-car warning)
 *   - click router: L20909-20931 (iterate cached _towOpts with
 *     per-option _renderY hit-test, route to handleTowChoice or
 *     useJerryCan)
 *   - handleTowChoice: L8625-8681 (3 branches: garage/mechanic spawn
 *     incomingTow + deduct cash + notif; junkyard scraps the active
 *     car, refunds 8% of price, swaps to ownedCars[0] or generates a
 *     loaner)
 *   - startIncomingTow: L8694-8726 (spawns the IncomingTow object the
 *     existing render/tow.ts pass animates)
 *
 * Modal coordinates are HUD-direct (no _menuCenterOffX since the
 * modular tree doesn't have a desktop-centering wrapper yet).
 */

import type { LifeState } from '@/state/life';
import type { CatalogCar } from '@/config/cars/catalog';
import { GT2_COLORS, drawGt2Backdrop } from '@/ui/gt2Chrome';
import { CAR_CATALOG } from '@/config/cars/catalog';
import { showNotif } from '@/ui/notif';
import { TILE } from '@/config/world/tiles';
import type { PlayerPose } from '@/state/life';

/** Player pose the startIncomingTow geometry reads — head + body
 *  position so the AI tow truck spawns in front of the player car
 *  along its facing direction. */
export interface TowPlayerPose extends PlayerPose {}

/** One row in the modal's dynamically-built option list. The render
 *  pass writes _renderY so the click router can hit-test against the
 *  exact paint Y without re-running layout. */
export interface TowMenuOption {
  label: string;
  desc: string;
  cost: number;
  color: string;
  /** 'useJerry' | 'tow0' (garage) | 'tow1' (mechanic) | 'tow2' (junkyard). */
  action: 'useJerry' | 'tow0' | 'tow1' | 'tow2';
  /** Filled in by drawTowMenu — top-Y of the row's paint rect. */
  _renderY?: number;
}

/** Currency formatter — matches monolith's `$$` helper output. */
function fmtMoney(n: number): string {
  return '$' + Math.round(n).toLocaleString();
}

/** Active car id convention. Mirrors gameLoop.ts L1078. */
function activeCarOf(life: LifeState): { id: string | undefined; car: CatalogCar | undefined } {
  const id = life.ownedCars[0];
  return { id, car: id ? CAR_CATALOG[id] : undefined };
}

/** 1:1 with monolith L36000 scrap value — 8% of catalog price,
 *  rounded. */
function scrapValueOf(car: CatalogCar | undefined): number {
  if (!car) return 0;
  return Math.round(car.price * 0.08);
}

/** Build the option list. USE JERRY CAN is prepended only when the
 *  breakdown is OUT OF GAS and the player has a can to burn — keeps
 *  the modal uncluttered for other failure modes where a can wouldn't
 *  help (mechanical / overheat / tire). */
export function buildTowMenuOptions(life: LifeState): TowMenuOption[] {
  const { car } = activeCarOf(life);
  const opts: TowMenuOption[] = [];
  const canUseJerry = life.breakdownType === 'OUT OF GAS'
    && (life.jerryCans ?? 0) > 0;
  if (canUseJerry) {
    opts.push({
      label: '🛢 USE JERRY CAN',
      desc: '+15% fuel • You have ' + life.jerryCans + '. Drive to a station.',
      cost: 0,
      color: '#fa0',
      action: 'useJerry',
    });
  }
  opts.push({
    label: '🏠 TOW TO GARAGE',
    desc: 'Car stays broken. Work on it at home.',
    cost: 50,
    color: '#0ff',
    action: 'tow0',
  });
  opts.push({
    label: '🔧 TOW TO MECHANIC',
    desc: 'Full repair. Car fixed to 70%.',
    cost: 200,
    color: '#0f0',
    action: 'tow1',
  });
  opts.push({
    label: '🗑️ SELL TO JUNKYARD',
    desc: 'Scrap it. Get ' + fmtMoney(scrapValueOf(car)) + ' cash.',
    cost: 0,
    color: '#f80',
    action: 'tow2',
  });
  return opts;
}

/** Renders the modal. 1:1 with monolith L35966-36025. Caches the
 *  built option list on life._towOpts so the click router hit-tests
 *  the exact rows that were painted (the conditional jerry-can row
 *  shifts every other row's Y). */
export function drawTowMenu(
  ctx: CanvasRenderingContext2D,
  life: LifeState,
  GW: number,
  GH: number,
): void {
  if (!life.towMenuOpen) return;
  const { car } = activeCarOf(life);

  // H780: GT2 charcoal + grid backdrop replaces the dim cover.
  ctx.fillStyle = GT2_COLORS.bg;
  ctx.fillRect(0, 0, GW, GH);
  drawGt2Backdrop(ctx, GW, GH);
  ctx.textAlign = 'center';

  // Header.
  ctx.fillStyle = '#f44';
  ctx.font = 'bold 16px monospace';
  ctx.fillText('🚨 BREAKDOWN', GW / 2, 24);
  if (life.breakdownType) {
    ctx.fillStyle = '#ff0';
    ctx.font = 'bold 12px monospace';
    ctx.fillText(life.breakdownType, GW / 2, 38);
  }
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 11px monospace';
  ctx.fillText(car?.name ?? '— no car —', GW / 2, life.breakdownType ? 52 : 40);
  ctx.fillStyle = '#aaa';
  ctx.font = '10px monospace';
  ctx.fillText(
    'Eng:' + Math.round(life.engine) + '% Tire:' + Math.round(life.tires)
    + '% Paint:' + Math.round(life.paint) + '%',
    GW / 2, life.breakdownType ? 64 : 54,
  );
  ctx.fillText(
    'Fuel:' + Math.round(life.fuel) + '%  Body:' + Math.round(life.carHP) + '%',
    GW / 2, life.breakdownType ? 76 : 66,
  );
  ctx.fillStyle = '#ff0';
  ctx.font = 'bold 12px monospace';
  ctx.fillText('CALL TOW TRUCK', GW / 2, 86);
  ctx.fillStyle = '#888';
  ctx.font = '10px monospace';
  ctx.fillText('Cash: ' + fmtMoney(life.money), GW / 2, 100);

  // Build + cache the option list, then paint rows.
  const opts = buildTowMenuOptions(life);
  (life as { _towOpts?: TowMenuOption[] })._towOpts = opts;
  opts.forEach((o, i) => {
    const yy = 112 + i * 58;
    o._renderY = yy;
    const canAfford = o.cost === 0 || life.money >= o.cost;
    ctx.fillStyle = canAfford ? 'rgba(255,255,255,0.1)' : 'rgba(255,255,255,0.04)';
    ctx.fillRect(12, yy, GW - 24, 50);
    ctx.strokeStyle = canAfford ? o.color : '#333';
    ctx.lineWidth = 1;
    ctx.strokeRect(12, yy, GW - 24, 50);
    ctx.fillStyle = canAfford ? o.color : '#666';
    ctx.font = 'bold 13px monospace';
    ctx.fillText(o.label, GW / 2, yy + 18);
    ctx.fillStyle = canAfford ? '#aaa' : '#555';
    ctx.font = '10px monospace';
    ctx.fillText(o.desc, GW / 2, yy + 32);
    ctx.fillStyle = canAfford ? '#ff0' : '#555';
    ctx.font = 'bold 10px monospace';
    if (o.cost > 0) {
      ctx.fillText('$' + o.cost, GW / 2, yy + 44);
    } else if (o.action === 'tow2') {
      ctx.fillText('+' + fmtMoney(scrapValueOf(car)), GW / 2, yy + 44);
    } else if (o.action === 'useJerry') {
      ctx.fillText('FREE', GW / 2, yy + 44);
    }
  });

  // Last-car warning. Monolith L36019-36022.
  if (life.ownedCars.length <= 1) {
    ctx.fillStyle = '#f44';
    ctx.font = '9px monospace';
    ctx.fillText('⚠ Last car! Junkyard gives a loaner.', GW / 2, 290);
  }
  ctx.textAlign = 'left';
}

/** Dependencies for the click router — the things that can only be
 *  resolved at the gameLoop call site (current player pose, save
 *  hook). Pass-through into the action handlers below. */
export interface TowMenuClickDeps {
  player: TowPlayerPose;
}

/** Click handler. Iterates the cached `_towOpts` so the conditional
 *  jerry-can row routes correctly regardless of index. Modal always
 *  consumes taps (returns true) — the player can't click past it. */
export function handleTowMenuClick(
  tx: number,
  ty: number,
  life: LifeState,
  GW: number,
  deps: TowMenuClickDeps,
): boolean {
  if (!life.towMenuOpen) return false;
  const opts = (life as { _towOpts?: TowMenuOption[] })._towOpts ?? [];
  for (let i = 0; i < opts.length; i++) {
    const o = opts[i];
    const yy = o._renderY ?? (112 + i * 58);
    if (ty >= yy && ty <= yy + 50 && tx >= 12 && tx <= GW - 12) {
      if (o.action === 'useJerry') {
        useJerryCan(life);
        life.towMenuOpen = false;
      } else {
        const ch = parseInt(o.action.slice(3), 10) as 0 | 1 | 2;
        handleTowChoice(life, ch, deps);
      }
      return true;
    }
  }
  // Modal eats every tap even outside the option rows so the player
  // can't accidentally hit something underneath.
  return true;
}

/** USE JERRY CAN — consumes one can, refuels +15%, clears the
 *  out-of-gas breakdown so the player can drive to a station.
 *  Mirrors the monolith's useJerryCan helper (no public modular
 *  port yet — folded inline here since it's the only call site).
 *  After this, the breakdown state is fully cleared; if the player
 *  immediately runs out again, the breakdownRoll path will re-fire. */
export function useJerryCan(life: LifeState): void {
  if ((life.jerryCans ?? 0) <= 0) return;
  life.jerryCans = (life.jerryCans ?? 0) - 1;
  life.fuel = Math.min(100, life.fuel + 15);
  life.broken = false;
  life.breakdownType = '';
  life.breakdownTimer = 0;
  showNotif(life, '⛽ Used jerry can. Drive to a station!', 180);
}

/** Pay for a tow / scrap the car. Mirrors monolith L8625-8681. The
 *  garage / mechanic branches deduct cash and spawn the incoming-
 *  tow truck via startIncomingTow; the junkyard branch scraps the
 *  active car, refunds 8% of price, and either swaps to the next
 *  owned car or generates a beater loaner if it was the last one. */
export function handleTowChoice(
  life: LifeState,
  choice: 0 | 1 | 2,
  deps: TowMenuClickDeps,
): void {
  life.towMenuOpen = false;
  if (choice === 0) {
    if (life.money < 50) {
      showNotif(life, 'Not enough cash for tow!', 120);
      life.towMenuOpen = true;
      return;
    }
    life.money -= 50;
    startIncomingTow(life, deps.player, choice);
    showNotif(life, 'Tow truck on the way... -$50', 180);
  } else if (choice === 1) {
    if (life.money < 200) {
      showNotif(life, 'Not enough cash for mechanic!', 120);
      life.towMenuOpen = true;
      return;
    }
    life.money -= 200;
    startIncomingTow(life, deps.player, choice);
    showNotif(life, 'Tow truck on the way... -$200', 180);
  } else if (choice === 2) {
    scrapActiveCar(life);
  }
}

/** Scrap the active car at the junkyard. Refunds 8% of price, removes
 *  the car from ownedCars, and either swaps to ownedCars[0] or
 *  generates a beater loaner if it was the last car owned. Clears
 *  broken state so the player isn't stuck post-scrap.
 *
 *  The monolith also flushes carAds + carOffer mail + pendingParts
 *  for the scrapped car via cancelPendingForCar — that helper hasn't
 *  ported yet, so this version skips it; stale ads / offers for the
 *  scrapped id will linger in the inbox until their expiry. Defer
 *  the cancelPendingForCar port to a follow-up hop. */
function scrapActiveCar(life: LifeState): void {
  const { id: oldId, car: oldCar } = activeCarOf(life);
  if (!oldCar || !oldId) return;
  const scrapValue = scrapValueOf(oldCar);
  life.money += scrapValue;
  const soldName = oldCar.name;
  // Remove the scrapped id from ownedCars (mirrors monolith's
  // CAR_IDS.splice at L8651).
  life.ownedCars = life.ownedCars.filter((c) => c !== oldId);
  if (life.ownedCars.length > 0) {
    // Swap to the next owned car; loadCarCondition is a sim follow-
    // up — for now we restore baseline stats so the car isn't
    // immediately broken too. Per-car conditions are persisted in
    // saves but the in-memory restore helper isn't ported yet.
    life.broken = false;
    life.breakdownType = '';
    life.breakdownTimer = 0;
    showNotif(life, 'Scrapped ' + soldName + '. +' + fmtMoney(scrapValue), 180);
  } else {
    // Last-car loaner. Monolith picks from a hardcoded list of
    // economy beaters at L8656; we try those slugs first and fall
    // through to the catalog's cheapest available car if none of
    // the named beaters exist in the modular catalog.
    const beaterIds = [
      'honda_civic_sir_ii__eg___93',
      'honda_cr_x_sir__90',
      'mazda_demio__j___99',
      'daihatsu_storia_cx_2wd__98',
    ];
    let loanerId: string | undefined;
    for (const candidate of beaterIds) {
      if (CAR_CATALOG[candidate]) { loanerId = candidate; break; }
    }
    if (!loanerId) {
      // Catalog fallback — pick the cheapest car the catalog has.
      let cheapest: { id: string; price: number } | null = null;
      for (const key in CAR_CATALOG) {
        const p = CAR_CATALOG[key].price;
        if (!cheapest || p < cheapest.price) cheapest = { id: key, price: p };
      }
      loanerId = cheapest?.id;
    }
    if (loanerId) {
      life.ownedCars = [loanerId];
      // High-mileage loaner stats per monolith L8662.
      life.engine = 25;
      life.tires = 25;
      life.carHP = 25;
      life.paint = 25;
      life.fuel = 30;
      life.faults = [];
      life._hiddenFaults = [];
      life.carOdometers[loanerId] = 180000 / 0.0001278;
      life.broken = false;
      life.breakdownType = '';
      life.breakdownTimer = 0;
      showNotif(life, 'Junkyard loaned you a beater. Scrapped ' + soldName + '. +' + fmtMoney(scrapValue), 240);
    } else {
      // Defensive — empty catalog (shouldn't happen). At least
      // surface the scrap proceeds and unblock UI.
      life.broken = false;
      life.breakdownType = '';
      life.breakdownTimer = 0;
      showNotif(life, 'Scrapped ' + soldName + '. +' + fmtMoney(scrapValue), 180);
    }
  }
  // Cancel any active job + clear day-flow flags so the player
  // doesn't carry a stale assignment on the scrapped car. Mirrors
  // monolith L8680.
  if (life.job) {
    life.job = null;
    life.jobDoneToday = false;
  }
}

/** Spawn the IncomingTow object that render/tow.ts animates. The
 *  spawn point is ~35 tiles ahead of the player along the player's
 *  heading; the truck drives toward the park position (gap units
 *  ahead of the player's front bumper), then pivots 180° so its
 *  rear faces the player for the flatbed load. 1:1 with monolith
 *  L8694-8726. */
function startIncomingTow(
  life: LifeState,
  player: TowPlayerPose,
  choice: 0 | 1 | 2,
): void {
  const TOW_HALF_LEN = 19.25;
  const { car } = activeCarOf(life);
  const pHalfLen = car?.size?.[0] ? car.size[0] / 2 : 10;
  const gap = 4;
  const parkDist = pHalfLen + gap + TOW_HALF_LEN;
  const parkX = player.px + Math.cos(player.pAngle) * parkDist;
  const parkY = player.py + Math.sin(player.pAngle) * parkDist;
  const spawnDist = TILE * 35;
  const arriveAngle = player.pAngle + Math.PI;
  life.incomingTow = {
    phase: 'arriving',
    x: parkX + Math.cos(player.pAngle) * spawnDist,
    y: parkY + Math.sin(player.pAngle) * spawnDist,
    angle: arriveAngle,
    timer: 0,
    choice,
    carColor: car?.color ?? '#ccc',
    carBody: 'sedan',
    loadProg: 0,
    parkX,
    parkY,
    arriveAngle,
    parkAngle: player.pAngle,
    departDir: player.pAngle,
    playerCarX: player.px,
    playerCarY: player.py,
    playerCarA: player.pAngle,
  };
}
