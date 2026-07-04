/**
 * Game render: parking-lot pavement + procedural stall overlay (H697).
 *
 * The current modular game render pipeline (gameLoop.ts) doesn't paint
 * tile=18/19 directly — drawGrass / drawBuildings / drawBaselineRoads
 * skip them. So this pass owns BOTH the lot's background pavement fill
 * AND the stall overlay, all from the polygon row (the tileMap stamps
 * exist for physics drivability, not visual). Same stall geometry as
 * the editor — both renderers call src/editor/parkingLayout.
 *
 * The camera transform is already in the canvas context (gameLoop.ts
 * has applied it), so this pass paints in world pixels: tile→world is
 * just `tileCoord * TILE`. Viewport culling uses the polygon's bbox
 * vs the frame view's tile-coord bounds.
 */
import { computeStallLayout } from '@/editor/parkingLayout';
import { _weParseParkingLotMeta } from '@/editor/stamp';

export interface ParkingLotStallsDeps {
  /** Tile pixel size — `tileCoord * TILE = worldPx`. */
  TILE: number;
  /** Parking-lot rows to render. Each row is the H699 schema:
   *  [name, material, stallW, stallL, aisleW, x1, y1, ...]. On the city this is
   *  the live editor state (migrated H693/H695 → H699 at storage-load); on a
   *  non-city map (H1032 car meet) it's the active map source's lots. Read-only
   *  here — the renderer never mutates it. */
  parkingLots: readonly unknown[];
  /** H703: editor-wide ADA count. All lots use the same value until a
   *  per-row schema bump lands. Caller pulls from
   *  worldEditor.parkingLotProps.adaCount. */
  adaCount: number;
  /** Tile-coord viewport for bbox-cull. The gameLoop.ts caller derives
   *  this from the player+cull radius. */
  minTX: number;
  maxTX: number;
  minTY: number;
  maxTY: number;
}

const ASPHALT_FILL = '#48484a';
const CONCRETE_FILL = '#bab4a6';

export function drawParkingLotStalls(
  ctx: CanvasRenderingContext2D,
  deps: ParkingLotStallsDeps,
): void {
  const { TILE, parkingLots, adaCount, minTX, maxTX, minTY, maxTY } = deps;
  if (!parkingLots || parkingLots.length === 0) return;

  for (let i = 0; i < parkingLots.length; i++) {
    const row = parkingLots[i];
    if (!Array.isArray(row) || row.length < 7) continue;
    // H699: parser handles H693/H695/H699 in one place; xStart + meta
    // dimensions flow through. Storage migrates to H699 on load, so
    // most rows here are H699.
    const meta = _weParseParkingLotMeta(row);
    const pts: [number, number][] = [];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let k = meta.xStart; k + 1 < row.length; k += 2) {
      const x = row[k] as number;
      const y = row[k + 1] as number;
      pts.push([x, y]);
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    if (pts.length < 3) continue;
    // Bbox cull — skip lots fully outside the visible tile range.
    if (maxX < minTX || minX > maxTX || maxY < minTY || minY > maxTY) continue;

    // Pavement fill — flat color across the polygon. Painted FIRST so
    // the stall stripes + ADA cells sit on top.
    ctx.fillStyle = meta.material === 'concrete' ? CONCRETE_FILL : ASPHALT_FILL;
    ctx.beginPath();
    ctx.moveTo(pts[0][0] * TILE, pts[0][1] * TILE);
    for (let k = 1; k < pts.length; k++) {
      ctx.lineTo(pts[k][0] * TILE, pts[k][1] * TILE);
    }
    ctx.closePath();
    ctx.fill();

    const layout = computeStallLayout(pts, {
      stallW: meta.stallW,
      stallL: meta.stallL,
      aisleW: meta.aisleW,
      maxAdaPerRow: adaCount,
    });
    if (!layout.stalls.length) continue;

    // Drive aisle centerlines — dashed white.
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.setLineDash([4, 4]);
    for (const aisle of layout.aisles) {
      const mx0 = (aisle.corners[0][0] + aisle.corners[3][0]) * 0.5 * TILE;
      const my0 = (aisle.corners[0][1] + aisle.corners[3][1]) * 0.5 * TILE;
      const mx1 = (aisle.corners[1][0] + aisle.corners[2][0]) * 0.5 * TILE;
      const my1 = (aisle.corners[1][1] + aisle.corners[2][1]) * 0.5 * TILE;
      ctx.beginPath();
      ctx.moveTo(mx0, my0);
      ctx.lineTo(mx1, my1);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // Stalls — ADA fills cyan; every cell gets two white side stripes.
    for (const s of layout.stalls) {
      const c0x = s.corners[0][0] * TILE, c0y = s.corners[0][1] * TILE;
      const c1x = s.corners[1][0] * TILE, c1y = s.corners[1][1] * TILE;
      const c2x = s.corners[2][0] * TILE, c2y = s.corners[2][1] * TILE;
      const c3x = s.corners[3][0] * TILE, c3y = s.corners[3][1] * TILE;
      if (s.ada) {
        ctx.fillStyle = 'rgba(58,180,220,0.55)';
        ctx.beginPath();
        ctx.moveTo(c0x, c0y);
        ctx.lineTo(c1x, c1y);
        ctx.lineTo(c2x, c2y);
        ctx.lineTo(c3x, c3y);
        ctx.closePath();
        ctx.fill();
      }
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(c0x, c0y);
      ctx.lineTo(c3x, c3y);
      ctx.moveTo(c1x, c1y);
      ctx.lineTo(c2x, c2y);
      ctx.stroke();
    }
    // H700: tree islands at row endcaps — tan planter + green tree.
    for (const ti of layout.treeIslands) {
      const c0x = ti.corners[0][0] * TILE, c0y = ti.corners[0][1] * TILE;
      const c1x = ti.corners[1][0] * TILE, c1y = ti.corners[1][1] * TILE;
      const c2x = ti.corners[2][0] * TILE, c2y = ti.corners[2][1] * TILE;
      const c3x = ti.corners[3][0] * TILE, c3y = ti.corners[3][1] * TILE;
      ctx.fillStyle = '#8c785a'; // tan planter
      ctx.beginPath();
      ctx.moveTo(c0x, c0y);
      ctx.lineTo(c1x, c1y);
      ctx.lineTo(c2x, c2y);
      ctx.lineTo(c3x, c3y);
      ctx.closePath();
      ctx.fill();
      const cxp = (c0x + c1x + c2x + c3x) * 0.25;
      const cyp = (c0y + c1y + c2y + c3y) * 0.25;
      const span = Math.min(
        Math.hypot(c1x - c0x, c1y - c0y),
        Math.hypot(c3x - c0x, c3y - c0y),
      );
      const r = Math.max(2, span * 0.32);
      ctx.fillStyle = '#1a5a1a';
      ctx.beginPath();
      ctx.arc(cxp, cyp, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#2d8c2d';
      ctx.beginPath();
      ctx.arc(cxp - r * 0.25, cyp - r * 0.25, r * 0.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}
