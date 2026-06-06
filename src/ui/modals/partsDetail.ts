/**
 * H732: GT2-style part detail + BUY.
 *
 * Reference: "Turbo Kits / Stage 1" detail screen from the
 * 2026-05-30 GT2 screenshot set — split layout: stages stacked on
 * the left, description + before-after delta + price + BUY on the
 * right.
 *
 * Opens when life.partsDetailOpen is set (driven by a row tap on
 * the H731 partsSubmenu). The modular PARTS_SHOP doesn't carry
 * stages (each entry is a single-shot upgrade), so the "stages
 * column" reduces to one selected Stage 1 chip — kept in the
 * layout so the screen reads as the same family as the GT2
 * reference and future hops can grow the catalog into staged
 * entries without a layout change.
 *
 * BUY commits applyPart synchronously and deducts the dealer
 * price (matches the H567 garage-parts-view current behavior —
 * mechanic/dealer/queue routing lands separately). Closes the
 * detail + sub-menu + lineup back to the GARAGE list on success.
 */

import type { LifeState } from '@/state/life';
import { CAR_CATALOG } from '@/config/cars/catalog';
import {
  PARTS_SHOP, applyPart, getCarCostMult, type ShopPart,
} from '@/sim/partsShop';
import { showNotif } from '@/ui/notif';
import {
  drawGt2TopBar, drawGt2BottomBar, drawGt2Backdrop,
  gt2TopBarHitTest, gt2BottomBarHitTest,
  GT2_CHROME, GT2_COLORS,
} from '@/ui/gt2Chrome';

const STAGE_W = 90;
const STAGE_H = 26;
const STAGE_GAP = 6;
const SIDE_MARGIN = 12;

function activeMarque(life: LifeState): string {
  const id = life.ownedCars?.[0];
  const car = id ? CAR_CATALOG[id] : null;
  if (!car) return 'GARAGE';
  const sp = car.name.indexOf(' ');
  return (sp > 0 ? car.name.slice(0, sp) : car.name).toUpperCase();
}

function detailCrumbs(life: LifeState): string[] {
  return [activeMarque(life), 'TUNE', (life.partsCategoryOpen || ''), (life.partsDetailOpen || '')];
}

/** Look up the PARTS_SHOP entry by name, or null when the player's
 *  partsDetailOpen value is stale (catalog reload after save). */
function findPart(name: string): ShopPart | null {
  return PARTS_SHOP.find((p) => p.name === name) ?? null;
}

/** Pricing — uses the dealer venue rate (8x base * car-cost-mult,
 *  no skill gate) since the BUY action is the GT2 "buy it now"
 *  gesture. DIY / mechanic routing lands as a follow-up hop. */
function dealerPrice(part: ShopPart, life: LifeState): number {
  const id = life.ownedCars?.[0];
  const car = id ? CAR_CATALOG[id] : undefined;
  const mult = getCarCostMult(car);
  return Math.round(part.cost * 8 * mult);
}

/** Human-readable "before -> after" line for the chosen stat lane.
 *  Falls back to the part.add value when we don't track a baseline
 *  (welded / supercharged mod flags). */
function beforeAfterLine(part: ShopPart, life: LifeState): string {
  if (part.stat === 'welded') return 'Mod: WELDED DIFF';
  if (part.stat === 'supercharged') return 'Mod: SUPERCHARGED';
  const before =
    part.stat === 'tires' ? life.tires
    : part.stat === 'engine' ? life.engine
    : part.stat === 'hp' ? life.carHP
    : Math.min(life.engine, life.tires, life.carHP);
  const after = Math.min(100, before + part.add);
  return before + '% → ' + after + '%';
}

