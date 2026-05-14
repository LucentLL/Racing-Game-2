/**
 * Mazda RX-7 FC (FC3S, 1985-1991) — full V2 sprite renderer.
 *
 * Distinctive features:
 *   - Aggressively boxy with hard corners, NO haunches (unlike FD)
 *   - Pop-up headlights
 *   - Large rectangular taillight clusters (not connected across rear)
 *   - Twin NACA hood scoops (Turbo II signature)
 *   - Front-fender-mounted mirrors (era-appropriate)
 *
 * Ported from monolith L37406–37612.
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
  ctx.lineTo(-hl + L * 0.02, -hw * 0.96);
  ctx.lineTo(-hl + L * 0.08, -hw);
  ctx.lineTo(hl - L * 0.20, -hw);
  ctx.lineTo(hl - L * 0.08, -hw * 0.95);              // fender step
  ctx.lineTo(hl - L * 0.02, -hw * 0.70);              // nose taper begins
  ctx.lineTo(hl,             -hw * 0.38);
  ctx.lineTo(hl,              hw * 0.38);
  ctx.lineTo(hl - L * 0.02,   hw * 0.70);
  ctx.lineTo(hl - L * 0.08,   hw * 0.95);
  ctx.lineTo(hl - L * 0.20,   hw);
  ctx.lineTo(-hl + L * 0.08,  hw);
  ctx.lineTo(-hl + L * 0.02,  hw * 0.96);
  ctx.lineTo(-hl,             hw * 0.72);
  ctx.closePath();
}

export const RX7_FC: GenerationRenderer = {
  id: 'rx7_fc',

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

    // Body fill.
    tracePath(ctx, hl, hw, L, W);
    ctx.fillStyle = color;
    ctx.fill();

    ctx.save();
    tracePath(ctx, hl, hw, L, W);
    ctx.clip();

    // Rear deck (trunk, slightly darker).
    ctx.fillStyle = darken(color, 0.14);
    ctx.fillRect(-hl + L * 0.02, -hw * 0.90, hl * 0.68, hw * 1.80);

    // Hood side shadows.
    ctx.fillStyle = darken(color, 0.20);
    ctx.fillRect(hl * 0.06, -hw * 0.82, hl * 0.88, hw * 0.14);
    ctx.fillRect(hl * 0.06,  hw * 0.68, hl * 0.88, hw * 0.14);

    // Hood center crown (flat-top, prep for twin scoops).
    ctx.fillStyle = lighten(color, 0.18);
    ctx.fillRect(hl * 0.08, -hw * 0.14, hl * 0.84, hw * 0.28);

    // FC signature: twin NACA hood scoops (Turbo II).
    ctx.fillStyle = darken(color, 0.60);
    ctx.fillRect(hl * 0.30, -hw * 0.35, L * 0.10, hw * 0.10);
    ctx.fillRect(hl * 0.30,  hw * 0.25, L * 0.10, hw * 0.10);
    ctx.fillStyle = '#111';
    ctx.fillRect(hl * 0.32, -hw * 0.33, L * 0.06, hw * 0.06);
    ctx.fillRect(hl * 0.32,  hw * 0.27, L * 0.06, hw * 0.06);

    // Roof / cabin crown.
    ctx.fillStyle = lighten(color, 0.15);
    ctx.fillRect(-hl * 0.20, -hw * 0.40, hl * 0.38, hw * 0.80);

    // Inset dark rim.
    tracePath(ctx, hl, hw, L, W);
    ctx.strokeStyle = darken(color, 0.55);
    ctx.lineWidth = 1.6;
    ctx.stroke();

    // Windshield — classic 80s near-vertical slope.
    const wsBack = hl * 0.10;
    const wsFront = hl * 0.22;
    ctx.fillStyle = '#0a1320';
    ctx.beginPath();
    ctx.moveTo(wsBack,  -hw * 0.65);
    ctx.lineTo(wsFront, -hw * 0.52);
    ctx.lineTo(wsFront,  hw * 0.52);
    ctx.lineTo(wsBack,   hw * 0.65);
    ctx.closePath();
    ctx.fill();

    // Rear window — large, nearly rectangular (hatchback glass).
    const rwFront = -hl * 0.04;
    const rwBack  = -hl * 0.30;
    ctx.fillStyle = '#0a1320';
    ctx.beginPath();
    ctx.moveTo(rwFront, -hw * 0.60);
    ctx.lineTo(rwBack,  -hw * 0.52);
    ctx.lineTo(rwBack,   hw * 0.52);
    ctx.lineTo(rwFront,  hw * 0.60);
    ctx.closePath();
    ctx.fill();

    // Roof panel between windows.
    ctx.fillStyle = lighten(color, 0.08);
    ctx.beginPath();
    ctx.moveTo(rwFront, -hw * 0.58);
    ctx.lineTo(wsBack,  -hw * 0.62);
    ctx.lineTo(wsBack,   hw * 0.62);
    ctx.lineTo(rwFront,  hw * 0.58);
    ctx.closePath();
    ctx.fill();

    // A-pillars.
    ctx.strokeStyle = darken(color, 0.50);
    ctx.lineWidth = 0.4;
    ctx.beginPath(); ctx.moveTo(wsBack, -hw * 0.63); ctx.lineTo(wsFront, -hw * 0.50); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(wsBack,  hw * 0.63); ctx.lineTo(wsFront,  hw * 0.50); ctx.stroke();

    // Windshield glint.
    ctx.fillStyle = 'rgba(195,220,240,0.60)';
    ctx.fillRect(wsBack + 0.5, -hw * 0.28, (wsFront - wsBack) * 0.5, 0.6);

    // FC panel lines (door + hood seams — boxy era visible).
    ctx.strokeStyle = darken(color, 0.35);
    ctx.lineWidth = 0.4;
    ctx.beginPath(); ctx.moveTo(hl * 0.06,  -hw * 0.95); ctx.lineTo(hl * 0.06,  hw * 0.95); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-hl * 0.34, -hw * 0.92); ctx.lineTo(-hl * 0.34, hw * 0.92); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(hl * 0.15, 0); ctx.lineTo(hl * 0.92, 0); ctx.stroke();

    // Specular dot on hood.
    ctx.fillStyle = lighten(color, 0.50);
    ctx.fillRect(hl * 0.58, -hw * 0.08, 1.0, 0.7);

    ctx.restore(); // end clip

    // Mirrors — front fender mount (FC era).
    ctx.fillStyle = darken(color, 0.40);
    ctx.fillRect(hl * 0.30, -hw - 1.1, 1.4, 1.3);
    ctx.fillRect(hl * 0.30,  hw - 0.2, 1.4, 1.3);
    ctx.fillStyle = 'rgba(160,185,210,0.5)';
    ctx.fillRect(hl * 0.30 + 0.3, -hw - 0.9, 0.7, 0.5);
    ctx.fillRect(hl * 0.30 + 0.3,  hw,        0.7, 0.5);

    // Pop-up headlights.
    const hlightX = hl - L * 0.05;
    if (nightFactor > 0.05) {
      ctx.fillStyle = '#fff5c8';
      ctx.fillRect(hlightX, -hw * 0.62, 1.6, 1.3);
      ctx.fillRect(hlightX,  hw * 0.62 - 1.3, 1.6, 1.3);
      const hg = 3.0 + nightFactor * 3.0;
      v2HeadlightGlow(ctx, hlightX + 0.8, -hw * 0.55, hg, nightFactor * 0.42);
      v2HeadlightGlow(ctx, hlightX + 0.8,  hw * 0.55, hg, nightFactor * 0.42);
    } else {
      ctx.strokeStyle = darken(color, 0.55);
      ctx.lineWidth = 0.4;
      ctx.strokeRect(hlightX, -hw * 0.62, 1.6, 1.1);
      ctx.strokeRect(hlightX,  hw * 0.62 - 1.1, 1.6, 1.1);
    }

    // FC signature taillights — large rectangular clusters per side
    // (NOT connected across the rear, unlike FD's full-width bar).
    const tailX = -hl + L * 0.02;
    const tw = hw * 0.88;
    const tlBright = isBraking ? '#ff5544' : (nightFactor > 0.05 ? '#ee2a15' : '#8a1a0a');
    ctx.fillStyle = tlBright;
    ctx.fillRect(tailX, -tw,             2.2, tw * 0.62);
    ctx.fillRect(tailX,  tw - tw * 0.62, 2.2, tw * 0.62);
    // Internal vertical divider (splits each cluster into inner/outer lamp).
    ctx.fillStyle = darken(tlBright, 0.4);
    ctx.fillRect(tailX, -tw * 0.55, 2.2, 0.4);
    ctx.fillRect(tailX,  tw * 0.55 - 0.4, 2.2, 0.4);
    // Amber turn indicator strip at top edge.
    ctx.fillStyle = nightFactor > 0.05 ? '#ff9900' : '#8a4400';
    ctx.fillRect(tailX, -tw,         1.4, 0.5);
    ctx.fillRect(tailX,  tw - 0.5,   1.4, 0.5);
    // Glow per cluster (2 glow sources, not 4 like FD).
    if (isBraking || nightFactor > 0.05) {
      const tg = 2.5 + nightFactor * 2.5 + (isBraking ? 3 : 0);
      const ta = isBraking ? 0.55 : nightFactor * 0.35;
      const tc = isBraking ? '255,70,50' : '255,40,10';
      for (const s of [-1, 1]) {
        v2TaillightGlow(ctx, tailX + 1, s * tw * 0.70, tg, ta, tc);
      }
    }

    // Reverse lights (inner edges of each cluster).
    if (isReverse) {
      ctx.fillStyle = '#ffe8a0';
      ctx.fillRect(tailX + 0.4, -tw * 0.45, 1.6, 1.0);
      ctx.fillRect(tailX + 0.4,  tw * 0.35, 1.6, 1.0);
    }

    // Outer silhouette outline.
    tracePath(ctx, hl, hw, L, W);
    ctx.strokeStyle = 'rgba(0,0,0,0.75)';
    ctx.lineWidth = 0.7;
    ctx.stroke();
  },
};
