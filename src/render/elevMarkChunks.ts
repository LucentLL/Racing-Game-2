/**
 * H1168 — per-z chunk-grid layers for the ELEVATED-ROAD MARKING pass.
 *
 * drawBridgeOverlays Pass 2 already had per-chunk bbox-texture bakes
 * (H795 markBake), but two entry classes always fell back to live
 * stroking: chunks whose axis-aligned bbox texture would exceed
 * MARK_BAKE_MAX_EDGE (a long diagonal/curved chunk needs a mostly-
 * empty giant canvas — I-277's visible chunk wanted 6276×11451), and
 * long UN-CHUNKED entries (Brookshire Fwy, I-277(2)). Together those
 * live-stroked ~129 calls/frame at the I-485 interchange (measured
 * 2026-07-16). Fixed-size world-grid tiles (the H1167 engine from
 * roadChunks.ts) sidestep the oversize problem entirely — a chunk's
 * canvas never depends on road shape.
 *
 * One layer per elevated z so gameLoop's per-level deck/traffic
 * sandwich (H801) keeps its exact paint order: drawBridgeOverlays
 * dispatches into this module INSIDE Pass 2, per z, so decks (Pass 1)
 * still paint first and markings still land at their level.
 *
 * The bake paints through paintElevatedMarkings — the verbatim
 * extraction of the legacy Pass 2 body — so output is identical, and
 * where the H795 bbox textures DO exist the bake blits them at 1:1
 * sampling (MARK_BAKE_SS = grid scale = 3).
 */

import { createChunkLayer, type ChunkLayer } from '@/render/roadChunks';
import { paintElevatedMarkings, anyElevatedRoadIntersects } from '@/render/worldMap';

const layers = new Map<number, ChunkLayer>();

export function drawElevMarkChunks(
  ctx: CanvasRenderingContext2D,
  z: number,
  focusX: number,
  focusY: number,
  cullR: number,
): void {
  let layer = layers.get(z);
  if (!layer) {
    layer = createChunkLayer({
      statsKey: '__elevMarkStats_z' + z,
      probe: (minX, minY, maxX, maxY) => anyElevatedRoadIntersects(minX, minY, maxX, maxY, z),
      bake: (g, cwx, cwy, r) => paintElevatedMarkings(g, cwx, cwy, r, z, false),
    });
    layers.set(z, layer);
  }
  layer.draw(ctx, focusX, focusY, cullR);
}
