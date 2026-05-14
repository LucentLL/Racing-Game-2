/**
 * Ford Focus WRC (1999-2004) — 5-door rally hatchback.
 *
 * Distinctive features:
 *   - Boxy hatchback profile, short rear overhang
 *   - Roof rails along each side
 *   - Central hood scoop (intercooler)
 *   - Round rally driving lights at front
 *   - Vertical L-shaped taillights wrapping corner of quarter panel
 *   - Tall rear spoiler (Gurney flap)
 *
 * Ported from monolith L37626–37870.
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
  ctx.moveTo(-hl, -hw * 0.82);
  ctx.lineTo(-hl + L * 0.02, -hw * 0.98);
  ctx.lineTo(-hl + L * 0.06, -hw);
  ctx.lineTo(hl - L * 0.12, -hw);
  ctx.lineTo(hl - L * 0.04, -hw * 0.92);
  ctx.quadraticCurveTo(hl, -hw * 0.64, hl, -hw * 0.34);
  ctx.quadraticCurveTo(hl + 0.2, -hw * 0.12, hl + 0.2, 0);
  ctx.quadraticCurveTo(hl + 0.2, hw * 0.12, hl, hw * 0.34);
  ctx.quadraticCurveTo(hl, hw * 0.64, hl - L * 0.04, hw * 0.92);
  ctx.lineTo(hl - L * 0.12, hw);
  ctx.lineTo(-hl + L * 0.06, hw);
  ctx.lineTo(-hl + L * 0.02, hw * 0.98);
  ctx.lineTo(-hl, hw * 0.82);
  ctx.closePath();
}

export const FOCUS_WRC: GenerationRenderer = {
  id: 'focus_wrc',

  render(ctx, L, W, color, opts) {
    const hl = L / 2;
    const hw = W / 2;
    const { isBraking, nightFactor, isReverse, steerAngle, isXray } = opts;
    const axle: readonly [number, number] = [0.58, 0.52];

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

    // Rally fender flares (rear-left, rear-right, front-left, front-right).
    ctx.fillStyle = darken(color, 0.24);
    ctx.fillRect(-hl + L * 0.04, -hw * 0.94, L * 0.30, hw * 0.18);
    ctx.fillRect(-hl + L * 0.04,  hw * 0.76, L * 0.30, hw * 0.18);
    ctx.fillRect(hl - L * 0.32,  -hw * 0.94, L * 0.28, hw * 0.18);
    ctx.fillRect(hl - L * 0.32,   hw * 0.76, L * 0.28, hw * 0.18);

    // Hood crown.
    ctx.fillStyle = lighten(color, 0.18);
    ctx.fillRect(hl * 0.08, -hw * 0.36, hl * 0.84, hw * 0.72);

    // Rear deck / hatch area.
    ctx.fillStyle = darken(color, 0.14);
    ctx.fillRect(-hl + L * 0.04, -hw * 0.72, hl * 0.64, hw * 1.44);

    // Roof (lightest).
    ctx.fillStyle = lighten(color, 0.22);
    ctx.fillRect(-hl * 0.28, -hw * 0.60, hl * 0.56, hw * 1.20);

    // Inset edge.
    tracePath(ctx, hl, hw, L, W);
    ctx.strokeStyle = darken(color, 0.55);
    ctx.lineWidth = 1.6;
    ctx.stroke();

    // Hood scoop (intercooler).
    ctx.fillStyle = darken(color, 0.55);
    ctx.fillRect(hl * 0.48, -hw * 0.18, L * 0.12, hw * 0.36);
    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(hl * 0.50, -hw * 0.15, L * 0.08, hw * 0.30);
    ctx.strokeStyle = lighten(color, 0.3);
    ctx.lineWidth = 0.3;
    ctx.strokeRect(hl * 0.48, -hw * 0.18, L * 0.12, hw * 0.36);

    // Windshield.
    const wsBack = hl * 0.14;
    const wsFront = hl * 0.32;
    ctx.fillStyle = '#0a1320';
    ctx.beginPath();
    ctx.moveTo(wsBack,  -hw * 0.58);
    ctx.lineTo(wsFront, -hw * 0.44);
    ctx.lineTo(wsFront,  hw * 0.44);
    ctx.lineTo(wsBack,   hw * 0.58);
    ctx.closePath();
    ctx.fill();
    // Wipers.
    ctx.strokeStyle = '#222';
    ctx.lineWidth = 0.4;
    ctx.beginPath(); ctx.moveTo(wsBack + 1.5, -hw * 0.30); ctx.lineTo(wsFront - 0.5, -hw * 0.12); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(wsBack + 1.5,  hw * 0.10); ctx.lineTo(wsFront - 0.5,  hw * 0.28); ctx.stroke();

    // Rear hatch glass.
    const rwFront = -hl * 0.10;
    const rwBack  = -hl * 0.36;
    ctx.fillStyle = '#0a1320';
    ctx.beginPath();
    ctx.moveTo(rwFront, -hw * 0.58);
    ctx.lineTo(rwBack,  -hw * 0.52);
    ctx.lineTo(rwBack,   hw * 0.52);
    ctx.lineTo(rwFront,  hw * 0.58);
    ctx.closePath();
    ctx.fill();
    // Rear wiper (single arm).
    ctx.strokeStyle = '#222';
    ctx.lineWidth = 0.4;
    ctx.beginPath();
    ctx.moveTo(rwFront - 0.5, 0);
    ctx.lineTo(rwBack + 1, hw * 0.35);
    ctx.stroke();

    // Cabin center band.
    ctx.fillStyle = lighten(color, 0.10);
    ctx.fillRect(rwFront - 0.2, -hw * 0.54, wsBack - rwFront + 0.4, hw * 1.08);

    // Roof rails — hatchback signature.
    ctx.strokeStyle = darken(color, 0.60);
    ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(rwFront, -hw * 0.82); ctx.lineTo(wsBack, -hw * 0.82); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(rwFront,  hw * 0.82); ctx.lineTo(wsBack,  hw * 0.82); ctx.stroke();

    // A-pillars.
    ctx.strokeStyle = darken(color, 0.50);
    ctx.lineWidth = 0.4;
    ctx.beginPath(); ctx.moveTo(wsBack, -hw * 0.56); ctx.lineTo(wsFront, -hw * 0.42); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(wsBack,  hw * 0.56); ctx.lineTo(wsFront,  hw * 0.42); ctx.stroke();

    // Glint.
    ctx.fillStyle = 'rgba(200,225,245,0.60)';
    ctx.fillRect(wsBack + 0.6, -hw * 0.24, (wsFront - wsBack) * 0.5, 0.6);

    // Door shut lines.
    ctx.strokeStyle = darken(color, 0.35);
    ctx.lineWidth = 0.35;
    ctx.beginPath(); ctx.moveTo(hl * 0.08, -hw * 0.92); ctx.lineTo(hl * 0.08,  hw * 0.92); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-hl * 0.34, -hw * 0.92); ctx.lineTo(-hl * 0.34, hw * 0.92); ctx.stroke();

    // Specular on hood.
    ctx.fillStyle = lighten(color, 0.50);
    ctx.fillRect(hl * 0.30, -hw * 0.04, 1.2, 0.8);

    ctx.restore(); // end clip

    // Mirrors.
    ctx.fillStyle = darken(color, 0.40);
    ctx.fillRect(hl * 0.12, -hw * 0.98 - 1.1, 1.4, 1.3);
    ctx.fillRect(hl * 0.12,  hw * 0.98 - 0.2, 1.4, 1.3);
    ctx.fillStyle = 'rgba(165,185,210,0.5)';
    ctx.fillRect(hl * 0.12 + 0.3, -hw * 0.98 - 0.9, 0.7, 0.5);
    ctx.fillRect(hl * 0.12 + 0.3,  hw * 0.98,        0.7, 0.5);

    // Round rally headlights + driving light pods.
    const hlightX = hl - L * 0.04;
    if (nightFactor > 0.05) {
      ctx.fillStyle = '#fff5c8';
      ctx.beginPath(); ctx.arc(hlightX, -hw * 0.55, 1.1, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(hlightX,  hw * 0.55, 1.1, 0, Math.PI * 2); ctx.fill();
      // Driving light pods (lower, on grille area).
      ctx.fillStyle = '#fff8d8';
      ctx.beginPath(); ctx.arc(hlightX - 0.5, -hw * 0.22, 0.8, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(hlightX - 0.5,  hw * 0.22, 0.8, 0, Math.PI * 2); ctx.fill();
      const hg = 3.0 + nightFactor * 3.0;
      v2HeadlightGlow(ctx, hlightX, -hw * 0.55, hg, nightFactor * 0.42);
      v2HeadlightGlow(ctx, hlightX,  hw * 0.55, hg, nightFactor * 0.42);
      v2HeadlightGlow(ctx, hlightX - 0.5, -hw * 0.22, hg * 0.7, nightFactor * 0.35);
      v2HeadlightGlow(ctx, hlightX - 0.5,  hw * 0.22, hg * 0.7, nightFactor * 0.35);
    } else {
      ctx.fillStyle = darken(color, 0.25);
      ctx.beginPath(); ctx.arc(hlightX, -hw * 0.55, 1.1, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(hlightX,  hw * 0.55, 1.1, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = lighten(color, 0.3);
      ctx.lineWidth = 0.3;
      ctx.beginPath(); ctx.arc(hlightX, -hw * 0.55, 1.1, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.arc(hlightX,  hw * 0.55, 1.1, 0, Math.PI * 2); ctx.stroke();
      // Off-state driving light pods.
      ctx.fillStyle = darken(color, 0.50);
      ctx.beginPath(); ctx.arc(hlightX - 0.5, -hw * 0.22, 0.7, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(hlightX - 0.5,  hw * 0.22, 0.7, 0, Math.PI * 2); ctx.fill();
    }

    // Focus signature: L-shaped vertical taillights wrapping corner.
    const tlBright = isBraking ? '#ff5544' : (nightFactor > 0.05 ? '#ee2a15' : '#9a2010');
    ctx.fillStyle = tlBright;
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(-hl + L * 0.005, s * hw * 0.86);
      ctx.lineTo(-hl + L * 0.06,  s * hw * 0.98);
      ctx.lineTo(-hl + L * 0.20,  s * hw);
      ctx.lineTo(-hl + L * 0.22,  s * hw * 0.82);
      ctx.lineTo(-hl + L * 0.04,  s * hw * 0.78);
      ctx.closePath();
      ctx.fill();
    }
    // Inner divider line.
    ctx.strokeStyle = darken(tlBright, 0.4);
    ctx.lineWidth = 0.4;
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(-hl + L * 0.06, s * hw * 0.96);
      ctx.lineTo(-hl + L * 0.18, s * hw * 0.86);
      ctx.stroke();
    }
    if (isBraking || nightFactor > 0.05) {
      const tg = 3.0 + nightFactor * 2.5 + (isBraking ? 3 : 0);
      const ta = isBraking ? 0.55 : nightFactor * 0.35;
      const tc = isBraking ? '255,70,50' : '255,40,10';
      for (const s of [-1, 1]) {
        v2TaillightGlow(ctx, -hl + L * 0.10, s * hw * 0.90, tg, ta, tc);
      }
    }
    // Amber turn signal at outer corner.
    ctx.fillStyle = nightFactor > 0.05 ? '#ff9900' : '#8a4400';
    ctx.fillRect(-hl + L * 0.06, -hw * 1.0,       1.0, 0.5);
    ctx.fillRect(-hl + L * 0.06,  hw * 1.0 - 0.5, 1.0, 0.5);

    // Tall rear spoiler.
    ctx.fillStyle = darken(color, 0.55);
    ctx.fillRect(-hl + L * 0.01, -hw * 0.62, 1.8, hw * 1.24);
    ctx.fillStyle = darken(color, 0.30);
    ctx.fillRect(-hl + L * 0.01, -hw * 0.62, 0.5, hw * 1.24);
    ctx.fillStyle = darken(color, 0.70);
    ctx.fillRect(-hl + L * 0.01, -hw * 0.64, 1.8, 0.4);
    ctx.fillRect(-hl + L * 0.01,  hw * 0.60, 1.8, 0.4);

    // Reverse lights.
    if (isReverse) {
      ctx.fillStyle = '#ffe8a0';
      ctx.fillRect(-hl + L * 0.06, -hw * 0.80, 1.2, 0.9);
      ctx.fillRect(-hl + L * 0.06,  hw * 0.78, 1.2, 0.9);
    }

    // Outline.
    tracePath(ctx, hl, hw, L, W);
    ctx.strokeStyle = 'rgba(0,0,0,0.72)';
    ctx.lineWidth = 0.6;
    ctx.stroke();
  },
};
