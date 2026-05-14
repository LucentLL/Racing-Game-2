/**
 * drawCarBodyV2 — the V2 dispatcher. Looks up a chassis renderer from
 * GEN_DATA and invokes it, threading the active player car name to
 * v2Wheels via the v2RenderCarName module-level state (so the X-Ray
 * geometry path can read GT4_SPECS without every per-gen render() needing
 * an extra param). Save/restore makes the threading safe across nested
 * drawTopCar calls (e.g. tow truck hauling another car).
 *
 * Returns false when no renderer is registered for `genId` — the caller
 * (drawTopCar in C19c) then falls through to the legacy bodyType silhouette.
 *
 * Ported from monolith L40346–40356.
 */

import type { GenerationRenderOpts } from './types';
import { GEN_DATA } from './index';
import { setV2RenderCarName } from './v2Helpers';

export function drawCarBodyV2(
  ctx: CanvasRenderingContext2D,
  genId: string,
  L: number,
  W: number,
  color: string,
  opts: GenerationRenderOpts,
): boolean {
  const g = GEN_DATA[genId];
  if (!g) return false;
  const prevName = setV2RenderCarName(opts.carName ?? null);
  try {
    g.render(ctx, L, W, color, opts);
  } finally {
    setV2RenderCarName(prevName);
  }
  return true;
}
