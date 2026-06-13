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
import { GT2_COLORS, drawGt2Backdrop } from '@/ui/gt2Chrome';
import { FUEL_GRADES, type FuelGrade } from '@/config/world/fuelGrades';
import {
  MECHANIC_SERVICES,
  buyJerryCan,
  buyMechanicService,
  buyFactoryColor,
  FACTORY_PAINT_FEE,
  getFactoryColorOptions,
  getFuelDoor,
  getMpg,
  getTankGal,
  isCarDiesel,
  refuel,
  type FactoryColorOption,
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
  factoryColors: Array<{ x: number; y: number; w: number; h: number; hex: string; label: string; isCurrent: boolean; canBuy: boolean }>;
  leave: { x: number; y: number; w: number; h: number };
}

/** Format a dollar amount the way the monolith's `$$` helper does
 *  (matches monolith dollar formatting at L35804). */
function fmtMoney(n: number): string {
  if (n < 1) return '$' + n.toFixed(2);
  return '$' + Math.round(n).toLocaleString();
}

/** H810: small labeled condition bar for the mechanic tab. Amber fill,
 *  signal-orange below 35% (matches the eat-tab GT2 stat bar). Label
 *  above, percent inside. */
function drawCondBar(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, label: string, pct: number,
): void {
  const C = GT2_COLORS;
  const v = Math.max(0, Math.min(100, pct || 0));
  ctx.textAlign = 'left';
  ctx.fillStyle = C.textMute;
  ctx.font = '7px monospace';
  ctx.fillText(label, x, y);
  const barY = y + 4;
  const h = 11;
  ctx.fillStyle = C.bgDeep;
  ctx.fillRect(x, barY, w, h);
  ctx.fillStyle = v < 35 ? C.active : C.amber;
  ctx.fillRect(x, barY, Math.round((w * v) / 100), h);
  ctx.strokeStyle = C.amberDark;
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, barY + 0.5, w - 1, h - 1);
  ctx.fillStyle = v < 50 ? C.text : C.bgDeep;
  ctx.font = 'bold 7px monospace';
  ctx.textAlign = 'center';
  ctx.fillText(Math.round(v) + '%', x + w / 2, barY + 8);
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

  // H780: GT2 charcoal + grid backdrop replaces the prior black fill.
  ctx.fillStyle = GT2_COLORS.bg;
  ctx.fillRect(0, 0, GW, GH);
  drawGt2Backdrop(ctx, GW, GH);
  ctx.textAlign = 'center';

  // Header. H810: GT2 amber title + breadcrumb (was neon green).
  const C = GT2_COLORS;
  ctx.fillStyle = C.amber;
  ctx.font = 'bold 14px monospace';
  ctx.fillText('GAS STATION', GW / 2, 18);
  ctx.fillStyle = C.textMute;
  ctx.font = '9px monospace';
  const nm = car ? car.name : '— no car —';
  ctx.fillText(nm + '   ' + fmtMoney(life.money), GW / 2, 30);

  // Tab strip — 3 equal-width tabs. H810: GT2 amber; active tab is
  // dark-on-amber (GT2 selected style), inactive is amber-outline.
  const tabLabels: ReadonlyArray<{ key: StationTab; label: string }> = [
    { key: 'fuel',     label: 'FUEL' },
    { key: 'paint',    label: 'PAINT' },
    { key: 'mechanic', label: 'MECHANIC' },
  ];
  const tabW = Math.floor(GW / tabLabels.length);
  const tabHits: GasMenuHits['tabs'] = [];
  for (let i = 0; i < tabLabels.length; i++) {
    const t = tabLabels[i];
    const tx = i * tabW;
    const active = stationTab === t.key;
    ctx.fillStyle = active ? C.amber : C.panel;
    ctx.fillRect(tx, 36, tabW - 1, 18);
    ctx.strokeStyle = active ? C.amber : C.amberDark;
    ctx.lineWidth = 1;
    ctx.strokeRect(tx + 0.5, 36.5, tabW - 2, 17);
    ctx.fillStyle = active ? C.bgDeep : C.amber;
    ctx.font = 'bold 9px monospace';
    ctx.fillText(t.label, tx + tabW / 2, 49);
    tabHits.push({ x: tx, y: 36, w: tabW - 1, h: 18, key: t.key });
  }

  const contentY = 60;
  const fuelHits: GasMenuHits['fuelGrades'] = [];
  let jerryHit: GasMenuHits['jerry'] = null;
  const mechHits: GasMenuHits['mechServices'] = [];
  const factoryHits: GasMenuHits['factoryColors'] = [];

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
    // H592: factory respray tab. Renders the per-car factory
    // color swatches (from VEHICLE_IMAGE_MANIFEST anchors). Cars
    // with single-sprite manifests fall through to a "single
    // factory color" message so the player knows respray isn't
    // available for this model. Flat $100 labor fee mirrors the
    // monolith FACTORY_PAINT_FEE.
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
      ctx.fillText('CURRENT — ' + car.color.toUpperCase(), GW / 2, contentY + 30);
    }
    ctx.fillStyle = '#888';
    ctx.font = '9px monospace';
    ctx.fillText('Paint condition: ' + Math.round(life.paint) + '%', GW / 2, contentY + 46);

    const factoryOpts: FactoryColorOption[] | null = getFactoryColorOptions(car?.name);
    if (factoryOpts && factoryOpts.length > 0) {
      ctx.fillStyle = '#0ff';
      ctx.font = 'bold 9px monospace';
      ctx.fillText(
        'FACTORY RESPRAY — $' + FACTORY_PAINT_FEE + ' flat',
        GW / 2, contentY + 64,
      );
      const swY = contentY + 76;
      const swH = 36;
      const gap = 8;
      const totalW = factoryOpts.length * 64 + (factoryOpts.length - 1) * gap;
      let swX = Math.round(GW / 2 - totalW / 2);
      for (const o of factoryOpts) {
        const isCurrent = (car?.color ?? '').toLowerCase() === o.hex.toLowerCase();
        const canBuy = !isCurrent && life.money >= FACTORY_PAINT_FEE;
        ctx.fillStyle = o.hex;
        ctx.fillRect(swX, swY, 64, swH);
        ctx.strokeStyle = isCurrent ? '#0ff' : canBuy ? '#fff' : '#444';
        ctx.lineWidth = isCurrent ? 2 : 1;
        ctx.strokeRect(swX, swY, 64, swH);
        ctx.fillStyle = '#000';
        ctx.fillRect(swX, swY + swH - 11, 64, 11);
        ctx.fillStyle = isCurrent ? '#0ff' : canBuy ? '#fff' : '#888';
        ctx.font = 'bold 8px monospace';
        ctx.fillText(
          isCurrent ? '✓ ' + o.label.toUpperCase() : o.label.toUpperCase(),
          swX + 32, swY + swH - 2,
        );
        factoryHits.push({
          x: swX, y: swY, w: 64, h: swH,
          hex: o.hex, label: o.label, isCurrent, canBuy,
        });
        swX += 64 + gap;
      }
    } else {
      ctx.fillStyle = '#888';
      ctx.font = '8px monospace';
      ctx.fillText('Single factory color for this model.', GW / 2, contentY + 70);
      ctx.fillStyle = '#0a8';
      ctx.fillText('Need touch-up? Visit the Mechanic tab.', GW / 2, contentY + 84);
    }
  } else if (stationTab === 'mechanic') {
    // H810: GT2 condition panel + two-column service grid. Was a
    // single neon-green list with a plain "ENG:100% TIRE:..." text
    // line; now the four systems show as labeled bars (signal-orange
    // when worn) and services tile 2-wide so all 8 fit without
    // overflowing the 427px canvas.
    const ccm = getCarCostMult(car);
    // +18 clears the tach/speedo gauges the game HUD paints over the
    // modal's top corners (where the ENGINE/PAINT bar labels sit).
    const condY = contentY + 18;
    const condW = (GW - 30) / 4 - 6;
    const conds: ReadonlyArray<{ label: string; v: number }> = [
      { label: 'ENGINE', v: life.engine },
      { label: 'TIRES',  v: life.tires },
      { label: 'BODY',   v: life.carHP },
      { label: 'PAINT',  v: life.paint },
    ];
    for (let i = 0; i < conds.length; i++) {
      drawCondBar(ctx, 15 + i * (condW + 8), condY, condW, conds[i].label, conds[i].v);
    }
    if (life.mechanicDiscount) {
      ctx.fillStyle = C.active;
      ctx.font = '8px monospace';
      ctx.textAlign = 'right';
      ctx.fillText('MECHANIC PERK −10%', GW - 15, condY + 34);
      ctx.textAlign = 'center';
    }

    const gridTop = condY + 40;
    const colW = (GW - 30 - 10) / 2;
    const rowH = 30;
    for (let i = 0; i < MECHANIC_SERVICES.length; i++) {
      const s = MECHANIC_SERVICES[i];
      const col = i % 2;
      const r = Math.floor(i / 2);
      const x = 15 + col * (colW + 10);
      const by = gridTop + r * (rowH + 5);
      const base = Math.round(s.price * ccm);
      const adjPrice = life.mechanicDiscount ? Math.round(base * 0.9) : base;
      const canBuy = life.money >= adjPrice;
      ctx.fillStyle = canBuy ? C.panel : C.bgDeep;
      ctx.fillRect(x, by, colW, rowH);
      ctx.strokeStyle = canBuy ? C.amberDark : C.textDim;
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, by + 0.5, colW - 1, rowH - 1);
      ctx.textAlign = 'left';
      ctx.fillStyle = canBuy ? C.text : C.textDim;
      ctx.font = 'bold 9px monospace';
      ctx.fillText(s.name, x + 6, by + 12);
      ctx.fillStyle = canBuy ? C.textMute : C.textDim;
      ctx.font = '7px monospace';
      ctx.fillText(s.desc, x + 6, by + 23);
      ctx.textAlign = 'right';
      ctx.fillStyle = canBuy ? C.amber : C.textDim;
      ctx.font = 'bold 9px monospace';
      ctx.fillText('$' + adjPrice.toLocaleString(), x + colW - 6, by + 18);
      ctx.textAlign = 'center';
      mechHits.push({ x, y: by, w: colW, h: rowH, idx: i, canBuy });
    }
  }

  // LEAVE STATION button at the bottom. H810: GT2 amber pill (was a
  // red-outline terminal button; red is reserved for true warnings).
  const leaveY = GH - 34;
  ctx.fillStyle = C.amber;
  ctx.fillRect(60, leaveY, GW - 120, 24);
  ctx.fillStyle = C.bgDeep;
  ctx.font = 'bold 12px monospace';
  ctx.fillText('← LEAVE STATION', GW / 2, leaveY + 16);
  ctx.textAlign = 'left';

  (life as { _gasMenuHits?: GasMenuHits })._gasMenuHits = {
    tabs: tabHits,
    fuelGrades: fuelHits,
    jerry: jerryHit,
    mechServices: mechHits,
    factoryColors: factoryHits,
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
  // H592: PAINT tab — factory swatches.
  for (const fc of hits.factoryColors) {
    if (inside(fc)) {
      if (fc.isCurrent) {
        showNotif(life, '✓ Already ' + fc.label + ' factory paint', 120);
        return true;
      }
      const result = buyFactoryColor(life, car, fc.hex);
      if (result === 'ok') {
        showNotif(
          life,
          '🎨 ' + (car?.name ?? 'Car') + ' resprayed ' + fc.label
          + ' factory (-$' + FACTORY_PAINT_FEE + ')',
          180,
        );
      } else if (result === 'broke') {
        showNotif(life, "✗ Need $" + FACTORY_PAINT_FEE + " for factory respray", 120);
      }
      return true;
    }
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
