/**
 * Toyota Supra A80 (MkIV, 1993-2002) — full V2 sprite renderer.
 *
 * Distinctive features:
 *   - Long hood, wide rear haunches, rounded jellybean nose
 *   - Rectangular projector headlights (not pop-ups — swapped from A70)
 *   - Twin hood vents (intercooler exit, near windshield base)
 *   - 3 round taillights per side in horizontal row (signature)
 *   - Default huge GT rear wing (RZ trim)
 *
 * Ported from monolith L38372–38651.
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
  ctx.moveTo(-hl, -hw * 0.50);
  ctx.quadraticCurveTo(-hl, -hw * 0.85, -hl + L * 0.06, -hw * 0.95);
  ctx.quadraticCurveTo(-hl + L * 0.12, -hw, -hl + L * 0.20, -hw);
  ctx.lineTo(-hl + L * 0.32, -hw);
  ctx.quadraticCurveTo(-hl + L * 0.44, -hw * 0.97, -hl + L * 0.52, -hw * 0.86);
  ctx.quadraticCurveTo(-hl + L * 0.60, -hw * 0.82, -hl + L * 0.68, -hw * 0.84);
  ctx.quadraticCurveTo(-hl + L * 0.78, -hw * 0.88, -hl + L * 0.86, -hw * 0.92);
  ctx.lineTo(hl - L * 0.08, -hw * 0.88);
  ctx.quadraticCurveTo(hl - L * 0.02, -hw * 0.66, hl, -hw * 0.36);
  ctx.quadraticCurveTo(hl + 0.2, -hw * 0.12, hl + 0.2, 0);
  ctx.quadraticCurveTo(hl + 0.2, hw * 0.12, hl, hw * 0.36);
  ctx.quadraticCurveTo(hl - L * 0.02, hw * 0.66, hl - L * 0.08, hw * 0.88);
  ctx.lineTo(-hl + L * 0.86, hw * 0.92);
  ctx.quadraticCurveTo(-hl + L * 0.78, hw * 0.88, -hl + L * 0.68, hw * 0.84);
  ctx.quadraticCurveTo(-hl + L * 0.60, hw * 0.82, -hl + L * 0.52, hw * 0.86);
  ctx.quadraticCurveTo(-hl + L * 0.44, hw * 0.97, -hl + L * 0.32, hw);
  ctx.lineTo(-hl + L * 0.20, hw);
  ctx.quadraticCurveTo(-hl + L * 0.12, hw, -hl + L * 0.06, hw * 0.95);
  ctx.quadraticCurveTo(-hl, hw * 0.85, -hl, hw * 0.50);
  ctx.closePath();
}

export const SUPRA_A80: GenerationRenderer = {
  id: 'supra_a80',

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

    // Rear haunch shadows.
    ctx.fillStyle = darken(color, 0.30);
    ctx.beginPath();
    ctx.moveTo(-hl + L * 0.06, -hw * 0.95);
    ctx.lineTo(-hl + L * 0.32, -hw);
    ctx.quadraticCurveTo(-hl + L * 0.44, -hw * 0.97, -hl + L * 0.52, -hw * 0.86);
    ctx.lineTo(-hl + L * 0.44, -hw * 0.70);
    ctx.lineTo(-hl + L * 0.12, -hw * 0.78);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(-hl + L * 0.06, hw * 0.95);
    ctx.lineTo(-hl + L * 0.32, hw);
    ctx.quadraticCurveTo(-hl + L * 0.44, hw * 0.97, -hl + L * 0.52, hw * 0.86);
    ctx.lineTo(-hl + L * 0.44, hw * 0.70);
    ctx.lineTo(-hl + L * 0.12, hw * 0.78);
    ctx.closePath();
    ctx.fill();

    // Front fender shadows.
    ctx.fillStyle = darken(color, 0.25);
    ctx.beginPath();
    ctx.moveTo(-hl + L * 0.68, -hw * 0.84);
    ctx.quadraticCurveTo(-hl + L * 0.78, -hw * 0.88, -hl + L * 0.86, -hw * 0.92);
    ctx.lineTo(hl - L * 0.18, -hw * 0.74);
    ctx.lineTo(-hl + L * 0.62, -hw * 0.70);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(-hl + L * 0.68, hw * 0.84);
    ctx.quadraticCurveTo(-hl + L * 0.78, hw * 0.88, -hl + L * 0.86, hw * 0.92);
    ctx.lineTo(hl - L * 0.18, hw * 0.74);
    ctx.lineTo(-hl + L * 0.62, hw * 0.70);
    ctx.closePath();
    ctx.fill();

    // Rear deck plane.
    ctx.fillStyle = darken(color, 0.16);
    ctx.fillRect(-hl + L * 0.05, -hw * 0.68, hl * 0.55, hw * 1.36);

    // Hood edge shadows + long hood center crown.
    ctx.fillStyle = darken(color, 0.22);
    ctx.fillRect(hl * 0.15, -hw * 0.70, hl * 0.80, hw * 0.08);
    ctx.fillRect(hl * 0.15,  hw * 0.62, hl * 0.80, hw * 0.08);

    ctx.fillStyle = lighten(color, 0.22);
    ctx.fillRect(hl * 0.18, -hw * 0.20, hl * 0.74, hw * 0.40);

    // Roof / cabin.
    ctx.fillStyle = lighten(color, 0.20);
    ctx.fillRect(-hl * 0.18, -hw * 0.48, hl * 0.40, hw * 0.96);

    // Crown highlights on rear haunches + front fenders.
    ctx.strokeStyle = lighten(color, 0.26);
    ctx.lineWidth = 1.0;
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(-hl + L * 0.10, s * hw * 0.92);
      ctx.quadraticCurveTo(-hl + L * 0.24, s * hw * 0.96, -hl + L * 0.36, s * hw * 0.92);
      ctx.stroke();
    }
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(-hl + L * 0.72, s * hw * 0.84);
      ctx.quadraticCurveTo(-hl + L * 0.84, s * hw * 0.90, hl - L * 0.14, s * hw * 0.84);
      ctx.stroke();
    }

    // Inset rim.
    tracePath(ctx, hl, hw, L, W);
    ctx.strokeStyle = darken(color, 0.55);
    ctx.lineWidth = 1.7;
    ctx.stroke();

    // Windshield (aggressive rake).
    const wsBack = hl * 0.06;
    const wsFront = hl * 0.22;
    ctx.fillStyle = '#0a1320';
    ctx.beginPath();
    ctx.moveTo(wsBack,  -hw * 0.58);
    ctx.lineTo(wsFront, -hw * 0.42);
    ctx.lineTo(wsFront,  hw * 0.42);
    ctx.lineTo(wsBack,   hw * 0.58);
    ctx.closePath();
    ctx.fill();

    // Rear window.
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

    // Roof panel.
    ctx.fillStyle = lighten(color, 0.10);
    ctx.beginPath();
    ctx.moveTo(rwFront, -hw * 0.52);
    ctx.lineTo(wsBack,  -hw * 0.56);
    ctx.lineTo(wsBack,   hw * 0.56);
    ctx.lineTo(rwFront,  hw * 0.52);
    ctx.closePath();
    ctx.fill();

    // A-pillars.
    ctx.strokeStyle = darken(color, 0.50);
    ctx.lineWidth = 0.4;
    ctx.beginPath(); ctx.moveTo(wsBack, -hw * 0.56); ctx.lineTo(wsFront, -hw * 0.40); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(wsBack,  hw * 0.56); ctx.lineTo(wsFront,  hw * 0.40); ctx.stroke();

    // Glint.
    ctx.fillStyle = 'rgba(200,225,245,0.60)';
    ctx.fillRect(wsBack + 0.5, -hw * 0.22, (wsFront - wsBack) * 0.55, 0.65);

    // Twin hood vents (intercooler exit, near windshield base).
    ctx.fillStyle = darken(color, 0.55);
    ctx.fillRect(hl * 0.28, -hw * 0.30, L * 0.06, hw * 0.12);
    ctx.fillRect(hl * 0.28,  hw * 0.18, L * 0.06, hw * 0.12);
    ctx.fillStyle = '#101010';
    ctx.fillRect(hl * 0.29, -hw * 0.28, L * 0.04, hw * 0.08);
    ctx.fillRect(hl * 0.29,  hw * 0.20, L * 0.04, hw * 0.08);

    // Hood centerline.
    ctx.strokeStyle = darken(color, 0.35);
    ctx.lineWidth = 0.35;
    ctx.beginPath(); ctx.moveTo(hl * 0.22, 0); ctx.lineTo(hl * 0.92, 0); ctx.stroke();

    // Specular pin-dot.
    ctx.fillStyle = lighten(color, 0.52);
    ctx.fillRect(hl * 0.58, -hw * 0.05, 1.2, 0.8);

    ctx.restore(); // end clip

    // Mirrors (A-pillar mount).
    ctx.fillStyle = darken(color, 0.40);
    ctx.fillRect(hl * 0.08, -hw * 0.96 - 1.1, 1.4, 1.3);
    ctx.fillRect(hl * 0.08,  hw * 0.96 - 0.2, 1.4, 1.3);
    ctx.fillStyle = 'rgba(165,185,210,0.5)';
    ctx.fillRect(hl * 0.08 + 0.3, -hw * 0.96 - 0.9, 0.7, 0.5);
    ctx.fillRect(hl * 0.08 + 0.3,  hw * 0.96,        0.7, 0.5);

    // Rectangular projector headlights.
    const hlightX = hl - L * 0.03;
    if (nightFactor > 0.05) {
      ctx.fillStyle = '#fff5c8';
      ctx.fillRect(hlightX - 1.6, -hw * 0.65, 1.9, hw * 0.22);
      ctx.fillRect(hlightX - 1.6,  hw * 0.43, 1.9, hw * 0.22);
      const hg = 3.2 + nightFactor * 3.0;
      v2HeadlightGlow(ctx, hlightX - 0.6, -hw * 0.54, hg, nightFactor * 0.45);
      v2HeadlightGlow(ctx, hlightX - 0.6,  hw * 0.54, hg, nightFactor * 0.45);
    } else {
      ctx.fillStyle = darken(color, 0.30);
      ctx.fillRect(hlightX - 1.6, -hw * 0.65, 1.9, hw * 0.22);
      ctx.fillRect(hlightX - 1.6,  hw * 0.43, 1.9, hw * 0.22);
      ctx.strokeStyle = lighten(color, 0.3);
      ctx.lineWidth = 0.3;
      ctx.strokeRect(hlightX - 1.6, -hw * 0.65, 1.9, hw * 0.22);
      ctx.strokeRect(hlightX - 1.6,  hw * 0.43, 1.9, hw * 0.22);
    }

    // A80 signature: 3 round taillights per side in outer third (v8.99.05 fix).
    const tailX = -hl + L * 0.02;
    const tw = hw * 0.82;
    const tlBright = isBraking ? '#ff5544' : (nightFactor > 0.05 ? '#ee2a15' : '#9a2010');
    ctx.fillStyle = tlBright;
    const lampR = 0.72;
    for (const s of [-1, 1]) {
      for (let i = 0; i < 3; i++) {
        const cy = s * tw * (0.42 + i * 0.23);
        ctx.beginPath();
        ctx.arc(tailX + 0.9, cy, lampR, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    // Body-color center panel (license plate area).
    ctx.fillStyle = color;
    ctx.fillRect(tailX + 0.2, -tw * 0.30, 2.2, tw * 0.60);
    // Center chrome strip.
    ctx.fillStyle = darken(tlBright, 0.4);
    ctx.fillRect(tailX + 0.4, -0.3, 1.8, 0.6);
    // Amber turn signals (outermost corners).
    ctx.fillStyle = nightFactor > 0.05 ? '#ff9900' : '#8a4400';
    ctx.fillRect(tailX, -tw - 0.2, 1.1, 0.5);
    ctx.fillRect(tailX,  tw - 0.3, 1.1, 0.5);
    // Glow per lamp.
    if (isBraking || nightFactor > 0.05) {
      const tg = 2.5 + nightFactor * 2.0 + (isBraking ? 2.5 : 0);
      const ta = isBraking ? 0.50 : nightFactor * 0.32;
      const tc = isBraking ? '255,70,50' : '255,40,10';
      for (const s of [-1, 1]) {
        for (let i = 0; i < 3; i++) {
          const cy = s * tw * (0.42 + i * 0.23);
          v2TaillightGlow(ctx, tailX + 0.9, cy, tg, ta, tc);
        }
      }
    }

    // A80 rear wing (signature big GT wing).
    ctx.fillStyle = darken(color, 0.45);
    ctx.fillRect(-hl + L * 0.01, -hw * 0.70, 1.7, hw * 1.40);
    ctx.fillStyle = lighten(color, 0.04);
    ctx.fillRect(-hl + L * 0.01, -hw * 0.70, 0.5, hw * 1.40);
    ctx.fillStyle = darken(color, 0.65);
    ctx.fillRect(-hl + L * 0.01, -hw * 0.70, 1.7, 0.4);
    ctx.fillRect(-hl + L * 0.01,  hw * 0.66, 1.7, 0.4);
    // Wing endplates.
    ctx.fillStyle = darken(color, 0.68);
    ctx.fillRect(-hl - 0.1, -hw * 0.72, 0.5, hw * 0.14);
    ctx.fillRect(-hl - 0.1,  hw * 0.58, 0.5, hw * 0.14);

    // Reverse lights (small center dot).
    if (isReverse) {
      ctx.fillStyle = '#ffe8a0';
      ctx.fillRect(tailX + 0.3, -0.6, 1.3, 1.2);
    }

    // Outline.
    tracePath(ctx, hl, hw, L, W);
    ctx.strokeStyle = 'rgba(0,0,0,0.72)';
    ctx.lineWidth = 0.6;
    ctx.stroke();
  },
};
