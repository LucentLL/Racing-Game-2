/**
 * H730: GT2-style Parts Lineup grid.
 *
 * Reference: MAZDASPEED Parts Lineup screen from 2026-05-30 — a
 * 2x4 grid of amber icon tiles (MUFFLER / BRAKES / ENGINE /
 * DRIVETRAIN on the top row; TURBO / SUSPENSION / TIRES / OTHERS
 * on the bottom). Faint outline of the underlying car blueprints
 * behind the grid; "PARTS LINEUP" italic banner overhead.
 *
 * Open via the TUNE pill on the H726 car-switch modal's active
 * row. Closes via the GT2 chrome's home icon, the GARAGE crumb,
 * or the bottom-bar exit arrow.
 *
 * H730 SCOPE: grid + chrome only. Tile tap previews the category
 * name (will land sub-category screen in H731). Actual catalog
 * routing through PARTS_SHOP / filterAvailableParts / applyPart
 * (which already lives in the home-overlay's garage parts view)
 * happens in H732 where the stage-detail BUY commits.
 */

import type { LifeState } from '@/state/life';
import { CAR_CATALOG } from '@/config/cars/catalog';
import {
  drawGt2TopBar, drawGt2BottomBar, drawGt2Backdrop,
  gt2TopBarHitTest, gt2BottomBarHitTest,
  GT2_CHROME, GT2_COLORS,
} from '@/ui/gt2Chrome';

/** Stable order — same as GT2's MAZDASPEED screen so the layout
 *  reads identical. */
export const PARTS_CATEGORIES = [
  'MUFFLER',
  'BRAKES',
  'ENGINE',
  'DRIVETRAIN',
  'TURBO',
  'SUSPENSION',
  'TIRES',
  'OTHERS',
] as const;

export type PartsCategory = typeof PARTS_CATEGORIES[number];

const GRID_COLS = 4;
const GRID_ROWS = 2;
const TILE_GAP = 8;
/** Banner height between the top chrome and the grid. */
const BANNER_H = 40;

/** Derive the "marque" word from the active car's name — first
 *  whitespace-separated token. Falls back to "GARAGE" when there's
 *  no active car. */
function activeMarque(life: LifeState): string {
  const id = life.ownedCars?.[0];
  const car = id ? CAR_CATALOG[id] : null;
  if (!car) return 'GARAGE';
  const sp = car.name.indexOf(' ');
  return (sp > 0 ? car.name.slice(0, sp) : car.name).toUpperCase();
}

function partsCrumbs(life: LifeState): string[] {
  return [activeMarque(life), 'TUNE'];
}

/** Grid geometry — depends on canvas width / height. */
interface GridLayout {
  tileW: number;
  tileH: number;
  ox: number; // origin X
  oy: number; // origin Y
}

function gridLayout(GW: number, GH: number): GridLayout {
  const top = GT2_CHROME.TOP_H + BANNER_H;
  const bot = GH - GT2_CHROME.BOT_H - 8;
  const availW = GW - 16;
  const availH = bot - top - 8;
  const tileW = Math.floor((availW - (GRID_COLS - 1) * TILE_GAP) / GRID_COLS);
  const tileH = Math.floor((availH - (GRID_ROWS - 1) * TILE_GAP) / GRID_ROWS);
  const ox = 8 + Math.max(0, Math.floor((availW - (tileW * GRID_COLS + TILE_GAP * (GRID_COLS - 1))) / 2));
  const oy = top + 8;
  return { tileW, tileH, ox, oy };
}

function tileRect(
  i: number, GW: number, GH: number,
): { x: number; y: number; w: number; h: number } {
  const { tileW, tileH, ox, oy } = gridLayout(GW, GH);
  const col = i % GRID_COLS;
  const row = Math.floor(i / GRID_COLS);
  return {
    x: ox + col * (tileW + TILE_GAP),
    y: oy + row * (tileH + TILE_GAP),
    w: tileW,
    h: tileH,
  };
}

