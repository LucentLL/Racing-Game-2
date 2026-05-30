/**
 * H729: Spec-sheet sub-screen — GT2-style tabulated dimensions /
 * powertrain / drivetrain block.
 *
 * Reference: SKYLINE GTS25 Type S "SPEC" screen — italic display
 * title row, then a 2-column tabulated stack of label/value pairs:
 * Length / Width / Height / Weight / Displacement / Drivetrain /
 * Engine Type / Max HP / Max Torque.
 *
 * Triggered by a small "ⓘ" tap target on the seller modal (H727).
 * Opens by setting life.specSheetOpenId = <catalog-id>; closes via
 * the GT2 chrome's home icon, the SPEC crumb, or the bottom-bar
 * exit arrow.
 *
 * Data sources:
 *   - Catalog (name, hp, kg, drv, modelYear, rhd) — from CAR_CATALOG.
 *   - GT4_SPECS (lng / wid / disp / eType / pTq / redl) — keyed by
 *     the catalog name.
 * Missing-spec fallback: rows that depend on GT4_SPECS render '-'
 * so cars without an extracted spec (most bikes, some special
 * vehicles) still get a coherent header + basic stats.
 *
 * Height is not in GT4_SPECS; the row is rendered as '-' (would
 * need a follow-up data hop to source typical sedan/coupe heights).
 */

import type { LifeState } from '@/state/life';
import { CAR_CATALOG } from '@/config/cars/catalog';
import { GT4_SPECS } from '@/config/cars/gt4Database';
import {
  drawGt2TopBar, drawGt2BottomBar, drawGt2Backdrop,
  gt2TopBarHitTest, gt2BottomBarHitTest,
  GT2_CHROME, GT2_COLORS,
} from '@/ui/gt2Chrome';

const SPEC_CRUMBS = ['SPEC'];

/** One row in the tabulated spec block. */
interface SpecRow {
  label: string;
  value: string;
}

/** Build the row list from catalog + GT4_SPECS lookup. Anything we
 *  can't resolve renders as '-' so the table layout never collapses. */
function buildSpecRows(carId: string): SpecRow[] | null {
  const car = CAR_CATALOG[carId];
  if (!car) return null;
  const spec = GT4_SPECS[car.name];

  const dash = '-';
  const lng = spec?.lng ? spec.lng + 'mm' : dash;
  const wid = spec?.wid ? spec.wid + 'mm' : dash;
  const disp = spec?.disp ? spec.disp : dash;
  const eType = spec?.eType ? spec.eType : dash;
  const drv = car.drv;
  const weight = car.kg ? Math.round(car.kg * 2.205) + 'lb' : dash;
  const hp = car.hp ? car.hp + 'hp' : dash;
  const hpAtRpm = spec?.redl ? hp + ' / ' + spec.redl + 'rpm' : hp;
  const tq = spec?.pTq
    ? spec.pTq.toFixed(1) + 'lb-ft' + (spec.redl ? ' / ' + Math.round(spec.redl * 0.6) + 'rpm' : '')
    : dash;

  return [
    { label: 'Length (mm)', value: lng },
    { label: 'Width (mm)', value: wid },
    { label: 'Height (mm)', value: dash },
    { label: 'Weight (lbs)', value: weight },
    { label: 'Displacement', value: disp },
    { label: 'Drivetrain', value: drv },
    { label: 'Engine Type', value: eType },
    { label: 'Max Horsepower (rpm)', value: hpAtRpm },
    { label: 'Max Torque (rpm)', value: tq },
  ];
}

/** Split the marque from the model line — "Nissan Skyline GT-R `99"
 *  becomes ("Nissan", "Skyline GT-R `99"). Falls back to (name, '')
 *  when there's no whitespace (single-word names like "Ambulance"). */
function splitMarque(name: string): [string, string] {
  const i = name.indexOf(' ');
  if (i < 0) return [name, ''];
  return [name.slice(0, i), name.slice(i + 1)];
}

