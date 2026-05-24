/**
 * Gas station menu modal — tabbed FUEL / PAINT / MECH overlay shown
 * when life.fuelMenuOpen is true. The proximity check in
 * src/physics/gasPumpProximity.ts already opens the menu when the
 * player parks at a pump; this module fills the previously-blank
 * screen.
 *
 * Tab strip (33% each):
 *   FUEL — per-grade fuel buttons + BUY JERRY CAN
 *   PAINT — current color + paint condition (multi-color picker
 *           deferred since CatalogCar doesn't carry variant manifest)
 *   MECH — 8 service rows, tap to buy
 *
 * Modal eats every tap. LEAVE STATION at the bottom closes it.
 *
 * 1:1 port of monolith L35792-L35963.
 */

import type { LifeState } from '@/state/life';
import type { CatalogCar } from '@/config/cars/catalog';
import { CAR_CATALOG } from '@/config/cars/catalog';
import { FUEL_GRADES, type FuelGrade } from '@/config/world/fuelGrades';
import {
  MECHANIC_SERVICES,
  buyJerryCan,
  buyMechanicService,
  getFuelDoor,
  getMpg,
  getTankGal,
  isCarDiesel,
  refuel,
  JERRY_CAN_PRICE,
} from '@/sim/gasStation';
import { getCarCostMult } from '@/sim/partsShop';
import { showNotif } from '@/ui/notif';

export type StationTab = 'fuel' | 'paint' | 'mechanic';

interface GasMenuHits {
  tabs: Array<{ x: number; y: number; w: number; h: number; key: StationTab }>;
  fuelGrades: Array<{ x: number; y: number; w: number; h: number; grade: FuelGrade; canBuy: boolean }>;
  jerry: { x: number; y: number; w: number; h: number; canBuy: boolean } | null;
  mechServices: Array<{ x: number; y: number; w: number; h: number; idx: number; canBuy: boolean }>;
  leave: { x: number; y: number; w: number; h: number };
}

/** Format a dollar amount the way the monolith's `$$` helper does
 *  (matches monolith dollar formatting at L35804). */
function fmtMoney(n: number): string {
  if (n < 1) return '$' + n.toFixed(2);
  return '$' + Math.round(n).toLocaleString();
}

