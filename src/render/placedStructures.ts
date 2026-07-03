/**
 * H1004: game-render passes for editor-placed buildings + driveways as
 * clean footprint POLYGONS (per-type roofs / concrete strips), replacing
 * the per-tile tile=17/tile=19 staircase paint. Reads the same
 * worldEditor.buildings / .surfaces rows the tile stamps consume (the
 * stamps stay for physics: solid buildings + drivable driveways), exactly
 * like drawParkingLotStalls reads worldEditor.parkingLots.
 *
 * ctx is world-space (camera applied); tile → world px = tile * TILE.
 */
import { drawRoof, drawDrivewayStrip } from './roofs';
import { _weIsDrivewayName } from '@/editor/stamp';

export interface PlacedStructuresDeps {
  TILE: number;
  /** Live editor building rows: [name, type, x1,y1, ...] (coords @ 2). */
  buildings: unknown[];
  /** Live editor surface rows: [name, z, x1,y1, ...] (coords @ 2). */
  surfaces: unknown[];
  minTX: number;
  maxTX: number;
  minTY: number;
  maxTY: number;
}

/** Parse a polygon row's tile-coord corners + bbox from `xStart`. */
function parseRow(row: unknown[], xStart: number): {
  pts: Array<[number, number]>; minX: number; minY: number; maxX: number; maxY: number;
} | null {
  const pts: Array<[number, number]> = [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let k = xStart; k + 1 < row.length; k += 2) {
    const x = row[k] as number;
    const y = row[k + 1] as number;
    if (typeof x !== 'number' || typeof y !== 'number') continue;
    pts.push([x, y]);
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  if (pts.length < 3) return null;
  return { pts, minX, minY, maxX, maxY };
}

/** Concrete driveway strips (surface rows named "… driveway"). Painted
 *  BEFORE roads so the road-end overlap tucks under the asphalt. */
export function drawDriveways(ctx: CanvasRenderingContext2D, deps: PlacedStructuresDeps): void {
  const { TILE, surfaces, minTX, maxTX, minTY, maxTY } = deps;
  if (!surfaces || surfaces.length === 0) return;
  const project = (tx: number, ty: number): [number, number] => [tx * TILE, ty * TILE];
  for (const rowRaw of surfaces) {
    if (!Array.isArray(rowRaw) || rowRaw.length < 8) continue;
    if (!_weIsDrivewayName(rowRaw[0])) continue;
    const parsed = parseRow(rowRaw, 2);
    if (!parsed) continue;
    if (parsed.maxX < minTX || parsed.minX > maxTX || parsed.maxY < minTY || parsed.minY > maxTY) continue;
    drawDrivewayStrip(ctx, parsed.pts, project, 1.2);
  }
}

/** Per-type roofed building footprints. Painted AFTER roads so a roof
 *  isn't overlaid with lane stripes (aerial read). */
export function drawPlacedBuildings(ctx: CanvasRenderingContext2D, deps: PlacedStructuresDeps): void {
  const { TILE, buildings, minTX, maxTX, minTY, maxTY } = deps;
  if (!buildings || buildings.length === 0) return;
  const project = (tx: number, ty: number): [number, number] => [tx * TILE, ty * TILE];
  for (const rowRaw of buildings) {
    if (!Array.isArray(rowRaw) || rowRaw.length < 8) continue;
    const type = String(rowRaw[1] ?? 'house');
    const parsed = parseRow(rowRaw, 2);
    if (!parsed) continue;
    if (parsed.maxX < minTX || parsed.minX > maxTX || parsed.maxY < minTY || parsed.minY > maxTY) continue;
    drawRoof(ctx, parsed.pts, type, project);
  }
}