export function drawPartsDetail(
  ctx: CanvasRenderingContext2D,
  life: LifeState,
  GW: number, GH: number,
): void {
  const name = life.partsDetailOpen;
  if (!name) return;
  const part = findPart(name);
  if (!part) return;

  ctx.fillStyle = GT2_COLORS.bg;
  ctx.fillRect(0, 0, GW, GH);
  drawGt2Backdrop(ctx, GW, GH);
  drawGt2TopBar(ctx, GW, { crumbs: detailCrumbs(life), activeIcon: 'options' });
  drawGt2BottomBar(ctx, life, GW, GH);

  // Header — italic part name. Reuses the GT2 poster treatment.
  ctx.textAlign = 'center';
  ctx.fillStyle = GT2_COLORS.text;
  ctx.font = 'italic bold 14px monospace';
  ctx.fillText(name, GW / 2, GT2_CHROME.TOP_H + 18);

  // Left column: "stages" — the current catalog only has Stage 1
  // per entry; the 4-chip layout stays as a placeholder so the
  // screen reads as GT2.
  //
  // H737 button-state policy: the SELECTED stage gets the darker
  // amberDark face (dark = selected per user direction). The other
  // stages take the regular amber face with textDim labels so they
  // read as available-but-not-purchased (rather than as "disabled,
  // darker" which was the prior wrong treatment).
  const colTop = GT2_CHROME.TOP_H + 32;
  for (let s = 0; s < 4; s++) {
    const isSelected = s === 0;
    const x = SIDE_MARGIN;
    const y = colTop + s * (STAGE_H + STAGE_GAP);
    ctx.fillStyle = isSelected ? GT2_COLORS.amberDark : GT2_COLORS.amber;
    fillRoundRect(ctx, x, y, STAGE_W, STAGE_H, 4);
    ctx.fillStyle = isSelected ? GT2_COLORS.text : GT2_COLORS.textDim;
    ctx.font = 'bold 11px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('Stage ' + (s + 1), x + STAGE_W / 2, y + STAGE_H / 2 + 4);
  }

  // Right column: description + before/after delta + price + BUY.
  const rightX = SIDE_MARGIN + STAGE_W + 12;
  const rightW = GW - rightX - SIDE_MARGIN;
  ctx.textAlign = 'left';
  ctx.fillStyle = GT2_COLORS.text;
  ctx.font = 'bold 11px monospace';
  ctx.fillText('STAGE 1', rightX, colTop + 12);
  ctx.fillStyle = GT2_COLORS.textMute;
  ctx.font = '9px monospace';
  const desc = partDescription(part);
  wrapText(ctx, desc, rightX, colTop + 28, rightW, 11);

  // Before / after line + price + BUY pill near bottom of the
  // right column.
  const ba = beforeAfterLine(part, life);
  const baY = colTop + 96;
  ctx.fillStyle = GT2_COLORS.amber;
  ctx.font = 'bold 10px monospace';
  ctx.fillText(ba, rightX, baY);

  const price = dealerPrice(part, life);
  ctx.fillStyle = GT2_COLORS.text;
  ctx.font = 'bold 13px monospace';
  ctx.fillText('$' + price.toLocaleString(), rightX, baY + 20);

  // BUY disc — H737 policy: regular amber face always. Unaffordable
  // state communicates via dim label text (not a darker face, which
  // would imply selection).
  const canAfford = life.money >= price;
  const buy = buyRect(GW, baY + 14);
  ctx.fillStyle = GT2_COLORS.amber;
  ctx.beginPath();
  ctx.arc(buy.cx, buy.cy, buy.r, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = canAfford ? GT2_COLORS.bgDeep : GT2_COLORS.textDim;
  ctx.font = 'bold 12px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('BUY', buy.cx, buy.cy);
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
}

function buyRect(GW: number, anchorY: number): { cx: number; cy: number; r: number } {
  return { cx: GW - SIDE_MARGIN - 22, cy: anchorY + 8, r: 22 };
}

function partDescription(part: ShopPart): string {
  const lane = part.stat === 'engine' ? 'engine'
    : part.stat === 'tires' ? 'tires'
    : part.stat === 'hp' ? 'body'
    : part.stat === 'all' ? 'engine, tires, and body'
    : part.stat;
  if (part.stat === 'welded') return 'Welded differential — locks the rear axle for predictable oversteer in tight corners. Permanent mod.';
  if (part.stat === 'supercharged') return 'Belt-driven supercharger pulley pack. Adds boost across the rev range. Permanent mod.';
  return 'Restores ' + part.add + '% to ' + lane + ' condition. ' +
    (part.type === 'delivery' ? 'Ships from the parts house.' :
     part.type === 'mechanic' ? 'Installed at the mechanic — quality job.' :
     'You can fit it in the garage.');
}

/** Crude word-wrap renderer. Splits on spaces and emits lines that
 *  fit `maxW`. Returns nothing — caller already positioned baseline. */
function wrapText(
  ctx: CanvasRenderingContext2D,
  s: string, x: number, y: number, maxW: number, lineH: number,
): void {
  const words = s.split(' ');
  let line = '';
  let cy = y;
  for (const w of words) {
    const test = line ? line + ' ' + w : w;
    if (ctx.measureText(test).width > maxW && line) {
      ctx.fillText(line, x, cy);
      cy += lineH;
      line = w;
    } else {
      line = test;
    }
  }
  if (line) ctx.fillText(line, x, cy);
}

export function handlePartsDetailClick(
  tx: number, ty: number,
  life: LifeState,
  GW: number, GH: number,
): boolean {
  const name = life.partsDetailOpen;
  if (!name) return false;
  const part = findPart(name);
  if (!part) {
    life.partsDetailOpen = null;
    return true;
  }

  const close = (): void => { life.partsDetailOpen = null; };

  const crumbs = detailCrumbs(life);
  if (gt2TopBarHitTest(tx, ty, GW, crumbs.length, {
    onHome: () => {
      life.partsDetailOpen = null;
      life.partsCategoryOpen = null;
      life.partsLineupOpen = false;
    },
    onCrumb: (idx) => {
      // 0 = marque → all the way back; 1 = TUNE → lineup grid;
      // 2 = category → sub-menu list.
      if (idx === 0) {
        life.partsDetailOpen = null;
        life.partsCategoryOpen = null;
        life.partsLineupOpen = false;
      } else if (idx === 1) {
        life.partsDetailOpen = null;
        life.partsCategoryOpen = null;
      } else if (idx === 2) {
        life.partsDetailOpen = null;
      }
    },
  })) return true;
  if (gt2BottomBarHitTest(tx, ty, GH, { onExit: close })) return true;

  // BUY disc.
  const baY = GT2_CHROME.TOP_H + 32 + 96;
  const buy = buyRect(GW, baY + 14);
  const dx = tx - buy.cx;
  const dy = ty - buy.cy;
  if (dx * dx + dy * dy <= buy.r * buy.r) {
    const price = dealerPrice(part, life);
    if (life.money < price) {
      showNotif(life, 'Need $' + (price - life.money).toLocaleString() + ' more');
      return true;
    }
    life.money -= price;
    applyPart(life, part);
    showNotif(life, 'Installed ' + part.name);
    life.partsDetailOpen = null;
    life.partsCategoryOpen = null;
    return true;
  }

  return true;
}

function fillRoundRect(
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