/** Render the modal. No-op when fuelMenuOpen is false. */
export function drawGasStationMenu(
  ctx: CanvasRenderingContext2D,
  life: LifeState,
  GW: number,
  GH: number,
): void {
  if (!life.fuelMenuOpen) return;
  const stationTab: StationTab = (life.stationTab as StationTab | undefined) ?? 'fuel';
  const activeId = life.ownedCars[0];
  const car: CatalogCar | undefined = activeId ? CAR_CATALOG[activeId] : undefined;

  // Full-canvas darken.
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, GW, GH);
  ctx.textAlign = 'center';

  // Header.
  ctx.fillStyle = '#0f0';
  ctx.font = 'bold 14px monospace';
  ctx.fillText('⛽ GAS STATION', GW / 2, 18);
  ctx.fillStyle = '#888';
  ctx.font = '9px monospace';
  const nm = car ? car.name : '— no car —';
  ctx.fillText(nm + '  Cash: ' + fmtMoney(life.money), GW / 2, 30);

  // Tab strip — 3 equal-width tabs.
  const tabLabels: ReadonlyArray<{ key: StationTab; label: string }> = [
    { key: 'fuel',     label: '⛽FUEL' },
    { key: 'paint',    label: '🎨PAINT' },
    { key: 'mechanic', label: '🔧MECH' },
  ];
  const tabW = Math.floor(GW / tabLabels.length);
  const tabHits: GasMenuHits['tabs'] = [];
  for (let i = 0; i < tabLabels.length; i++) {
    const t = tabLabels[i];
    const tx = i * tabW;
    const active = stationTab === t.key;
    ctx.fillStyle = active ? 'rgba(255,255,255,0.15)' : 'rgba(255,255,255,0.04)';
    ctx.fillRect(tx, 36, tabW - 1, 18);
    ctx.strokeStyle = active ? '#0ff' : '#444';
    ctx.lineWidth = 1;
    ctx.strokeRect(tx, 36, tabW - 1, 18);
    ctx.fillStyle = active ? '#0ff' : '#666';
    ctx.font = 'bold 9px monospace';
    ctx.fillText(t.label, tx + tabW / 2, 49);
    tabHits.push({ x: tx, y: 36, w: tabW - 1, h: 18, key: t.key });
  }

  const contentY = 60;
  const fuelHits: GasMenuHits['fuelGrades'] = [];
  let jerryHit: GasMenuHits['jerry'] = null;
  const mechHits: GasMenuHits['mechServices'] = [];

  if (stationTab === 'fuel') {
    const tank = getTankGal(car);
    const gallonsNeeded = tank * (1 - life.fuel / 100);
    const fd = getFuelDoor(car);
    const fdLabel = fd === 'C' ? 'CTR' : fd === 'L' ? 'LEFT' : 'RIGHT';
    const diesel = isCarDiesel(car);
    ctx.fillStyle = '#aaa';
    ctx.font = '9px monospace';
    ctx.fillText(
      tank + 'gal  ' + Math.round(getMpg(car)) + 'mpg  Door:' + fdLabel
      + '  ' + Math.round(life.fuel) + '% full',
      GW / 2, contentY + 8,
    );
    ctx.fillText(
      'Need ' + gallonsNeeded.toFixed(1) + ' gal' + (diesel ? ' [DIESEL ONLY]' : ''),
      GW / 2, contentY + 20,
    );
    // Filter grades to diesel-vs-gas based on car.
    const grades = FUEL_GRADES.filter((fg) => diesel ? fg.diesel : !fg.diesel);
    for (let i = 0; i < grades.length; i++) {
      const fg = grades[i];
      const by = contentY + 28 + i * 52;
      const isFreePerk = life.playerJob === 'FUEL TANKER';
      const totalCost = isFreePerk ? 0 : Math.round(gallonsNeeded * fg.price * 100) / 100;
      const canBuy = (life.money >= totalCost || totalCost === 0) && gallonsNeeded > 0.1;
      ctx.fillStyle = 'rgba(255,255,255,0.1)';
      ctx.fillRect(15, by, GW - 30, 46);
      ctx.strokeStyle = canBuy ? fg.color : '#333';
      ctx.lineWidth = 2;
      ctx.strokeRect(15, by, GW - 30, 46);
      ctx.fillStyle = fg.color;
      ctx.font = 'bold 18px monospace';
      ctx.fillText(fg.diesel ? 'DIESEL' : String(fg.octane), GW / 2, by + 18);
      ctx.fillStyle = '#aaa';
      ctx.font = 'bold 9px monospace';
      ctx.fillText(fg.name + ' — $' + fg.price.toFixed(2) + '/gal', GW / 2, by + 30);
      ctx.fillStyle = canBuy ? '#0f0' : '#666';
      ctx.font = 'bold 11px monospace';
      ctx.fillText(
        canBuy ? (totalCost === 0 ? 'FILL UP  FREE' : 'FILL UP  ' + fmtMoney(totalCost)) : 'NOT ENOUGH $',
        GW / 2, by + 42,
      );
      fuelHits.push({ x: 15, y: by, w: GW - 30, h: 46, grade: fg, canBuy });
    }
    // BUY JERRY CAN row.
    const jerryY = contentY + 28 + grades.length * 52 + 6;
    const canBuyJerry = life.money >= JERRY_CAN_PRICE;
    ctx.fillStyle = 'rgba(255,200,0,0.08)';
    ctx.fillRect(15, jerryY, GW - 30, 32);
    ctx.strokeStyle = canBuyJerry ? '#fa0' : '#444';
    ctx.lineWidth = 1;
    ctx.strokeRect(15, jerryY, GW - 30, 32);
    ctx.fillStyle = canBuyJerry ? '#fa0' : '#666';
    ctx.font = 'bold 10px monospace';
    ctx.fillText('🛢 BUY JERRY CAN — $' + JERRY_CAN_PRICE, GW / 2, jerryY + 12);
    ctx.fillStyle = '#888';
    ctx.font = '8px monospace';
    ctx.fillText(
      '+15% emergency fuel • You have: ' + (life.jerryCans ?? 0),
      GW / 2, jerryY + 24,
    );
    jerryHit = { x: 15, y: jerryY, w: GW - 30, h: 32, canBuy: canBuyJerry };
  } else if (stationTab === 'paint') {
    // Simplified paint tab. Modular CatalogCar doesn't carry a
    // multi-color variant manifest yet, so we surface the current
    // color + condition + point to MECH for touch-up. Once
    // VEHICLE_IMAGE_MANIFEST ports a variant set, a swatch grid
    // lands here.
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 10px monospace';
    ctx.fillText(nm, GW / 2, contentY + 8);
    if (car) {
      ctx.fillStyle = car.color;
      ctx.fillRect(GW / 2 - 30, contentY + 14, 60, 8);
      ctx.strokeStyle = '#666';
      ctx.lineWidth = 1;
      ctx.strokeRect(GW / 2 - 30, contentY + 14, 60, 8);
      ctx.fillStyle = '#aaa';
      ctx.font = '8px monospace';
      ctx.fillText('FACTORY COLOR — ' + car.color.toUpperCase(), GW / 2, contentY + 30);
    }
    ctx.fillStyle = '#888';
    ctx.font = '9px monospace';
    ctx.fillText('Paint condition: ' + Math.round(life.paint) + '%', GW / 2, contentY + 46);
    ctx.fillStyle = '#888';
    ctx.font = '8px monospace';
    ctx.fillText('Single factory color for this model.', GW / 2, contentY + 70);
    ctx.fillText('Custom respray not available (catalog ports later).', GW / 2, contentY + 82);
    ctx.fillStyle = '#0a8';
    ctx.fillText('Need touch-up? Visit the Mechanic tab.', GW / 2, contentY + 102);
  } else if (stationTab === 'mechanic') {
    const ccm = getCarCostMult(car);
    ctx.fillStyle = '#aaa';
    ctx.font = '9px monospace';
    ctx.fillText(
      'ENG:' + Math.round(life.engine) + '% TIRE:' + Math.round(life.tires)
      + '% BODY:' + Math.round(life.carHP) + '% PNT:' + Math.round(life.paint) + '%',
      GW / 2, contentY + 8,
    );
    for (let i = 0; i < MECHANIC_SERVICES.length; i++) {
      const s = MECHANIC_SERVICES[i];
      const by = contentY + 16 + i * 30;
      const base = Math.round(s.price * ccm);
      const adjPrice = life.mechanicDiscount ? Math.round(base * 0.9) : base;
      const canBuy = life.money >= adjPrice;
      ctx.fillStyle = 'rgba(255,255,255,0.08)';
      ctx.fillRect(10, by, GW - 20, 26);
      ctx.strokeStyle = canBuy ? '#0f0' : '#333';
      ctx.lineWidth = 1;
      ctx.strokeRect(10, by, GW - 20, 26);
      ctx.fillStyle = canBuy ? '#0f0' : '#666';
      ctx.font = 'bold 9px monospace';
      ctx.fillText(s.name + ' — $' + adjPrice.toLocaleString(), GW / 2, by + 11);
      ctx.fillStyle = '#888';
      ctx.font = '8px monospace';
      ctx.fillText(s.desc + (canBuy ? ' • TAP' : " • Need $"), GW / 2, by + 22);
      mechHits.push({ x: 10, y: by, w: GW - 20, h: 26, idx: i, canBuy });
    }
  }

  // LEAVE STATION button at the bottom.
  const leaveY = GH - 34;
  ctx.fillStyle = 'rgba(255,60,60,0.15)';
  ctx.fillRect(60, leaveY, GW - 120, 24);
  ctx.strokeStyle = '#f44';
  ctx.lineWidth = 1;
  ctx.strokeRect(60, leaveY, GW - 120, 24);
  ctx.fillStyle = '#f44';
  ctx.font = 'bold 12px monospace';
  ctx.fillText('LEAVE STATION', GW / 2, leaveY + 16);
  ctx.textAlign = 'left';

  (life as { _gasMenuHits?: GasMenuHits })._gasMenuHits = {
    tabs: tabHits,
    fuelGrades: fuelHits,
    jerry: jerryHit,
    mechServices: mechHits,
    leave: { x: 60, y: leaveY, w: GW - 120, h: 24 },
  };
}