export function drawPartsLineup(
  ctx: CanvasRenderingContext2D,
  life: LifeState,
  GW: number, GH: number,
): void {
  if (!life.partsLineupOpen) return;

  ctx.fillStyle = GT2_COLORS.bg;
  ctx.fillRect(0, 0, GW, GH);
  drawGt2Backdrop(ctx, GW, GH);
  drawGt2TopBar(ctx, GW, { crumbs: partsCrumbs(life), activeIcon: 'options' });
  drawGt2BottomBar(ctx, life, GW, GH);

  // Banner — italic marque word + "PARTS LINEUP" pill, mirroring
  // the MAZDASPEED / PARTS LINEUP stack in the reference.
  ctx.textAlign = 'center';
  ctx.fillStyle = GT2_COLORS.text;
  ctx.font = 'italic bold 18px monospace';
  ctx.fillText(activeMarque(life), GW / 2, GT2_CHROME.TOP_H + 18);
  const pillW = 110;
  const pillX = (GW - pillW) / 2;
  const pillY = GT2_CHROME.TOP_H + 24;
  ctx.fillStyle = GT2_COLORS.active;
  fillRoundRect(ctx, pillX, pillY, pillW, 14, 3);
  ctx.fillStyle = GT2_COLORS.text;
  ctx.font = 'bold 9px monospace';
  ctx.textBaseline = 'middle';
  ctx.fillText('PARTS LINEUP', GW / 2, pillY + 7.5);
  ctx.textBaseline = 'alphabetic';

  // 2x4 grid.
  for (let i = 0; i < PARTS_CATEGORIES.length; i++) {
    const r = tileRect(i, GW, GH);
    drawCategoryTile(ctx, r.x, r.y, r.w, r.h, PARTS_CATEGORIES[i]);
  }

  ctx.textAlign = 'left';
}

function drawCategoryTile(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
  cat: PartsCategory,
): void {
  ctx.fillStyle = GT2_COLORS.amber;
  fillRoundRect(ctx, x, y, w, h, 6);
  ctx.strokeStyle = GT2_COLORS.amberDark;
  ctx.lineWidth = 1;
  strokeRoundRect(ctx, x + 0.5, y + 0.5, w - 1, h - 1, 6);

  // Icon glyph — canvas-drawn so no emoji/font dep. Centered in the
  // top ~60% of the tile; label sits below.
  const cx = x + w / 2;
  const iconY = y + h * 0.42;
  drawCategoryGlyph(ctx, cx, iconY, Math.min(w, h) * 0.45, cat);

  // Label.
  ctx.fillStyle = GT2_COLORS.bgDeep;
  ctx.font = 'bold 9px monospace';
  ctx.textAlign = 'center';
  ctx.fillText(cat, cx, y + h - 8);
}

/** Tile glyph — flat charcoal silhouette of the category. Cheap
 *  canvas primitives. Exported so the H782 garage-parts tab strip
 *  can render the same eight icons at a smaller size in its own
 *  view, keeping the visual vocabulary consistent across the two
 *  parts-screen entry points. */
