/**
 * Mazda RX-7 FD (FD3S, 1992-2002) — full V2 sprite renderer.
 *
 * Distinctive features:
 *   - Long hood, short rear deck (front mid-engine layout)
 *   - Wide rear haunches that taper into a narrow nose
 *   - Flush pop-up headlights (nothing visible when retracted)
 *   - Full-width taillight bar with body-color divider
 *   - Subtle double-bubble roof
 *   - A-pillar mounted side mirrors
 *   - Side cowl vents behind front wheel wells
 *
 * Ported from monolith L37081–37404.
 */

import type { GenerationRenderer } from '../types';
import { v2GroundShadow, v2Wheels, v2TaillightGlow, v2HeadlightGlow } from '../v2Helpers';
import { darken, lighten } from '../colorUtils';

function tracePath(
  ctx: CanvasRenderingContext2D,
  hl: number,
  hw: number,
  L: number,
  _W: number,
): void {
  ctx.beginPath();
  // Rear-left, clockwise.
  ctx.moveTo(-hl, -hw * 0.55);
  ctx.quadraticCurveTo(-hl, -hw * 0.90, -hl + L * 0.04, -hw * 0.98);
  ctx.lineTo(-hl + L * 0.14, -hw);                    // rear haunch peak
  ctx.lineTo(-hl + L * 0.30, -hw);                    // haunch top (widest)
  ctx.quadraticCurveTo(-hl + L * 0.42, -hw * 0.98, -hl + L * 0.48, -hw * 0.84);
  ctx.quadraticCurveTo(-hl + L * 0.54, -hw * 0.80, -hl + L * 0.62, -hw * 0.82);
  ctx.quadraticCurveTo(-hl + L * 0.72, -hw * 0.88, -hl + L * 0.82, -hw * 0.94);
  ctx.lineTo(hl - L * 0.12, -hw * 0.93);              // fender top
  ctx.quadraticCurveTo(hl - L * 0.02, -hw * 0.72, hl, -hw * 0.40);
  ctx.quadraticCurveTo(hl + 0.3, -hw * 0.18, hl + 0.3, 0);
  // Mirror to the right side.
  ctx.quadraticCurveTo(hl + 0.3, hw * 0.18, hl, hw * 0.40);
  ctx.quadraticCurveTo(hl - L * 0.02, hw * 0.72, hl - L * 0.12, hw * 0.93);
  ctx.lineTo(-hl + L * 0.82, hw * 0.94);
  ctx.quadraticCurveTo(-hl + L * 0.72, hw * 0.88, -hl + L * 0.62, hw * 0.82);
  ctx.quadraticCurveTo(-hl + L * 0.54, hw * 0.80, -hl + L * 0.48, hw * 0.84);
  ctx.quadraticCurveTo(-hl + L * 0.42, hw * 0.98, -hl + L * 0.30, hw);
  ctx.lineTo(-hl + L * 0.14, hw);
  ctx.lineTo(-hl + L * 0.04, hw * 0.98);
  ctx.quadraticCurveTo(-hl, hw * 0.90, -hl, hw * 0.55);
  ctx.closePath();
}

