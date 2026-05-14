/**
 * Toyota Supra A70 (MkIII, 1986-1992) — full V2 sprite renderer.
 *
 * Distinctive features:
 *   - Wedge profile, flatter than A80
 *   - Pop-up headlights (flush seam when off)
 *   - One large rectangular taillight cluster per side with internal
 *     horizontal dividers (reads as 3 stacked strips per cluster)
 *   - Angular, more square proportions
 *
 * Ported from monolith L38664–38862.
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
  ctx.moveTo(-hl, -hw * 0.68);
  ctx.lineTo(-hl + L * 0.03, -hw * 0.94);
  ctx.lineTo(-hl + L * 0.10, -hw);
  ctx.lineTo(hl - L * 0.18, -hw * 0.96);
  ctx.lineTo(hl - L * 0.08, -hw * 0.80);
  ctx.lineTo(hl - L * 0.02, -hw * 0.55);
  ctx.lineTo(hl,             -hw * 0.32);
  ctx.lineTo(hl,              hw * 0.32);
  ctx.lineTo(hl - L * 0.02,   hw * 0.55);
  ctx.lineTo(hl - L * 0.08,   hw * 0.80);
  ctx.lineTo(hl - L * 0.18,   hw * 0.96);
  ctx.lineTo(-hl + L * 0.10,  hw);
  ctx.lineTo(-hl + L * 0.03,  hw * 0.94);
  ctx.lineTo(-hl,             hw * 0.68);
  ctx.closePath();
}

export const SUPRA_A70: GenerationRenderer = {
  id: 'supra_a70',

  render(ctx, L, W, color, opts) {
    const hl = L / 2;
    const hw = W / 2;
    const { isBraking, nightFactor, isReverse, steerAngle, isXray } = opts;
    const axle: readonly [number, number] = [0.58, 0.50];

    if (!isXray) v2GroundShadow(ctx, tracePath, hl, hw, L, W);
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

    tracePath(ctx, hl, hw, L, W);
    ctx.fillStyle = color;
    ctx.fill();

    ctx.save();
    tracePath(ctx, hl, hw, L, W);
    ctx.clip();

    // Rear deck.
    ctx.fillStyle = darken(color, 0.14);
    ctx.fillRect(-hl + L * 0.04, -hw * 0.86, hl * 0.66, hw * 1.72);

    // Hood edge shadows.
    ctx.fillStyle = darken(color, 0.20);
    ctx.fillRect(hl * 0.10, -hw * 0.80, hl * 0.82, hw * 0.12);
    ctx.fillRect(hl * 0.10,  hw * 0.68, hl * 0.82, hw * 0.12);

    // Hood center crown (flat — A70 has flat hood).
    ctx.fillStyle = lighten(color, 0.16);
    ctx.fillRect(hl * 0.12, -hw * 0.18, hl * 0.80, hw * 0.36);

    // Roof / cabin.
    ctx.fillStyle = lighten(color, 0.18);
    ctx.fillRect(-hl * 0.22, -hw * 0.50, hl * 0.40, hw * 1.00);

    // Inset rim.
    tracePath(ctx, hl, hw, L, W);
    ctx.strokeStyle = darken(color, 0.55);
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Windshield.
    const wsBack = hl * 0.10;
    const wsFront = hl * 0.22;
    ctx.fillStyle = '#0a1320';
    ctx.beginPath();
    ctx.moveTo(wsBack,  -hw * 0.62);
    ctx.lineTo(wsFront, -hw * 0.48);
    ctx.lineTo(wsFront,  hw * 0.48);
    ctx.lineTo(wsBack,   hw * 0.62);
    ctx.closePath();
    ctx.fill();

    // Rear window (large liftback glass).
    const rwFront = -hl * 0.04;
    const rwBack  = -hl * 0.34;
    ctx.fillStyle = '#0a1320';
    ctx.beginPath();
    ctx.moveTo(rwFront, -hw * 0.58);
    ctx.lineTo(rwBack,  -hw * 0.48);
    ctx.lineTo(rwBack,   hw * 0.48);
    ctx.lineTo(rwFront,  hw * 0.58);
    ctx.closePath();
    ctx.fill();

    // Roof panel.
    ctx.fillStyle = lighten(color, 0.08);
    ctx.beginPath();
    ctx.moveTo(rwFront, -hw * 0.56);
    ctx.lineTo(wsBack,  -hw * 0.60);
    ctx.lineTo(wsBack,   hw * 0.60);
    ctx.lineTo(rwFront,  hw * 0.56);
    ctx.closePath();
    ctx.fill();

    // A-pillars.
    ctx.strokeStyle = darken(color, 0.50);
    ctx.lineWidth = 0.4;
    ctx.beginPath(); ctx.moveTo(wsBack, -hw * 0.60); ctx.lineTo(wsFront, -hw * 0.46); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(wsBack,  hw * 0.60); ctx.lineTo(wsFront,  hw * 0.46); ctx.stroke();

    // Glint.
    ctx.fillStyle = 'rgba(195,220,240,0.55)';
    ctx.fillRect(wsBack + 0.4, -hw * 0.24, (wsFront - wsBack) * 0.5, 0.6);

    // Panel lines (visible boxy seams).
    ctx.strokeStyle = darken(color, 0.38);
    ctx.lineWidth = 0.4;
    ctx.beginPath(); ctx.moveTo(hl * 0.10, 0);          ctx.lineTo(hl * 0.90, 0);          ctx.stroke();
    ctx.beginPath(); ctx.moveTo(hl * 0.06,  -hw * 0.92); ctx.lineTo(hl * 0.06,   hw * 0.92); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-hl * 0.30, -hw * 0.92); ctx.lineTo(-hl * 0.30,  hw * 0.92); ctx.stroke();

    // Specular.
    ctx.fillStyle = lighten(color, 0.48);
    ctx.fillRect(hl * 0.55, -hw * 0.06, 1.0, 0.7);

    ctx.restore(); // end clip

    // Mirrors (fender-mounted, era-appropriate).
    ctx.fillStyle = darken(color, 0.38);
    ctx.fillRect(hl * 0.26, -hw - 1.1, 1.3, 1.2);
    ctx.fillRect(hl * 0.26,  hw - 0.1, 1.3, 1.2);
    ctx.fillStyle = 'rgba(165,185,210,0.5)';
    ctx.fillRect(hl * 0.26 + 0.3, -hw - 0.9, 0.7, 0.5);
    ctx.fillRect(hl * 0.26 + 0.3,  hw + 0.1, 0.7, 0.5);

    // Pop-up headlights (flush when off).
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

    // A70 taillights — one large cluster per side with 2 internal horizontal
    // dividers (reads as 3 stacked strips per cluster).
    const tailX = -hl + L * 0.02;
    const tw = hw * 0.82;
    const tlBright = isBraking ? '#ff5544' : (nightFactor > 0.05 ? '#ee2a15' : '#9a2010');
    ctx.fillStyle = tlBright;
    for (const s of [-1, 1]) {
      const yCenter = s * tw * 0.55;
      const yHalf = tw * 0.35;
      ctx.fillRect(tailX, yCenter - yHalf, 2.2, yHalf * 2);
    }
    // Internal dark dividers.
    ctx.fillStyle = darken(tlBright, 0.55);
    for (const s of [-1, 1]) {
      const yCenter = s * tw * 0.55;
      const yHalf = tw * 0.35;
      ctx.fillRect(tailX, yCenter - yHalf * 0.40, 2.2, 0.35);
      ctx.fillRect(tailX, yCenter + yHalf * 0.20, 2.2, 0.35);
    }
    // Body-color center panel.
    ctx.fillStyle = color;
    ctx.fillRect(tailX + 0.2, -tw * 0.18, 2.2, tw * 0.36);
    // Amber turn signals.
    ctx.fillStyle = nightFactor > 0.05 ? '#ff9900' : '#8a4400';
    ctx.fillRect(tailX, -tw * 0.90 - 0.3, 1.3, 0.55);
    ctx.fillRect(tailX,  tw * 0.90 - 0.25, 1.3, 0.55);
    // Glow per cluster (not per strip).
    if (isBraking || nightFactor > 0.05) {
      const tg = 2.8 + nightFactor * 2.2 + (isBraking ? 2.8 : 0);
      const ta = isBraking ? 0.52 : nightFactor * 0.34;
      const tc = isBraking ? '255,70,50' : '255,40,10';
      for (const s of [-1, 1]) {
        v2TaillightGlow(ctx, tailX + 1.1, s * tw * 0.55, tg, ta, tc);
      }
    }

    // Reverse.
    if (isReverse) {
      ctx.fillStyle = '#ffe8a0';
      ctx.fillRect(tailX + 0.2, -0.5, 1.6, 1.0);
    }

    // Outline.
    tracePath(ctx, hl, hw, L, W);
    ctx.strokeStyle = 'rgba(0,0,0,0.72)';
    ctx.lineWidth = 0.6;
    ctx.stroke();
  },
};
