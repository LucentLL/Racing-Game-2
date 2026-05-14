/**
 * traceCarBodyPath — fills a closed Path2D-style path for a given body type.
 *
 * Each branch carves out a distinct silhouette in car-local coords (centered
 * on origin, ±hl × ±hw, where L = 2*hl and W = 2*hw). The path is left open
 * — the caller wraps it in ctx.fill() / ctx.stroke() / ground-shadow passes.
 *
 * Ported from monolith L36273–36560. 19 distinct body types, plus a default
 * 'sedan' shape that any unrecognized bodyType falls through to.
 */

export function traceCarBodyPath(
  ctx: CanvasRenderingContext2D,
  bodyType: string,
  hl: number,
  hw: number,
  L: number,
  W: number,
): void {
  ctx.beginPath();

  if (bodyType === 'viper') {
    // Long nose, wide hips tapering to narrow front.
    ctx.moveTo(-hl, -hw * 0.7);
    ctx.lineTo(-hl + L * 0.05, -hw * 0.85);
    ctx.quadraticCurveTo(-hl + L * 0.15, -hw, -hl + L * 0.25, -hw);
    ctx.lineTo(hl - L * 0.08, -hw * 0.9);
    ctx.quadraticCurveTo(hl, -hw * 0.6, hl, -hw * 0.35);
    ctx.lineTo(hl, hw * 0.35);
    ctx.quadraticCurveTo(hl, hw * 0.6, hl - L * 0.08, hw * 0.9);
    ctx.lineTo(-hl + L * 0.25, hw);
    ctx.quadraticCurveTo(-hl + L * 0.15, hw, -hl + L * 0.05, hw * 0.85);
    ctx.lineTo(-hl, hw * 0.7);
    ctx.closePath();
  } else if (bodyType === 'nsx') {
    // Consistent width, slight rear haunch, rounded corners.
    ctx.moveTo(-hl, -hw * 0.7);
    ctx.quadraticCurveTo(-hl, -hw, -hl + L * 0.1, -hw);
    ctx.lineTo(-hl + L * 0.3, -hw);
    ctx.quadraticCurveTo(-hl + L * 0.4, -hw * 0.88, -hl + L * 0.45, -hw * 0.88);
    ctx.lineTo(hl - L * 0.1, -hw * 0.85);
    ctx.quadraticCurveTo(hl, -hw * 0.7, hl, -hw * 0.35);
    ctx.lineTo(hl, hw * 0.35);
    ctx.quadraticCurveTo(hl, hw * 0.7, hl - L * 0.1, hw * 0.85);
    ctx.lineTo(-hl + L * 0.45, hw * 0.88);
    ctx.quadraticCurveTo(-hl + L * 0.4, hw * 0.88, -hl + L * 0.3, hw);
    ctx.lineTo(-hl + L * 0.1, hw);
    ctx.quadraticCurveTo(-hl, hw, -hl, hw * 0.7);
    ctx.closePath();
  } else if (bodyType === 'supra') {
    // Rounded bubble, long hood, smooth curves.
    ctx.moveTo(-hl, -hw * 0.55);
    ctx.quadraticCurveTo(-hl + L * 0.08, -hw * 0.9, -hl + L * 0.2, -hw * 0.95);
    ctx.quadraticCurveTo(-hl + L * 0.35, -hw, hl - L * 0.1, -hw * 0.85);
    ctx.quadraticCurveTo(hl, -hw * 0.5, hl, 0);
    ctx.quadraticCurveTo(hl, hw * 0.5, hl - L * 0.1, hw * 0.85);
    ctx.quadraticCurveTo(-hl + L * 0.35, hw, -hl + L * 0.2, hw * 0.95);
    ctx.quadraticCurveTo(-hl + L * 0.08, hw * 0.9, -hl, hw * 0.55);
    ctx.closePath();
  } else if (bodyType === 'rx7') {
    // Compact, rounded front, pop-up wedge.
    ctx.moveTo(-hl, -hw * 0.6);
    ctx.quadraticCurveTo(-hl + L * 0.12, -hw, -hl + L * 0.25, -hw);
    ctx.lineTo(hl - L * 0.05, -hw * 0.7);
    ctx.quadraticCurveTo(hl, -hw * 0.35, hl, 0);
    ctx.quadraticCurveTo(hl, hw * 0.35, hl - L * 0.05, hw * 0.7);
    ctx.lineTo(-hl + L * 0.25, hw);
    ctx.quadraticCurveTo(-hl + L * 0.12, hw, -hl, hw * 0.6);
    ctx.closePath();
  } else if (bodyType === 'corvette') {
    // Long hood, tapered rear, wide stance.
    ctx.moveTo(-hl, -hw * 0.55);
    ctx.lineTo(-hl + L * 0.1, -hw * 0.9);
    ctx.lineTo(-hl + L * 0.25, -hw);
    ctx.lineTo(hl - L * 0.06, -hw * 0.8);
    ctx.quadraticCurveTo(hl, -hw * 0.4, hl, 0);
    ctx.quadraticCurveTo(hl, hw * 0.4, hl - L * 0.06, hw * 0.8);
    ctx.lineTo(-hl + L * 0.25, hw);
    ctx.lineTo(-hl + L * 0.1, hw * 0.9);
    ctx.lineTo(-hl, hw * 0.55);
    ctx.closePath();
  } else if (bodyType === 'gtr') {
    // GT-R / Fairlady — boxy-round, wide fenders.
    ctx.moveTo(-hl, -hw * 0.7);
    ctx.lineTo(-hl + L * 0.12, -hw);
    ctx.lineTo(hl - L * 0.1, -hw);
    ctx.quadraticCurveTo(hl, -hw * 0.7, hl, 0);
    ctx.quadraticCurveTo(hl, hw * 0.7, hl - L * 0.1, hw);
    ctx.lineTo(-hl + L * 0.12, hw);
    ctx.lineTo(-hl, hw * 0.7);
    ctx.closePath();
  } else if (bodyType === 'camaro' || bodyType === 'mustang' || bodyType === 'gto') {
    // American muscle — boxy, wide, aggressive.
    ctx.moveTo(-hl, -hw * 0.8);
    ctx.lineTo(-hl + L * 0.08, -hw);
    ctx.lineTo(hl - L * 0.05, -hw);
    ctx.lineTo(hl, -hw * 0.7);
    ctx.lineTo(hl, hw * 0.7);
    ctx.lineTo(hl - L * 0.05, hw);
    ctx.lineTo(-hl + L * 0.08, hw);
    ctx.lineTo(-hl, hw * 0.8);
    ctx.closePath();
  } else if (bodyType === 'hatch') {
    // Hatchback — short, tall rear, stubby proportions.
    ctx.moveTo(-hl * 0.85, -hw * 0.9);
    ctx.lineTo(-hl * 0.75, -hw);
    ctx.lineTo(hl - L * 0.1, -hw * 0.9);
    ctx.quadraticCurveTo(hl * 0.9, -hw * 0.5, hl * 0.9, 0);
    ctx.quadraticCurveTo(hl * 0.9, hw * 0.5, hl - L * 0.1, hw * 0.9);
    ctx.lineTo(-hl * 0.75, hw);
    ctx.lineTo(-hl * 0.85, hw * 0.9);
    ctx.closePath();
  } else if (bodyType === 'mr2') {
    // Small mid-engine — compact, wedge.
    ctx.moveTo(-hl, -hw * 0.6);
    ctx.quadraticCurveTo(-hl + L * 0.15, -hw, -hl + L * 0.3, -hw * 0.9);
    ctx.lineTo(hl - L * 0.08, -hw * 0.65);
    ctx.quadraticCurveTo(hl, -hw * 0.3, hl, 0);
    ctx.quadraticCurveTo(hl, hw * 0.3, hl - L * 0.08, hw * 0.65);
    ctx.lineTo(-hl + L * 0.3, hw * 0.9);
    ctx.quadraticCurveTo(-hl + L * 0.15, hw, -hl, hw * 0.6);
    ctx.closePath();
  } else if (bodyType === 'roadster') {
    // Del Sol / Miata — short compact rounded rectangle.
    ctx.moveTo(-hl * 0.75, 0);
    ctx.quadraticCurveTo(-hl * 0.75, -hw, -hl * 0.5, -hw);
    ctx.lineTo(hl - L * 0.12, -hw);
    ctx.quadraticCurveTo(hl, -hw, hl, -hw * 0.4);
    ctx.lineTo(hl, hw * 0.4);
    ctx.quadraticCurveTo(hl, hw, hl - L * 0.12, hw);
    ctx.lineTo(-hl * 0.5, hw);
    ctx.quadraticCurveTo(-hl * 0.75, hw, -hl * 0.75, 0);
    ctx.closePath();
  } else if (bodyType === 'tvr') {
    // TVR — organic curves, rounded.
    ctx.moveTo(-hl, -hw * 0.5);
    ctx.quadraticCurveTo(-hl + L * 0.15, -hw, -hl + L * 0.3, -hw);
    ctx.quadraticCurveTo(hl - L * 0.1, -hw * 0.9, hl, -hw * 0.3);
    ctx.lineTo(hl, hw * 0.3);
    ctx.quadraticCurveTo(hl - L * 0.1, hw * 0.9, -hl + L * 0.3, hw);
    ctx.quadraticCurveTo(-hl + L * 0.15, hw, -hl, hw * 0.5);
    ctx.closePath();
  } else if (bodyType === 'race') {
    // Race car — low, wide, aggressive aero.
    ctx.moveTo(-hl - L * 0.03, -hw * 1.1);
    ctx.lineTo(-hl + L * 0.05, -hw);
    ctx.lineTo(hl - L * 0.03, -hw * 0.8);
    ctx.lineTo(hl + L * 0.02, -hw * 0.3);
    ctx.lineTo(hl + L * 0.02, hw * 0.3);
    ctx.lineTo(hl - L * 0.03, hw * 0.8);
    ctx.lineTo(-hl + L * 0.05, hw);
    ctx.lineTo(-hl - L * 0.03, hw * 1.1);
    ctx.closePath();
  } else if (bodyType === 'suv') {
    // SUV — tall, boxy.
    ctx.moveTo(-hl, -hw);
    ctx.lineTo(hl - L * 0.05, -hw);
    ctx.quadraticCurveTo(hl, -hw * 0.8, hl, 0);
    ctx.quadraticCurveTo(hl, hw * 0.8, hl - L * 0.05, hw);
    ctx.lineTo(-hl, hw);
    ctx.closePath();
  } else if (bodyType === 'pickup') {
    // Pickup — flat bed rear, cab front.
    ctx.moveTo(-hl, -hw * 0.9);
    ctx.lineTo(hl - L * 0.06, -hw * 0.9);
    ctx.quadraticCurveTo(hl, -hw * 0.6, hl, 0);
    ctx.quadraticCurveTo(hl, hw * 0.6, hl - L * 0.06, hw * 0.9);
    ctx.lineTo(-hl, hw * 0.9);
    ctx.closePath();
  } else if (bodyType === 'silvia') {
    // 180SX / Silvia / 240SX — boxy with rounded corners, slight nose taper.
    ctx.moveTo(-hl, -hw * 0.85);
    ctx.quadraticCurveTo(-hl, -hw, -hl + L * 0.08, -hw);
    ctx.lineTo(hl - L * 0.1, -hw * 0.95);
    ctx.quadraticCurveTo(hl, -hw * 0.85, hl, -hw * 0.5);
    ctx.lineTo(hl, hw * 0.5);
    ctx.quadraticCurveTo(hl, hw * 0.85, hl - L * 0.1, hw * 0.95);
    ctx.lineTo(-hl + L * 0.08, hw);
    ctx.quadraticCurveTo(-hl, hw, -hl, hw * 0.85);
    ctx.closePath();
  } else if (
    bodyType === 'integra' || bodyType === 'celica'
    || bodyType === 'eclipse' || bodyType === 'rally'
  ) {
    // Sport compact — sleek, moderate curves.
    ctx.moveTo(-hl, -hw * 0.7);
    ctx.quadraticCurveTo(-hl + L * 0.1, -hw, -hl + L * 0.2, -hw);
    ctx.lineTo(hl - L * 0.08, -hw * 0.85);
    ctx.quadraticCurveTo(hl, -hw * 0.45, hl, 0);
    ctx.quadraticCurveTo(hl, hw * 0.45, hl - L * 0.08, hw * 0.85);
    ctx.lineTo(-hl + L * 0.2, hw);
    ctx.quadraticCurveTo(-hl + L * 0.1, hw, -hl, hw * 0.7);
    ctx.closePath();
  } else if (bodyType === 'towtruck') {
    // Flatbed rollback — cab front, long flat bed behind.
    ctx.moveTo(-hl, -hw * 0.85);
    ctx.lineTo(-hl + L * 0.02, -hw);
    ctx.lineTo(hl - L * 0.2, -hw);
    ctx.lineTo(hl - L * 0.18, -hw * 0.7);
    ctx.lineTo(hl - L * 0.05, -hw * 0.7);
    ctx.quadraticCurveTo(hl, -hw * 0.5, hl, 0);
    ctx.quadraticCurveTo(hl, hw * 0.5, hl - L * 0.05, hw * 0.7);
    ctx.lineTo(hl - L * 0.18, hw * 0.7);
    ctx.lineTo(hl - L * 0.2, hw);
    ctx.lineTo(-hl + L * 0.02, hw);
    ctx.lineTo(-hl, hw * 0.85);
    ctx.closePath();
  } else if (bodyType === 'cruiser') {
    // Crown Vic — boxy, wide, authoritative.
    ctx.moveTo(-hl, -hw * 0.85);
    ctx.lineTo(-hl + L * 0.06, -hw);
    ctx.lineTo(hl - L * 0.06, -hw);
    ctx.lineTo(hl, -hw * 0.7);
    ctx.lineTo(hl, hw * 0.7);
    ctx.lineTo(hl - L * 0.06, hw);
    ctx.lineTo(-hl + L * 0.06, hw);
    ctx.lineTo(-hl, hw * 0.85);
    ctx.closePath();
  } else if (bodyType === 'boxtruck') {
    // Box truck — very short cab, wide rectangular cargo box.
    ctx.moveTo(hl, -hw * 0.8);
    ctx.lineTo(hl, hw * 0.8);
    ctx.lineTo(hl - L * 0.03, hw * 0.9);
    ctx.lineTo(hl - L * 0.15, hw * 0.92);
    ctx.lineTo(hl - L * 0.17, hw);
    ctx.lineTo(-hl + L * 0.01, hw);
    ctx.lineTo(-hl, hw * 0.98);
    ctx.lineTo(-hl, -hw * 0.98);
    ctx.lineTo(-hl + L * 0.01, -hw);
    ctx.lineTo(hl - L * 0.17, -hw);
    ctx.lineTo(hl - L * 0.15, -hw * 0.92);
    ctx.lineTo(hl - L * 0.03, -hw * 0.9);
    ctx.closePath();
  } else if (bodyType === 'semi') {
    // Semi tractor — short hood, wide boxy cab, frame behind with tandems.
    ctx.moveTo(-hl, -hw * 0.55);
    ctx.lineTo(-hl * 0.1, -hw * 0.55);
    ctx.lineTo(-hl * 0.05, -hw);
    ctx.lineTo(hl * 0.55, -hw);
    ctx.lineTo(hl * 0.6, -hw * 0.92);
    ctx.lineTo(hl * 0.95, -hw * 0.85);
    ctx.lineTo(hl, -hw * 0.7);
    ctx.lineTo(hl, hw * 0.7);
    ctx.lineTo(hl * 0.95, hw * 0.85);
    ctx.lineTo(hl * 0.6, hw * 0.92);
    ctx.lineTo(hl * 0.55, hw);
    ctx.lineTo(-hl * 0.05, hw);
    ctx.lineTo(-hl * 0.1, hw * 0.55);
    ctx.lineTo(-hl, hw * 0.55);
    ctx.closePath();
  } else if (bodyType === 'civic99') {
    // v8.99.122.16: 1999 Honda Civic Coupe (EM1/EJ8). Compact coupe with
    // wider rear quarters at the C-pillar tapering to a pointed nose.
    ctx.moveTo(-hl, -hw * 0.62);
    ctx.quadraticCurveTo(-hl + L * 0.025, -hw * 0.94, -hl + L * 0.09, -hw * 0.99);
    ctx.lineTo(-hl + L * 0.30, -hw);
    ctx.quadraticCurveTo(hl - L * 0.30, -hw * 0.97, hl - L * 0.18, -hw * 0.92);
    ctx.quadraticCurveTo(hl - L * 0.06, -hw * 0.62, hl - L * 0.01, -hw * 0.32);
    ctx.quadraticCurveTo(hl, -hw * 0.14, hl, 0);
    ctx.quadraticCurveTo(hl, hw * 0.14, hl - L * 0.01, hw * 0.32);
    ctx.quadraticCurveTo(hl - L * 0.06, hw * 0.62, hl - L * 0.18, hw * 0.92);
    ctx.quadraticCurveTo(hl - L * 0.30, hw * 0.97, -hl + L * 0.30, hw);
    ctx.lineTo(-hl + L * 0.09, hw * 0.99);
    ctx.quadraticCurveTo(-hl + L * 0.025, hw * 0.94, -hl, hw * 0.62);
    ctx.closePath();
  } else if (bodyType === 'accord99') {
    // v8.99.122.16: 1999 Honda Accord Sedan (CG, 6th gen). Full-width
    // shoulders, gentle rounded corners, long straight side line.
    ctx.moveTo(-hl, -hw * 0.74);
    ctx.quadraticCurveTo(-hl + L * 0.02, -hw * 0.95, -hl + L * 0.07, -hw * 0.99);
    ctx.lineTo(-hl + L * 0.18, -hw);
    ctx.lineTo(hl - L * 0.22, -hw * 0.99);
    ctx.quadraticCurveTo(hl - L * 0.10, -hw * 0.92, hl - L * 0.04, -hw * 0.62);
    ctx.quadraticCurveTo(hl - L * 0.005, -hw * 0.38, hl, -hw * 0.18);
    ctx.lineTo(hl, hw * 0.18);
    ctx.quadraticCurveTo(hl - L * 0.005, hw * 0.38, hl - L * 0.04, hw * 0.62);
    ctx.quadraticCurveTo(hl - L * 0.10, hw * 0.92, hl - L * 0.22, hw * 0.99);
    ctx.lineTo(-hl + L * 0.18, hw);
    ctx.lineTo(-hl + L * 0.07, hw * 0.99);
    ctx.quadraticCurveTo(-hl + L * 0.02, hw * 0.95, -hl, hw * 0.74);
    ctx.closePath();
  } else {
    // Default sedan — smooth shape.
    ctx.moveTo(-hl, -hw * 0.7);
    ctx.quadraticCurveTo(-hl + L * 0.1, -hw, -hl + L * 0.2, -hw * 0.95);
    ctx.lineTo(hl - L * 0.1, -hw * 0.9);
    ctx.quadraticCurveTo(hl, -hw * 0.5, hl, 0);
    ctx.quadraticCurveTo(hl, hw * 0.5, hl - L * 0.1, hw * 0.9);
    ctx.lineTo(-hl + L * 0.2, hw * 0.95);
    ctx.quadraticCurveTo(-hl + L * 0.1, hw, -hl, hw * 0.7);
    ctx.closePath();
  }
}
