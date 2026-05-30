/**
 * H731: GT2-style parts sub-category list.
 *
 * Reference: "TURBO PARTS LINEUP / TURBO KITS / INTERCOOLER" stack
 * from the 2026-05-30 GT2 screenshot set. Top row has a small icon
 * + parent label; the body lists the available sub-items as amber
 * bullet rows.
 *
 * Opens when life.partsCategoryOpen is set (driven by a tile tap on
 * the H730 lineup grid). Each row corresponds to one PARTS_SHOP
 * entry that maps into the selected category. Tap routes to the
 * H731-companion stage-detail screen via life.partsDetailOpen.
 *
 * Catalog mapping ([[parts-category-map]]) groups PARTS_SHOP rows
 * into the eight GT2 categories. Bikes are filtered through
 * filterAvailableParts so welded-diff / supercharger items don't
 * surface where they shouldn't.
 */

import type { LifeState } from '@/state/life';
import { CAR_CATALOG } from '@/config/cars/catalog';
import {
  PARTS_SHOP, filterAvailableParts, type ShopPart,
} from '@/sim/partsShop';
import {
  drawGt2TopBar, drawGt2BottomBar, drawGt2Backdrop,
  gt2TopBarHitTest, gt2BottomBarHitTest,
  GT2_CHROME, GT2_COLORS,
} from '@/ui/gt2Chrome';
import type { PartsCategory } from './partsLineup';

/** Hand-tuned mapping of PARTS_SHOP entry names into the eight GT2
 *  category buckets. Entries that don't fit anywhere land in OTHERS
 *  so the screen never shows an empty list (which would block the
 *  player from backing out via row taps). */
const PART_NAME_TO_CATEGORY: Record<string, PartsCategory> = {
  'NEW TIRES': 'TIRES',
  'BRAKE PADS': 'BRAKES',
  'STRUTS & SPRINGS': 'SUSPENSION',
  'CONTROL ARMS': 'SUSPENSION',
  'OIL CHANGE': 'ENGINE',
  'BODY PATCH': 'OTHERS',
  'FLUID FLUSH': 'OTHERS',
  'WELD DIFF': 'DRIVETRAIN',
  'SUPERCHARGER': 'TURBO',
  'USED ENGINE (40-80k mi)': 'ENGINE',
  'CRATE ENGINE (0 mi)': 'ENGINE',
  'ENGINE REBUILD': 'ENGINE',
  'TRANSMISSION REBUILD': 'DRIVETRAIN',
  'FULL SERVICE': 'OTHERS',
};

/** Returns the subset of PARTS_SHOP entries that belong to `cat`
 *  AND pass filterAvailableParts for the active car. */
export function partsInCategory(life: LifeState, cat: PartsCategory): ShopPart[] {
  const id = life.ownedCars?.[0];
  const car = id ? CAR_CATALOG[id] : undefined;
  const eligible = filterAvailableParts(life, car);
  return eligible.filter((p) => (PART_NAME_TO_CATEGORY[p.name] ?? 'OTHERS') === cat);
}

const ROW_H = 26;
const ROW_GAP = 4;
const LIST_MARGIN_X = 16;

function activeMarque(life: LifeState): string {
  const id = life.ownedCars?.[0];
  const car = id ? CAR_CATALOG[id] : null;
  if (!car) return 'GARAGE';
  const sp = car.name.indexOf(' ');
  return (sp > 0 ? car.name.slice(0, sp) : car.name).toUpperCase();
}

function submenuCrumbs(life: LifeState): string[] {
  return [activeMarque(life), 'TUNE', life.partsCategoryOpen || ''];
}