/** Routes a tap through the cached hits. Modal swallows every tap so
 *  the player can't fall through to anything beneath. */
export function handleGasStationTap(
  tx: number,
  ty: number,
  life: LifeState,
): boolean {
  if (!life.fuelMenuOpen) return false;
  const hits = (life as { _gasMenuHits?: GasMenuHits })._gasMenuHits;
  if (!hits) return true;
  const inside = (r: { x: number; y: number; w: number; h: number }): boolean =>
    tx >= r.x && tx <= r.x + r.w && ty >= r.y && ty <= r.y + r.h;

  // LEAVE STATION.
  if (inside(hits.leave)) {
    life.fuelMenuOpen = false;
    life.stationTab = 'fuel';
    return true;
  }
  // Tab switch.
  for (const t of hits.tabs) {
    if (inside(t)) {
      life.stationTab = t.key;
      return true;
    }
  }

  const activeId = life.ownedCars[0];
  const car = activeId ? CAR_CATALOG[activeId] : undefined;

  // FUEL tab — grade buttons + jerry can.
  for (const fh of hits.fuelGrades) {
    if (inside(fh)) {
      if (!fh.canBuy) {
        showNotif(life, "✗ Can't afford this grade", 120);
        return true;
      }
      const result = refuel(life, car, fh.grade);
      if (result.gallons === 0) {
        showNotif(life, '✗ Tank already full', 120);
      } else {
        showNotif(
          life,
          '⛽ Filled ' + result.gallons.toFixed(1) + ' gal'
          + (result.spent === 0 ? ' (FREE — FUEL TANKER perk)' : ' (-' + (result.spent < 1 ? '$' + result.spent.toFixed(2) : '$' + Math.round(result.spent).toLocaleString()) + ')'),
          180,
        );
      }
      return true;
    }
  }
  if (hits.jerry && inside(hits.jerry)) {
    if (!hits.jerry.canBuy) {
      showNotif(life, "✗ Can't afford a jerry can", 120);
      return true;
    }
    buyJerryCan(life);
    showNotif(life, '🛢 Jerry can purchased (-$' + JERRY_CAN_PRICE + ')', 180);
    return true;
  }
  // MECH tab — service rows.
  for (const mh of hits.mechServices) {
    if (inside(mh)) {
      if (!mh.canBuy) {
        showNotif(life, "✗ Can't afford this service", 120);
        return true;
      }
      const spent = buyMechanicService(life, car, mh.idx);
      if (spent > 0) {
        showNotif(life, '🔧 ' + MECHANIC_SERVICES[mh.idx].name + ' done (-$' + spent.toLocaleString() + ')', 180);
      }
      return true;
    }
  }
  return true; // swallow stray taps
}
