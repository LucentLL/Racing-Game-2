/**
 * Mitsubishi Lancer Evolution VI Rally (CP9A, 1999 WRC) — 4-door rally sedan.
 *
 * Distinctive features:
 *   - 4-door sedan with very boxy/angular flares (more so than Impreza)
 *   - Twin side hood vents + center scoop (NACA ducts)
 *   - Huge dual-element rear wing (Evo VI signature)
 *   - Rectangular headlights (not bugeye)
 *   - Rectangular taillights with internal divider
 *
 * Ported from monolith L38125–38359.
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
  ctx.moveTo(-hl, -hw * 0.72);
  ctx.lineTo(-hl + L * 0.03, -hw * 0.94);
  ctx.lineTo(-hl + L * 0.10, -hw);
  ctx.lineTo(-hl + L * 0.30, -hw);
  ctx.lineTo(-hl + L * 0.33, -hw * 0.94);
  ctx.lineTo(hl - L * 0.33, -hw * 0.94);
  ctx.lineTo(hl - L * 0.30, -hw);
  ctx.lineTo(hl - L * 0.12, -hw);
  ctx.lineTo(hl - L * 0.03, -hw * 0.84);
  ctx.lineTo(hl,             -hw * 0.48);
  ctx.lineTo(hl + 0.2,       -hw * 0.24);
  ctx.lineTo(hl + 0.2,        hw * 0.24);
  ctx.lineTo(hl,              hw * 0.48);
  ctx.lineTo(hl - L * 0.03,   hw * 0.84);
  ctx.lineTo(hl - L * 0.12,   hw);
  ctx.lineTo(hl - L * 0.30,   hw);
  ctx.lineTo(hl - L * 0.33,   hw * 0.94);
  ctx.lineTo(-hl + L * 0.33,  hw * 0.94);
  ctx.lineTo(-hl + L * 0.30,  hw);
  ctx.lineTo(-hl + L * 0.10,  hw);
  ctx.lineTo(-hl + L * 0.03,  hw * 0.94);
  ctx.lineTo(-hl,             hw * 0.72);
  ctx.closePath();
}

export const EVO6_RALLY: GenerationRenderer = {
  id: 'evo6_rally',

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

    // Boxy rally fender flares.
    ctx.fillStyle = darken(color, 0.26);
    ctx.fillRect(-hl + L * 0.08, -hw * 0.96, L * 0.26, hw * 0.12);
    ctx.fillRect(-hl + L * 0.08,  hw * 0.84, L * 0.26, hw * 0.12);
    ctx.fillRect(hl - L * 0.34,  -hw * 0.96, L * 0.26, hw * 0.12);
    ctx.fillRect(hl - L * 0.34,   hw * 0.84, L * 0.26, hw * 0.12);

    // Trunk deck.
    ctx.fillStyle = darken(color, 0.14);
    ctx.fillRect(-hl + L * 0.04, -hw * 0.78, hl * 0.56, hw * 1.56);

    // Hood.
    ctx.fillStyle = lighten(color, 0.14);
    ctx.fillRect(hl * 0.10, -hw * 0.56, hl * 0.84, hw * 1.12);

    // Roof.
    ctx.fillStyle = lighten(color, 0.22);
    ctx.fillRect(-hl * 0.26, -hw * 0.60, hl * 0.50, hw * 1.20);

    // Hard edge rim.
    tracePath(ctx, hl, hw, L, W);
    ctx.strokeStyle = darken(color, 0.55);
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Hood details: center scoop.
    ctx.fillStyle = darken(color, 0.55);
    ctx.fillRect(hl * 0.40, -hw * 0.14, L * 0.14, hw * 0.28);
    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(hl * 0.42, -hw * 0.11, L * 0.10, hw * 0.22);
    // Twin side hood vents (louvers).
    ctx.fillStyle = darken(color, 0.55);
    ctx.fillRect(hl * 0.28, -hw * 0.46, L * 0.08, hw * 0.14);
    ctx.fillRect(hl * 0.28,  hw * 0.32, L * 0.08, hw * 0.14);
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(hl * 0.30, -hw * 0.44, L * 0.05, hw * 0.10);
    ctx.fillRect(hl * 0.30,  hw * 0.34, L * 0.05, hw * 0.10);

    // Windshield + wipers.
    const wsBack = hl * 0.08;
    const wsFront = hl * 0.26;
    ctx.fillStyle = '#0a1320';
    ctx.beginPath();
    ctx.moveTo(wsBack,  -hw * 0.60);
    ctx.lineTo(wsFront, -hw * 0.46);
    ctx.lineTo(wsFront,  hw * 0.46);
    ctx.lineTo(wsBack,   hw * 0.60);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#222';
    ctx.lineWidth = 0.4;
    ctx.beginPath(); ctx.moveTo(wsBack + 1.2, -hw * 0.28); ctx.lineTo(wsFront - 0.5, -hw * 0.10); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(wsBack + 1.2,  hw * 0.10); ctx.lineTo(wsFront - 0.5,  hw * 0.28); ctx.stroke();

    // Rear window.
    const rwFront = -hl * 0.08;
    const rwBack  = -hl * 0.32;
    ctx.fillStyle = '#0a1320';
    ctx.beginPath();
    ctx.moveTo(rwFront, -hw * 0.54);
    ctx.lineTo(rwBack,  -hw * 0.42);
    ctx.lineTo(rwBack,   hw * 0.42);
    ctx.lineTo(rwFront,  hw * 0.54);
    ctx.closePath();
    ctx.fill();

    // Roof panel.
    ctx.fillStyle = lighten(color, 0.10);
    ctx.beginPath();
    ctx.moveTo(rwFront, -hw * 0.52);
    ctx.lineTo(wsBack,  -hw * 0.58);
    ctx.lineTo(wsBack,   hw * 0.58);
    ctx.lineTo(rwFront,  hw * 0.52);
    ctx.closePath();
    ctx.fill();

    // A-pillars.
    ctx.strokeStyle = darken(color, 0.50);
    ctx.lineWidth = 0.4;
    ctx.beginPath(); ctx.moveTo(wsBack, -hw * 0.58); ctx.lineTo(wsFront, -hw * 0.44); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(wsBack,  hw * 0.58); ctx.lineTo(wsFront,  hw * 0.44); ctx.stroke();

    // Glint.
    ctx.fillStyle = 'rgba(200,225,245,0.60)';
    ctx.fillRect(wsBack + 0.5, -hw * 0.22, (wsFront - wsBack) * 0.5, 0.6);

    // Sharp door + trunk shut lines.
    ctx.strokeStyle = darken(color, 0.40);
    ctx.lineWidth = 0.4;
    ctx.beginPath(); ctx.moveTo(hl * 0.04,  -hw * 0.92); ctx.lineTo(hl * 0.04,   hw * 0.92); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-hl * 0.32, -hw * 0.92); ctx.lineTo(-hl * 0.32,  hw * 0.92); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-hl * 0.44, -hw * 0.78); ctx.lineTo(-hl * 0.44,  hw * 0.78); ctx.stroke();

    // Specular.
    ctx.fillStyle = lighten(color, 0.50);
    ctx.fillRect(hl * 0.60, -hw * 0.02, 1.0, 0.7);

    ctx.restore(); // end clip

    // Mirrors.
    ctx.fillStyle = darken(color, 0.40);
    ctx.fillRect(hl * 0.08, -hw * 0.96 - 1.1, 1.4, 1.3);
    ctx.fillRect(hl * 0.08,  hw * 0.96 - 0.2, 1.4, 1.3);
    ctx.fillStyle = 'rgba(165,185,210,0.5)';
    ctx.fillRect(hl * 0.08 + 0.3, -hw * 0.96 - 0.9, 0.7, 0.5);
    ctx.fillRect(hl * 0.08 + 0.3,  hw * 0.96,        0.7, 0.5);

    // Rectangular headlights.
    const hlightX = hl - L * 0.03;
    if (nightFactor > 0.05) {
      ctx.fillStyle = '#fff5c8';
      ctx.fillRect(hlightX - 1.3, -hw * 0.66, 1.6, hw * 0.22);
      ctx.fillRect(hlightX - 1.3,  hw * 0.44, 1.6, hw * 0.22);
      const hg = 3.2 + nightFactor * 3.0;
      v2HeadlightGlow(ctx, hlightX - 0.5, -hw * 0.55, hg, nightFactor * 0.45);
      v2HeadlightGlow(ctx, hlightX - 0.5,  hw * 0.55, hg, nightFactor * 0.45);
    } else {
      ctx.fillStyle = darken(color, 0.25);
      ctx.fillRect(hlightX - 1.3, -hw * 0.66, 1.6, hw * 0.22);
      ctx.fillRect(hlightX - 1.3,  hw * 0.44, 1.6, hw * 0.22);
      ctx.strokeStyle = lighten(color, 0.3);
      ctx.lineWidth = 0.3;
      ctx.strokeRect(hlightX - 1.3, -hw * 0.66, 1.6, hw * 0.22);
      ctx.strokeRect(hlightX - 1.3,  hw * 0.44, 1.6, hw * 0.22);
    }

    // Evo signature taillights — rectangular with internal divider.
    const tlBright = isBraking ? '#ff5544' : (nightFactor > 0.05 ? '#ee2a15' : '#9a2010');
    ctx.fillStyle = tlBright;
    ctx.fillRect(-hl + L * 0.02, -hw * 0.88, 2.0, hw * 0.26);
    ctx.fillRect(-hl + L * 0.02,  hw * 0.62, 2.0, hw * 0.26);
    // Internal divider.
    ctx.fillStyle = darken(tlBright, 0.5);
    ctx.fillRect(-hl + L * 0.02, -hw * 0.76, 2.0, 0.4);
    ctx.fillRect(-hl + L * 0.02,  hw * 0.72, 2.0, 0.4);
    // Amber indicator.
    ctx.fillStyle = nightFactor > 0.05 ? '#ff9900' : '#8a4400';
    ctx.fillRect(-hl + L * 0.02, -hw * 0.62, 1.5, 0.5);
    ctx.fillRect(-hl + L * 0.02,  hw * 0.58, 1.5, 0.5);
    // Glow.
    if (isBraking || nightFactor > 0.05) {
      const tg = 3.0 + nightFactor * 2.5 + (isBraking ? 3 : 0);
      const ta = isBraking ? 0.55 : nightFactor * 0.35;
      const tc = isBraking ? '255,70,50' : '255,40,10';
      v2TaillightGlow(ctx, -hl + L * 0.06, -hw * 0.76, tg, ta, tc);
      v2TaillightGlow(ctx, -hl + L * 0.06,  hw * 0.74, tg, ta, tc);
    }

    // Evo VI signature huge dual-plane rear wing.
    ctx.fillStyle = darken(color, 0.48);
    ctx.fillRect(-hl + L * 0.01, -hw * 0.82, 1.8, hw * 1.64);
    ctx.fillStyle = lighten(color, 0.05);
    ctx.fillRect(-hl + L * 0.01, -hw * 0.82, 0.5, hw * 1.64);
    ctx.fillStyle = darken(color, 0.68);
    ctx.fillRect(-hl + L * 0.01, -hw * 0.82, 1.8, 0.4);
    ctx.fillRect(-hl + L * 0.01,  hw * 0.80, 1.8, 0.4);
    // Tall endplates.
    ctx.fillStyle = darken(color, 0.70);
    ctx.fillRect(-hl - 0.2, -hw * 0.82, 0.6, hw * 0.22);
    ctx.fillRect(-hl - 0.2,  hw * 0.60, 0.6, hw * 0.22);

    // Reverse lights.
    if (isReverse) {
      ctx.fillStyle = '#ffe8a0';
      ctx.fillRect(-hl + L * 0.02, -hw * 0.54, 1.8, 1.0);
      ctx.fillRect(-hl + L * 0.02,  hw * 0.44, 1.8, 1.0);
    }

    // Outline.
    tracePath(ctx, hl, hw, L, W);
    ctx.strokeStyle = 'rgba(0,0,0,0.72)';
    ctx.lineWidth = 0.6;
    ctx.stroke();
  },
};
