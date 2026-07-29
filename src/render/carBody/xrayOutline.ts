/**
 * H1282: sprite-accurate X-ray body outlines.
 *
 * The X-ray dashes used to come from traceCarBodyPath — 19 generic hand-made
 * silhouettes — so the outline never matched the car the player was actually
 * looking at (user: "the goal is to update the x-ray body outlines to match
 * the car sprites outlines as they are imported"). XRAY_OUTLINES carries the
 * real alpha contour of every manifest sprite, traced at build time by
 * scripts/traceXrayOutlines.mjs through the same processing pipeline the
 * renderer applies to the PNG (rotate portrait->landscape, corner background
 * flood-removal, alpha-trim).
 *
 * Points are normalized to [0,1]^2 over the TRIMMED opaque box, which is
 * exactly the canvas drawImage stretches to (L*sb[0]) x (W*sb[1]) — so the
 * mapping below makes the dashes land on the same pixels the sprite paints.
 */

import { XRAY_OUTLINES } from '@/config/cars/xrayOutlines';

export function hasXrayOutline(key: string | null | undefined): boolean {
  return !!(key && XRAY_OUTLINES[key]);
}

/** Begin a path tracing `key`'s sprite outline in car-local coords (+X nose).
 *  `sb` is the SPRITE_BUFFER pair the sprite itself is drawn with — passing
 *  the same pair keeps outline and art in perfect registration. Returns false
 *  (path untouched) when the key has no baked outline; the caller falls back
 *  to the legacy traceCarBodyPath silhouette. */
export function traceXrayOutlinePath(
  ctx: CanvasRenderingContext2D,
  key: string | null | undefined,
  L: number,
  W: number,
  sb?: readonly [number, number],
): boolean {
  const pts = key ? XRAY_OUTLINES[key] : undefined;
  if (!pts || pts.length < 6) return false;
  const bL = L * (sb?.[0] ?? 1);
  const bW = W * (sb?.[1] ?? 1);
  ctx.beginPath();
  ctx.moveTo((pts[0] - 0.5) * bL, (pts[1] - 0.5) * bW);
  for (let i = 2; i < pts.length; i += 2) {
    ctx.lineTo((pts[i] - 0.5) * bL, (pts[i + 1] - 0.5) * bW);
  }
  ctx.closePath();
  return true;
}