export function drawCategoryGlyph(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number, size: number, cat: PartsCategory,
): void {
  ctx.fillStyle = GT2_COLORS.bgDeep;
  ctx.strokeStyle = GT2_COLORS.bgDeep;
  ctx.lineWidth = 2;
  const s = size;
  switch (cat) {
    case 'MUFFLER': {
      ctx.beginPath();
      ctx.ellipse(cx - s * 0.35, cy, s * 0.18, s * 0.22, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillRect(cx - s * 0.2, cy - s * 0.12, s * 0.55, s * 0.24);
      ctx.beginPath();
      ctx.ellipse(cx + s * 0.4, cy, s * 0.12, s * 0.18, 0, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case 'BRAKES': {
      ctx.beginPath();
      ctx.arc(cx, cy, s * 0.42, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx, cy, s * 0.42, -Math.PI * 0.25, Math.PI * 0.25);
      ctx.lineTo(cx, cy);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.arc(cx, cy, s * 0.18, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case 'ENGINE': {
      ctx.fillRect(cx - s * 0.32, cy - s * 0.28, s * 0.64, s * 0.5);
      ctx.fillRect(cx - s * 0.18, cy - s * 0.42, s * 0.36, s * 0.18);
      ctx.fillRect(cx - s * 0.42, cy - s * 0.1, s * 0.12, s * 0.12);
      ctx.fillRect(cx + s * 0.3, cy - s * 0.1, s * 0.12, s * 0.12);
      break;
    }
    case 'DRIVETRAIN': {
      ctx.fillRect(cx - s * 0.4, cy - s * 0.06, s * 0.8, s * 0.12);
      drawCog(ctx, cx - s * 0.28, cy, s * 0.18);
      drawCog(ctx, cx + s * 0.28, cy, s * 0.18);
      break;
    }
    case 'TURBO': {
      ctx.beginPath();
      ctx.arc(cx, cy, s * 0.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = GT2_COLORS.amber;
      for (let a = 0; a < 6; a++) {
        const ang = (Math.PI * 2 * a) / 6;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, s * 0.36, ang - 0.15, ang + 0.15);
        ctx.closePath();
        ctx.fill();
      }
      ctx.fillStyle = GT2_COLORS.bgDeep;
      ctx.beginPath();
      ctx.arc(cx, cy, s * 0.12, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case 'SUSPENSION': {
      ctx.fillRect(cx - s * 0.06, cy - s * 0.34, s * 0.12, s * 0.18);
      for (let i = -3; i <= 3; i++) {
        ctx.fillRect(cx - s * 0.16, cy - s * 0.16 + i * s * 0.08, s * 0.32, s * 0.04);
      }
      ctx.fillRect(cx - s * 0.18, cy + s * 0.16, s * 0.36, s * 0.18);
      break;
    }
    case 'TIRES': {
      ctx.beginPath();
      ctx.arc(cx, cy, s * 0.42, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = GT2_COLORS.amber;
      ctx.beginPath();
      ctx.arc(cx, cy, s * 0.22, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = GT2_COLORS.bgDeep;
      for (let a = 0; a < 5; a++) {
        const ang = (Math.PI * 2 * a) / 5;
        ctx.fillRect(
          cx + Math.cos(ang) * s * 0.14 - 1,
          cy + Math.sin(ang) * s * 0.14 - 1,
          3, 3,
        );
      }
      break;
    }
    case 'OTHERS': {
      ctx.font = 'bold ' + Math.floor(s * 0.5) + 'px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('···', cx, cy);
      ctx.textBaseline = 'alphabetic';
      break;
    }
  }
}

function drawCog(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number, r: number,
): void {
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  for (let a = 0; a < 8; a++) {
    const ang = (Math.PI * 2 * a) / 8;
    ctx.fillRect(
      cx + Math.cos(ang) * r - 2,
      cy + Math.sin(ang) * r - 2,
      4, 4,
    );
  }
}

export function handlePartsLineupClick(
  tx: number, ty: number,
  life: LifeState,
  GW: number, GH: number,
): boolean {
  if (!life.partsLineupOpen) return false;

  const close = (): void => { life.partsLineupOpen = false; };
  const crumbs = partsCrumbs(life);
  if (gt2TopBarHitTest(tx, ty, GW, crumbs.length, {
    onHome: close,
    onCrumb: (idx) => { if (idx === 0) close(); },
  })) return true;
  if (gt2BottomBarHitTest(tx, ty, GH, { onExit: close })) return true;

  // Tile hit-test — picking a category sets life.partsCategoryOpen
  // so H731's sub-menu can pick up. Until that hop lands, taps
  // light up the field but don't navigate (no-op write is harmless;
  // partsCategoryOpen has no renderer yet).
  for (let i = 0; i < PARTS_CATEGORIES.length; i++) {
    const r = tileRect(i, GW, GH);
    if (tx >= r.x && tx <= r.x + r.w && ty >= r.y && ty <= r.y + r.h) {
      life.partsCategoryOpen = PARTS_CATEGORIES[i];
      return true;
    }
  }
  return true;
}

/** Local rounded-rect helpers — same shape as the seller / purchase
 *  modules' inline helpers. */
function fillRoundRect(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
): void {
  roundRectPath(ctx, x, y, w, h, r);
  ctx.fill();
}
function strokeRoundRect(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
): void {
  roundRectPath(ctx, x, y, w, h, r);
  ctx.stroke();
}
function roundRectPath(
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
}
