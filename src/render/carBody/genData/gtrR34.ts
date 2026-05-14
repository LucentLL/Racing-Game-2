/**
 * Nissan Skyline GT-R R34 (BNR34, 1999-2002) — full V2 sprite renderer.
 *
 * Distinctive features:
 *   - Angular, boxy 2-door coupe (even boxier than R33)
 *   - Twin round headlights per side (4 circles total)
 *   - Hood intercooler bulge with NACA-style vents
 *   - 4 round taillights per side in 2x2 grid (iconic GT-R signature)
 *   - Big rear wing with carbon end plates
 *
 * Ported from monolith L38875–39106.
 *
 * NOTE: This renderer is also aliased to a dozen other generation keys
 * (gtr_r34_vspec, nsx_na, silvia_180sx, miata_na, dodge_viper, etc.) —
 * see index.ts. Those keys are placeholders: their real visuals come from
 * PNG sprites loaded via VEHICLE_IMAGE_MANIFEST, and this vector fallback
 * only runs in the brief window before the PNG finishes loading.
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
  ctx.moveTo(-hl, -hw * 0.70);
  ctx.lineTo(-hl + L * 0.03, -hw * 0.94);
  ctx.lineTo(-hl + L * 0.10, -hw);
  ctx.lineTo(hl - L * 0.16, -hw);
  ctx.lineTo(hl - L * 0.06, -hw * 0.98);
  ctx.lineTo(hl - L * 0.01, -hw * 0.90);
  ctx.lineTo(hl,             -hw * 0.82);
  ctx.lineTo(hl,              hw * 0.82);
  ctx.lineTo(hl - L * 0.01,   hw * 0.90);
  ctx.lineTo(hl - L * 0.06,   hw * 0.98);
  ctx.lineTo(hl - L * 0.16,   hw);
  ctx.lineTo(-hl + L * 0.10,  hw);
  ctx.lineTo(-hl + L * 0.03,  hw * 0.94);
  ctx.lineTo(-hl,             hw * 0.70);
  ctx.closePath();
}

export const GTR_R34: GenerationRenderer = {
  id: 'gtr_r34',

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

    // Wide fender flares.
    ctx.fillStyle = darken(color, 0.24);
    ctx.fillRect(-hl + L * 0.08, -hw * 0.96, L * 0.22, hw * 0.14);
    ctx.fillRect(-hl + L * 0.08,  hw * 0.82, L * 0.22, hw * 0.14);
    ctx.fillRect(hl - L * 0.30,  -hw * 0.96, L * 0.22, hw * 0.14);
    ctx.fillRect(hl - L * 0.30,   hw * 0.82, L * 0.22, hw * 0.14);

    // Rear deck.
    ctx.fillStyle = darken(color, 0.15);
    ctx.fillRect(-hl + L * 0.04, -hw * 0.76, hl * 0.58, hw * 1.52);

    // Hood edge shadows.
    ctx.fillStyle = darken(color, 0.22);
    ctx.fillRect(hl * 0.12, -hw * 0.80, hl * 0.78, hw * 0.14);
    ctx.fillRect(hl * 0.12,  hw * 0.66, hl * 0.78, hw * 0.14);

    // Hood center crown.
    ctx.fillStyle = lighten(color, 0.18);
    ctx.fillRect(hl * 0.14, -hw * 0.22, hl * 0.76, hw * 0.44);

    // Roof.
    ctx.fillStyle = lighten(color, 0.22);
    ctx.fillRect(-hl * 0.22, -hw * 0.50, hl * 0.44, hw * 1.00);

    // Inset rim.
    tracePath(ctx, hl, hw, L, W);
    ctx.strokeStyle = darken(color, 0.55);
    ctx.lineWidth = 1.6;
    ctx.stroke();

    // Windshield.
    const wsBack = hl * 0.10;
    const wsFront = hl * 0.24;
    ctx.fillStyle = '#0a1320';
    ctx.beginPath();
    ctx.moveTo(wsBack,  -hw * 0.58);
    ctx.lineTo(wsFront, -hw * 0.44);
    ctx.lineTo(wsFront,  hw * 0.44);
    ctx.lineTo(wsBack,   hw * 0.58);
    ctx.closePath();
    ctx.fill();

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
    ctx.lineTo(wsBack,  -hw * 0.56);
    ctx.lineTo(wsBack,   hw * 0.56);
    ctx.lineTo(rwFront,  hw * 0.52);
    ctx.closePath();
    ctx.fill();

    // A-pillars.
    ctx.strokeStyle = darken(color, 0.50);
    ctx.lineWidth = 0.4;
    ctx.beginPath(); ctx.moveTo(wsBack, -hw * 0.56); ctx.lineTo(wsFront, -hw * 0.42); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(wsBack,  hw * 0.56); ctx.lineTo(wsFront,  hw * 0.42); ctx.stroke();

    // Glint.
    ctx.fillStyle = 'rgba(200,225,245,0.60)';
    ctx.fillRect(wsBack + 0.5, -hw * 0.22, (wsFront - wsBack) * 0.5, 0.6);

    // R34 hood intercooler bulge.
    ctx.fillStyle = darken(color, 0.20);
    ctx.fillRect(hl * 0.25, -hw * 0.16, L * 0.24, hw * 0.32);
    ctx.strokeStyle = darken(color, 0.45);
    ctx.lineWidth = 0.4;
    ctx.strokeRect(hl * 0.25, -hw * 0.16, L * 0.24, hw * 0.32);
    // NACA-style vents on the bulge.
    ctx.fillStyle = darken(color, 0.60);
    ctx.fillRect(hl * 0.30, -hw * 0.12, L * 0.06, hw * 0.08);
    ctx.fillRect(hl * 0.30,  hw * 0.04, L * 0.06, hw * 0.08);
    ctx.fillRect(hl * 0.42, -hw * 0.12, L * 0.06, hw * 0.08);
    ctx.fillRect(hl * 0.42,  hw * 0.04, L * 0.06, hw * 0.08);

    // Door panel seams.
    ctx.strokeStyle = darken(color, 0.38);
    ctx.lineWidth = 0.4;
    ctx.beginPath(); ctx.moveTo(hl * 0.06,  -hw * 0.92); ctx.lineTo(hl * 0.06,   hw * 0.92); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-hl * 0.30, -hw * 0.92); ctx.lineTo(-hl * 0.30,  hw * 0.92); ctx.stroke();

    // Specular.
    ctx.fillStyle = lighten(color, 0.50);
    ctx.fillRect(hl * 0.60, -hw * 0.04, 1.1, 0.8);

    ctx.restore(); // end clip

    // Mirrors.
    ctx.fillStyle = darken(color, 0.40);
    ctx.fillRect(hl * 0.08, -hw - 1.1, 1.4, 1.3);
    ctx.fillRect(hl * 0.08,  hw - 0.2, 1.4, 1.3);
    ctx.fillStyle = 'rgba(165,185,210,0.5)';
    ctx.fillRect(hl * 0.08 + 0.3, -hw - 0.9, 0.7, 0.5);
    ctx.fillRect(hl * 0.08 + 0.3,  hw,        0.7, 0.5);

    // R34 headlights — twin round per side (4 total).
    const hlightX = hl - L * 0.03;
    if (nightFactor > 0.05) {
      ctx.fillStyle = '#fff5c8';
      ctx.beginPath(); ctx.arc(hlightX - 0.4, -hw * 0.68, 0.9, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(hlightX - 1.8, -hw * 0.68, 0.9, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(hlightX - 0.4,  hw * 0.68, 0.9, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(hlightX - 1.8,  hw * 0.68, 0.9, 0, Math.PI * 2); ctx.fill();
      const hg = 2.8 + nightFactor * 2.8;
      v2HeadlightGlow(ctx, hlightX - 1.1, -hw * 0.68, hg, nightFactor * 0.4);
      v2HeadlightGlow(ctx, hlightX - 1.1,  hw * 0.68, hg, nightFactor * 0.4);
    } else {
      ctx.fillStyle = darken(color, 0.28);
      ctx.beginPath(); ctx.arc(hlightX - 0.4, -hw * 0.68, 0.9, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(hlightX - 1.8, -hw * 0.68, 0.9, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(hlightX - 0.4,  hw * 0.68, 0.9, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(hlightX - 1.8,  hw * 0.68, 0.9, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = lighten(color, 0.3);
      ctx.lineWidth = 0.3;
      for (const s of [-1, 1]) {
        for (const ox of [-0.4, -1.8]) {
          ctx.beginPath(); ctx.arc(hlightX + ox, s * hw * 0.68, 0.9, 0, Math.PI * 2); ctx.stroke();
        }
      }
    }

    // R34 signature — 4 round taillights per side in 2x2 grid.
    const tailX = -hl + L * 0.02;
    const tw = hw * 0.82;
    const tlBright = isBraking ? '#ff5544' : (nightFactor > 0.05 ? '#ee2a15' : '#9a2010');
    ctx.fillStyle = tlBright;
    const lampR = 0.85;
    for (const s of [-1, 1]) {
      ctx.beginPath(); ctx.arc(tailX + 0.6, s * (tw - 0.6), lampR,        0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(tailX + 2.0, s * (tw - 0.6), lampR,        0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(tailX + 0.6, s * (tw - 2.5), lampR * 0.85, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(tailX + 2.0, s * (tw - 2.5), lampR * 0.85, 0, Math.PI * 2); ctx.fill();
    }
    // License-plate panel.
    ctx.fillStyle = color;
    ctx.fillRect(tailX + 0.2, -tw * 0.20, 2.4, tw * 0.40);
    // Amber turn signal.
    ctx.fillStyle = nightFactor > 0.05 ? '#ff9900' : '#8a4400';
    ctx.fillRect(tailX, -tw - 0.2, 1.0, 0.5);
    ctx.fillRect(tailX,  tw - 0.3, 1.0, 0.5);
    // Glow.
    if (isBraking || nightFactor > 0.05) {
      const tg = 2.5 + nightFactor * 2.0 + (isBraking ? 2.5 : 0);
      const ta = isBraking ? 0.50 : nightFactor * 0.32;
      const tc = isBraking ? '255,70,50' : '255,40,10';
      for (const s of [-1, 1]) {
        v2TaillightGlow(ctx, tailX + 1.3, s * (tw - 0.6), tg,       ta,       tc);
        v2TaillightGlow(ctx, tailX + 1.3, s * (tw - 2.5), tg * 0.9, ta * 0.9, tc);
      }
    }

    // R34 big rear wing with carbon end plates.
    ctx.fillStyle = darken(color, 0.50);
    ctx.fillRect(-hl + L * 0.01, -hw * 0.76, 1.7, hw * 1.52);
    ctx.fillStyle = lighten(color, 0.05);
    ctx.fillRect(-hl + L * 0.01, -hw * 0.76, 0.5, hw * 1.52);
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(-hl - 0.2, -hw * 0.78, 0.5, hw * 0.18);
    ctx.fillRect(-hl - 0.2,  hw * 0.60, 0.5, hw * 0.18);

    // Reverse.
    if (isReverse) {
      ctx.fillStyle = '#ffe8a0';
      ctx.fillRect(tailX + 0.3, -0.8, 2.0, 1.6);
    }

    // Outline.
    tracePath(ctx, hl, hw, L, W);
    ctx.strokeStyle = 'rgba(0,0,0,0.72)';
    ctx.lineWidth = 0.6;
    ctx.stroke();
  },
};