export function drawPartsSubmenu(
  ctx: CanvasRenderingContext2D,
  life: LifeState,
  GW: number, GH: number,
): void {
  const cat = life.partsCategoryOpen as PartsCategory | null;
  if (!cat) return;

  ctx.fillStyle = GT2_COLORS.bg;
  ctx.fillRect(0, 0, GW, GH);
  drawGt2Backdrop(ctx, GW, GH);
  drawGt2TopBar(ctx, GW, { crumbs: submenuCrumbs(life), activeIcon: 'options' });
  drawGt2BottomBar(ctx, life, GW, GH);

  // Marque banner.
  ctx.textAlign = 'center';
  ctx.fillStyle = GT2_COLORS.text;
  ctx.font = 'italic bold 16px monospace';
  ctx.fillText(activeMarque(life), GW / 2, GT2_CHROME.TOP_H + 18);

  // Category banner row — small amber square + "<CAT> PARTS LINEUP"
  // pill, mirroring the GT2 sub-cat header.
  const bandY = GT2_CHROME.TOP_H + 32;
  ctx.fillStyle = GT2_COLORS.amber;
  ctx.fillRect(LIST_MARGIN_X, bandY, 22, 22);
  ctx.fillStyle = GT2_COLORS.text;
  ctx.font = 'bold 9px monospace';
  ctx.textAlign = 'left';
  ctx.fillText(cat, LIST_MARGIN_X + 30, bandY + 10);
  ctx.fillStyle = GT2_COLORS.active;
  fillRoundRect(ctx, LIST_MARGIN_X + 30, bandY + 12, 110, 12, 3);
  ctx.fillStyle = GT2_COLORS.text;
  ctx.font = 'bold 8px monospace';
  ctx.textBaseline = 'middle';
  ctx.fillText('PARTS LINEUP', LIST_MARGIN_X + 85, bandY + 18);
  ctx.textBaseline = 'alphabetic';

  // List.
  const rows = partsInCategory(life, cat);
  const listTop = bandY + 36;
  ctx.font = 'bold 11px monospace';
  ctx.textAlign = 'left';
  if (rows.length === 0) {
    ctx.fillStyle = GT2_COLORS.textMute;
    ctx.font = '10px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('No parts available for this car.', GW / 2, listTop + 20);
    ctx.textAlign = 'left';
    return;
  }
  for (let i = 0; i < rows.length; i++) {
    const r = rowRect(i, GW, listTop);
    ctx.fillStyle = GT2_COLORS.amber;
    ctx.beginPath();
    ctx.arc(r.x + 10, r.y + ROW_H / 2, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = GT2_COLORS.text;
    ctx.font = 'bold 11px monospace';
    ctx.fillText(rows[i].name, r.x + 24, r.y + ROW_H / 2 + 4);
  }
}

function rowRect(
  i: number, GW: number, listTop: number,
): { x: number; y: number; w: number; h: number } {
  return {
    x: LIST_MARGIN_X,
    y: listTop + i * (ROW_H + ROW_GAP),
    w: GW - LIST_MARGIN_X * 2,
    h: ROW_H,
  };
}

export function handlePartsSubmenuClick(
  tx: number, ty: number,
  life: LifeState,
  GW: number, GH: number,
): boolean {
  const cat = life.partsCategoryOpen as PartsCategory | null;
  if (!cat) return false;

  const close = (): void => { life.partsCategoryOpen = null; };
  const crumbs = submenuCrumbs(life);
  if (gt2TopBarHitTest(tx, ty, GW, crumbs.length, {
    onHome: () => {
      life.partsCategoryOpen = null;
      life.partsLineupOpen = false;
    },
    onCrumb: (idx) => {
      if (idx === 1) close(); // TUNE crumb — back to lineup grid
      else if (idx === 0) {
        // marque crumb — close all the way back to car-switch
        life.partsCategoryOpen = null;
        life.partsLineupOpen = false;
      }
    },
  })) return true;
  if (gt2BottomBarHitTest(tx, ty, GH, { onExit: close })) return true;

  const rows = partsInCategory(life, cat);
  const bandY = GT2_CHROME.TOP_H + 32;
  const listTop = bandY + 36;
  for (let i = 0; i < rows.length; i++) {
    const r = rowRect(i, GW, listTop);
    if (tx >= r.x && tx <= r.x + r.w && ty >= r.y && ty <= r.y + r.h) {
      life.partsDetailOpen = rows[i].name;
      return true;
    }
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