export function drawSpecSheet(
  ctx: CanvasRenderingContext2D,
  life: LifeState,
  GW: number, GH: number,
): void {
  const carId = life.specSheetOpenId;
  if (!carId) return;
  const rows = buildSpecRows(carId);
  if (!rows) return;
  const car = CAR_CATALOG[carId];

  ctx.fillStyle = GT2_COLORS.bg;
  ctx.fillRect(0, 0, GW, GH);
  drawGt2Backdrop(ctx, GW, GH);

  drawGt2TopBar(ctx, GW, { crumbs: SPEC_CRUMBS, activeIcon: null });
  drawGt2BottomBar(ctx, life, GW, GH);

  ctx.textAlign = 'center';

  // Big italic display title + smaller model line. GT2's SKYLINE /
  // GTS25 Type S treatment.
  const [marqueWord, rest] = splitMarque(car.name);
  ctx.fillStyle = GT2_COLORS.text;
  ctx.font = 'italic bold 24px monospace';
  ctx.fillText(marqueWord.toUpperCase(), GW / 2, GT2_CHROME.TOP_H + 26);
  if (rest) {
    ctx.fillStyle = GT2_COLORS.textMute;
    ctx.font = 'italic bold 14px monospace';
    ctx.fillText(rest.toUpperCase(), GW / 2, GT2_CHROME.TOP_H + 46);
  }

  // Tabulated rows in a 2-up layout for the first 3 rows (matches
  // GT2's two-column dimensions block), then single-column for the
  // longer powertrain rows.
  const tableTop = GT2_CHROME.TOP_H + 62;
  const rowH = 18;
  const colW = (GW - 24) / 2;
  const leftX = 12;
  const rightX = 12 + colW;

  // Helper to paint one cell — label chip on the left half, value
  // box on the right half.
  const paintCell = (
    x: number, y: number, w: number,
    label: string, value: string,
  ): void => {
    const labelW = Math.floor(w * 0.5);
    ctx.fillStyle = GT2_COLORS.panel;
    ctx.fillRect(x, y, labelW, rowH);
    ctx.fillStyle = '#0d0d0d';
    ctx.fillRect(x + labelW, y, w - labelW, rowH);
    ctx.fillStyle = GT2_COLORS.text;
    ctx.font = 'bold 9px monospace';
    ctx.textAlign = 'left';
    ctx.fillText(label, x + 6, y + 12);
    ctx.fillStyle = GT2_COLORS.text;
    ctx.font = '10px monospace';
    ctx.fillText(value, x + labelW + 6, y + 12);
  };

  // Rows 0..1: Length + Width side-by-side
  paintCell(leftX, tableTop, colW - 2, rows[0].label, rows[0].value);
  paintCell(rightX + 2, tableTop, colW - 2, rows[1].label, rows[1].value);
  // Rows 2..3: Height + Weight side-by-side
  paintCell(leftX, tableTop + rowH + 4, colW - 2, rows[2].label, rows[2].value);
  paintCell(rightX + 2, tableTop + rowH + 4, colW - 2, rows[3].label, rows[3].value);
  // Rows 4..5: Displacement + Drivetrain side-by-side
  paintCell(leftX, tableTop + (rowH + 4) * 2, colW - 2, rows[4].label, rows[4].value);
  paintCell(rightX + 2, tableTop + (rowH + 4) * 2, colW - 2, rows[5].label, rows[5].value);
  // Row 6: Engine Type full width
  paintCell(leftX, tableTop + (rowH + 4) * 3, GW - 24, rows[6].label, rows[6].value);
  // Row 7: Max Horsepower full width
  paintCell(leftX, tableTop + (rowH + 4) * 4, GW - 24, rows[7].label, rows[7].value);
  // Row 8: Max Torque full width
  paintCell(leftX, tableTop + (rowH + 4) * 5, GW - 24, rows[8].label, rows[8].value);

  ctx.textAlign = 'left';
}

export function handleSpecSheetClick(
  tx: number, ty: number,
  life: LifeState,
  GW: number, GH: number,
): boolean {
  if (!life.specSheetOpenId) return false;
  const close = (): void => { life.specSheetOpenId = null; };
  if (gt2TopBarHitTest(tx, ty, GW, SPEC_CRUMBS.length, {
    onHome: close,
  })) return true;
  if (gt2BottomBarHitTest(tx, ty, GH, { onExit: close })) return true;
  // Any other tap inside the body is a no-op; modal eats it.
  return true;
}
