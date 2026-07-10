/**
 * H1112: shared controller focus-navigation helpers.
 *
 * Canvas menus in this game cache their tappable regions as plain rects
 * during draw (the rect-cache hit-test pattern). That same rect list is
 * everything a D-pad cursor needs: `spatialNav` picks the visually-
 * nearest rect in a pressed direction, and `drawFocusRing` paints the
 * Gran-Turismo-style highlight on it. Activation reuses the screen's
 * EXISTING tap handler at the focused rect's center, so controller and
 * pointer always do the same thing.
 *
 * Deliberately state-free and screen-agnostic so the home hub (H1112),
 * the pause-menu bodies, and the service modals (H1113+) can all share it.
 */

export interface FocusRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type NavDir = 'up' | 'down' | 'left' | 'right';

/** Center of a rect. */
export function rectCenter(r: FocusRect): { cx: number; cy: number } {
  return { cx: r.x + r.w / 2, cy: r.y + r.h / 2 };
}

/**
 * Spatial D-pad navigation. From `cur`, return the index of the best
 * rect lying in `dir`. "Best" = smallest travel along the press axis plus
 * a perpendicular-offset penalty, so a press stays in the same column /
 * row when it can and only jumps across when it must. Returns `cur`
 * unchanged when nothing lies that way (edge of the menu — no wrap, which
 * reads as a hard stop like console menus). A `cur` outside range snaps to
 * 0 so a fresh cursor lands somewhere valid.
 */
export function spatialNav(rects: readonly FocusRect[], cur: number, dir: NavDir): number {
  if (rects.length === 0) return -1;
  if (cur < 0 || cur >= rects.length) return 0;
  const c = rectCenter(rects[cur]);
  let best = cur;
  let bestCost = Infinity;
  for (let i = 0; i < rects.length; i++) {
    if (i === cur) continue;
    const r = rectCenter(rects[i]);
    const dx = r.cx - c.cx;
    const dy = r.cy - c.cy;
    let along: number;
    let perp: number;
    // A 1px slack on the gate stops equal-center rows/cols from being
    // unreachable to their own axis.
    if (dir === 'left') {
      if (dx >= -1) continue;
      along = -dx; perp = Math.abs(dy);
    } else if (dir === 'right') {
      if (dx <= 1) continue;
      along = dx; perp = Math.abs(dy);
    } else if (dir === 'up') {
      if (dy >= -1) continue;
      along = -dy; perp = Math.abs(dx);
    } else {
      if (dy <= 1) continue;
      along = dy; perp = Math.abs(dx);
    }
    // Perpendicular offset weighted 2× so the cursor prefers the aligned
    // neighbour over a closer-but-diagonal one.
    const cost = along + perp * 2;
    if (cost < bestCost) { bestCost = cost; best = i; }
  }
  return best;
}

/**
 * Paint the GT-style focus highlight around `r`. Call AFTER the item is
 * drawn. A soft outer glow + a bright inset border reads clearly on both
 * the amber-on-charcoal menus and busier tab bodies. Default colour is the
 * GT2 active orange.
 */
export function drawFocusRing(
  ctx: CanvasRenderingContext2D,
  r: FocusRect,
  color = '#ff7a18',
  pad = 3,
): void {
  const x = r.x - pad;
  const y = r.y - pad;
  const w = r.w + pad * 2;
  const h = r.h + pad * 2;
  ctx.save();
  ctx.lineJoin = 'round';
  // Outer glow.
  ctx.strokeStyle = 'rgba(255,122,24,0.35)';
  ctx.lineWidth = 6;
  ctx.strokeRect(x, y, w, h);
  // Bright inner border.
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.strokeRect(x, y, w, h);
  // Corner ticks for an unmistakable "cursor is here" read.
  const t = Math.min(10, Math.min(w, h) * 0.28);
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(x, y + t); ctx.lineTo(x, y); ctx.lineTo(x + t, y);
  ctx.moveTo(x + w - t, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w, y + t);
  ctx.moveTo(x + w, y + h - t); ctx.lineTo(x + w, y + h); ctx.lineTo(x + w - t, y + h);
  ctx.moveTo(x + t, y + h); ctx.lineTo(x, y + h); ctx.lineTo(x, y + h - t);
  ctx.stroke();
  ctx.restore();
}