export const RX7_FD: GenerationRenderer = {
  id: 'rx7_fd',

  render(ctx, L, W, color, opts) {
    const hl = L / 2;
    const hw = W / 2;
    const { isBraking, nightFactor, isReverse, steerAngle, isXray } = opts;
    const axle: readonly [number, number] = [0.60, 0.52];

    // 1. Ground shadow (skipped in xray).
    if (!isXray) v2GroundShadow(ctx, tracePath, hl, hw, L, W);

    // 2. Wheels.
    v2Wheels(ctx, axle, hl, hw, L, steerAngle, isXray);

    if (isXray) {
      ctx.save();
      tracePath(ctx, hl, hw, L, W);
      ctx.strokeStyle = 'rgba(0,255,255,0.35)';
      ctx.lineWidth = 0.5;
      ctx.setLineDash([2, 2]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
      return;
    }

    // 3. Body fill.
    tracePath(ctx, hl, hw, L, W);
    ctx.fillStyle = color;
    ctx.fill();

    // 4. Clip downstream details to body silhouette.
    ctx.save();
    tracePath(ctx, hl, hw, L, W);
    ctx.clip();

    // 5. Rear haunch shadow — inner-facing side of bulge.
    ctx.fillStyle = darken(color, 0.32);
    ctx.beginPath();
    ctx.moveTo(-hl + L * 0.04, -hw * 0.98);
    ctx.lineTo(-hl + L * 0.30, -hw);
    ctx.quadraticCurveTo(-hl + L * 0.42, -hw * 0.98, -hl + L * 0.48, -hw * 0.84);
    ctx.lineTo(-hl + L * 0.40, -hw * 0.72);
    ctx.lineTo(-hl + L * 0.08, -hw * 0.78);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(-hl + L * 0.04, hw * 0.98);
    ctx.lineTo(-hl + L * 0.30, hw);
    ctx.quadraticCurveTo(-hl + L * 0.42, hw * 0.98, -hl + L * 0.48, hw * 0.84);
    ctx.lineTo(-hl + L * 0.40, hw * 0.72);
    ctx.lineTo(-hl + L * 0.08, hw * 0.78);
    ctx.closePath();
    ctx.fill();

    // 6. Rear deck plane — trunk, slightly darker than rear-window bubble.
    ctx.fillStyle = darken(color, 0.15);
    ctx.beginPath();
    ctx.moveTo(-hl + L * 0.02, -hw * 0.72);
    ctx.lineTo(-hl * 0.45, -hw * 0.62);
    ctx.lineTo(-hl * 0.45,  hw * 0.62);
    ctx.lineTo(-hl + L * 0.02,  hw * 0.72);
    ctx.closePath();
    ctx.fill();

    // 7. Front fender shadows — inside edge, shows fender bulges.
    ctx.fillStyle = darken(color, 0.28);
    ctx.beginPath();
    ctx.moveTo(-hl + L * 0.62, -hw * 0.82);
    ctx.quadraticCurveTo(-hl + L * 0.72, -hw * 0.88, -hl + L * 0.82, -hw * 0.94);
    ctx.lineTo(hl - L * 0.20, -hw * 0.80);
    ctx.lineTo(-hl + L * 0.58, -hw * 0.70);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(-hl + L * 0.62, hw * 0.82);
    ctx.quadraticCurveTo(-hl + L * 0.72, hw * 0.88, -hl + L * 0.82, hw * 0.94);
    ctx.lineTo(hl - L * 0.20, hw * 0.80);
    ctx.lineTo(-hl + L * 0.58, hw * 0.70);
    ctx.closePath();
    ctx.fill();

    // 8. Hood side shadow bands (darker strip along fender seams).
    ctx.fillStyle = darken(color, 0.22);
    ctx.fillRect(hl * 0.18, -hw * 0.72, hl * 0.78, hw * 0.08);
    ctx.fillRect(hl * 0.18,  hw * 0.64, hl * 0.78, hw * 0.08);

    // 9. Hood crown highlight (center ridge catches most light).
    ctx.fillStyle = lighten(color, 0.22);
    ctx.fillRect(hl * 0.22, -hw * 0.12, hl * 0.70, hw * 0.24);

    // 10. Roof / cabin crown — brightest surface.
    ctx.fillStyle = lighten(color, 0.18);
    ctx.fillRect(-hl * 0.22, -hw * 0.44, hl * 0.44, hw * 0.88);

    // 11. Rear haunch crown highlights + front fender crown highlights.
    ctx.strokeStyle = lighten(color, 0.28);
    ctx.lineWidth = 1.2;
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(-hl + L * 0.08, s * hw * 0.92);
      ctx.quadraticCurveTo(-hl + L * 0.22, s * hw * 0.96, -hl + L * 0.32, s * hw * 0.92);
      ctx.stroke();
    }
    ctx.lineWidth = 1.0;
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(-hl + L * 0.70, s * hw * 0.86);
      ctx.quadraticCurveTo(-hl + L * 0.82, s * hw * 0.92, hl - L * 0.18, s * hw * 0.88);
      ctx.stroke();
    }

    // 12. Inset dark rim (visible fender-edge shadow).
    tracePath(ctx, hl, hw, L, W);
    ctx.strokeStyle = darken(color, 0.55);
    ctx.lineWidth = 1.8;
    ctx.stroke();

    // 13. Windshield (dark glass, sloped forward).
    const wsBack = hl * 0.05;
    const wsFront = hl * 0.22;
    ctx.fillStyle = '#0a1320';
    ctx.beginPath();
    ctx.moveTo(wsBack,  -hw * 0.60);
    ctx.lineTo(wsFront, -hw * 0.45);
    ctx.lineTo(wsFront,  hw * 0.45);
    ctx.lineTo(wsBack,   hw * 0.60);
    ctx.closePath();
    ctx.fill();

    // 14. Rear window (sloped backward, smaller).
    const rwFront = -hl * 0.10;
    const rwBack  = -hl * 0.32;
    ctx.fillStyle = '#0a1320';
    ctx.beginPath();
    ctx.moveTo(rwFront, -hw * 0.55);
    ctx.lineTo(rwBack,  -hw * 0.40);
    ctx.lineTo(rwBack,   hw * 0.40);
    ctx.lineTo(rwFront,  hw * 0.55);
    ctx.closePath();
    ctx.fill();

    // 15. Roof panel (between windows — flatter, slightly less light).
    ctx.fillStyle = lighten(color, 0.10);
    ctx.beginPath();
    ctx.moveTo(rwFront, -hw * 0.52);
    ctx.lineTo(wsBack,  -hw * 0.57);
    ctx.lineTo(wsBack,   hw * 0.57);
    ctx.lineTo(rwFront,  hw * 0.52);
    ctx.closePath();
    ctx.fill();

    // 16. A-pillar dark lines.
    ctx.strokeStyle = darken(color, 0.5);
    ctx.lineWidth = 0.4;
    ctx.beginPath(); ctx.moveTo(wsBack, -hw * 0.58); ctx.lineTo(wsFront, -hw * 0.44); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(wsBack,  hw * 0.58); ctx.lineTo(wsFront,  hw * 0.44); ctx.stroke();

    // 17. Windshield glint (GBC sparkle).
    ctx.fillStyle = 'rgba(200,225,245,0.65)';
    ctx.fillRect(wsBack + 0.6, -hw * 0.25, (wsFront - wsBack) * 0.55, 0.7);

    // 18. Side cowl vents (FD gill signature — behind front wheels).
    ctx.fillStyle = darken(color, 0.65);
    ctx.fillRect(hl * 0.30, -hw * 0.58, L * 0.04, hw * 0.16);
    ctx.fillRect(hl * 0.30,  hw * 0.42, L * 0.04, hw * 0.16);

    // 19. Hood shutline.
    ctx.strokeStyle = darken(color, 0.40);
    ctx.lineWidth = 0.4;
    ctx.beginPath();
    ctx.moveTo(hl * 0.18, -hw * 0.68);
    ctx.lineTo(hl * 0.18,  hw * 0.68);
    ctx.stroke();

    // 20. Specular pin-dot on hood crown.
    ctx.fillStyle = lighten(color, 0.55);
    ctx.fillRect(hl * 0.62, -hw * 0.04, 1.2, 0.9);

    ctx.restore(); // end clip

    // 21. Mirrors — A-pillar mount, poke outside silhouette.
    const mirX = hl * 0.08;
    ctx.fillStyle = darken(color, 0.40);
    ctx.fillRect(mirX, -hw * 0.96 - 1.2, 1.5, 1.4);
    ctx.fillRect(mirX,  hw * 0.96 - 0.2, 1.5, 1.4);
    ctx.fillStyle = 'rgba(160,185,210,0.5)';
    ctx.fillRect(mirX + 0.3, -hw * 0.96 - 1.0, 0.8, 0.5);
    ctx.fillRect(mirX + 0.3,  hw * 0.96 + 0.0, 0.8, 0.5);

    // 22. Pop-up headlights — flush seam when off, rectangular lamps + glow when on.
    const hlightX = hl - L * 0.05;
    if (nightFactor > 0.05) {
      ctx.fillStyle = '#fff5c8';
      ctx.fillRect(hlightX, -hw * 0.62, 1.8, 1.4);
      ctx.fillRect(hlightX,  hw * 0.62 - 1.4, 1.8, 1.4);
      const hg = 3.2 + nightFactor * 3.2;
      v2HeadlightGlow(ctx, hlightX + 1, -hw * 0.55, hg, nightFactor * 0.45);
      v2HeadlightGlow(ctx, hlightX + 1,  hw * 0.55, hg, nightFactor * 0.45);
    } else {
      ctx.strokeStyle = darken(color, 0.55);
      ctx.lineWidth = 0.4;
      ctx.strokeRect(hlightX, -hw * 0.62, 1.8, 1.2);
      ctx.strokeRect(hlightX,  hw * 0.62 - 1.2, 1.8, 1.2);
    }

    // 23. FD signature taillights — 2 horizontal rounded-rectangle pills per side,
    //     license plate gap in the middle.
    const tailX = -hl + L * 0.02;
    const tw = hw * 0.82;
    const tlBright = isBraking ? '#ff6650' : (nightFactor > 0.05 ? '#ee2a15' : '#b02418');
    const pillThickHalf = 0.85;
    const pillLenHalf = tw * 0.32;
    const pillCx = tailX + pillThickHalf + 0.15;
    ctx.fillStyle = tlBright;
    for (const sign of [-1, 1]) {
      const cy = sign * tw * 0.55;
      ctx.fillRect(
        pillCx - pillThickHalf,
        cy - (pillLenHalf - pillThickHalf),
        pillThickHalf * 2,
        (pillLenHalf - pillThickHalf) * 2,
      );
      ctx.beginPath();
      ctx.arc(pillCx, cy - (pillLenHalf - pillThickHalf), pillThickHalf, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(pillCx, cy + (pillLenHalf - pillThickHalf), pillThickHalf, 0, Math.PI * 2);
      ctx.fill();
    }
    // Inner dark band — dual-element look.
    ctx.fillStyle = darken(tlBright, 0.5);
    for (const sign of [-1, 1]) {
      const cy = sign * tw * 0.55;
      ctx.fillRect(pillCx - pillThickHalf, cy - 0.25, pillThickHalf * 2, 0.5);
    }
    // Amber turn signal at extreme outer edges.
    ctx.fillStyle = nightFactor > 0.05 ? '#ff9900' : '#8a4400';
    ctx.fillRect(tailX + 0.2, -tw * 0.92, 1.3, 0.6);
    ctx.fillRect(tailX + 0.2,  tw * 0.92 - 0.6, 1.3, 0.6);
    // Rear hatch seam.
    ctx.strokeStyle = darken(color, 0.42);
    ctx.lineWidth = 0.4;
    ctx.beginPath();
    ctx.moveTo(-hl * 0.42, -hw * 0.42);
    ctx.quadraticCurveTo(-hl * 0.85, -hw * 0.55, -hl + L * 0.06, -hw * 0.52);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(-hl * 0.42, hw * 0.42);
    ctx.quadraticCurveTo(-hl * 0.85, hw * 0.55, -hl + L * 0.06, hw * 0.52);
    ctx.stroke();
    // Rear spoiler lip.
    ctx.strokeStyle = darken(color, 0.48);
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(-hl + L * 0.05, -hw * 0.88);
    ctx.lineTo(-hl + L * 0.05,  hw * 0.88);
    ctx.stroke();
    // Brake/night glow.
    if (isBraking || nightFactor > 0.05) {
      const tg = 3.0 + nightFactor * 2.5 + (isBraking ? 3 : 0);
      const ta = isBraking ? 0.55 : nightFactor * 0.35;
      const tc = isBraking ? '255,70,50' : '255,40,10';
      for (const sign of [-1, 1]) {
        v2TaillightGlow(ctx, pillCx, sign * tw * 0.55, tg, ta, tc);
      }
    }

    // 24. Reverse lights (warm-white at each pill's inner end).
    if (isReverse) {
      ctx.fillStyle = '#ffe8a0';
      for (const sign of [-1, 1]) {
        const innerEnd = sign * (tw * 0.55 - (pillLenHalf - pillThickHalf));
        ctx.beginPath();
        ctx.arc(pillCx, innerEnd, pillThickHalf * 0.8, 0, Math.PI * 2);
        ctx.fill();
      }
      if (nightFactor > 0.05) {
        const rg = 2.5 + nightFactor * 2.5;
        for (const sign of [-1, 1]) {
          const innerEnd = sign * (tw * 0.55 - (pillLenHalf - pillThickHalf));
          const grd = ctx.createRadialGradient(pillCx, innerEnd, 0, pillCx, innerEnd, rg);
          grd.addColorStop(0, `rgba(255,230,180,${0.3 + nightFactor * 0.2})`);
          grd.addColorStop(1, 'rgba(255,230,180,0)');
          ctx.fillStyle = grd;
          ctx.fillRect(pillCx - rg, innerEnd - rg, rg * 2, rg * 2);
        }
      }
    }

    // 25. Outer silhouette outline.
    tracePath(ctx, hl, hw, L, W);
    ctx.strokeStyle = 'rgba(0,0,0,0.75)';
    ctx.lineWidth = 0.7;
    ctx.stroke();
  },
};
