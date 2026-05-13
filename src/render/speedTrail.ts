/**
 * Akira taillight trail. At night, vehicles moving at 80 mph+ emit a
 * dual-taillight (or single-center for bikes) glow trail behind them.
 * The trail layers on top of the vehicle body so the newest tip visually
 * connects to the taillights.
 *
 * Ported from render() L31861–31900. The emit side (pushing to the
 * `speedTrail` ring) lives in physics/movement.ts (C22).
 */

import type { FrameView } from './types';

/** One trail sample. */
export interface TrailSample {
  /** World-pixel position of the vehicle pivot at this sample. */
  x: number;
  y: number;
  /** Vehicle heading angle (radians). */
  a: number;
  /** Half-width — taillight separation per side. <1 = bike (single center). */
  hw: number;
  /** True if this is a bike (single center trail instead of dual). */
  bk: boolean;
  /** True if brakes were applied at this sample (wider, brighter red flare). */
  brk: boolean;
}

export interface SpeedTrailDeps {
  /** Mutable ring buffer of trail samples. */
  speedTrail: ReadonlyArray<TrailSample>;
  /** True if the current time slot is 'night'. */
  isNight: boolean;
}

export function drawSpeedTrail(
  ctx: CanvasRenderingContext2D,
  _view: FrameView,
  deps: SpeedTrailDeps,
): void {
  if (!deps.isNight) return;
  const trail = deps.speedTrail;
  if (trail.length <= 2) return;

  for (let i = 0; i < trail.length - 1; i++) {
    const t0 = trail[i];
    const t1 = trail[i + 1];
    const frac = i / trail.length;
    const brkBoost = t1.brk ? 1.8 : 1.0;
    const alpha = frac * 0.45 * brkBoost;
    const w = (0.5 + frac * 1.5) * brkBoost;

    if (t1.bk || t1.hw < 1) {
      // Single center trail (bike).
      ctx.strokeStyle = `rgba(255,0,0,${Math.min(1, alpha)})`;
      ctx.lineWidth = w;
      ctx.beginPath();
      ctx.moveTo(t0.x, t0.y);
      ctx.lineTo(t1.x, t1.y);
      ctx.stroke();
      if (t1.brk) {
        ctx.strokeStyle = `rgba(255,20,20,${alpha * 0.25})`;
        ctx.lineWidth = w * 2.5;
        ctx.beginPath();
        ctx.moveTo(t0.x, t0.y);
        ctx.lineTo(t1.x, t1.y);
        ctx.stroke();
      }
    } else {
      // Dual taillight trails (car).
      const perp0x = -Math.sin(t0.a);
      const perp0y =  Math.cos(t0.a);
      const perp1x = -Math.sin(t1.a);
      const perp1y =  Math.cos(t1.a);
      for (const s of [-1, 1]) {
        const x0 = t0.x + perp0x * t0.hw * s;
        const y0 = t0.y + perp0y * t0.hw * s;
        const x1 = t1.x + perp1x * t1.hw * s;
        const y1 = t1.y + perp1y * t1.hw * s;
        ctx.strokeStyle = `rgba(255,0,0,${Math.min(1, alpha)})`;
        ctx.lineWidth = w * 0.8;
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
        if (t1.brk) {
          ctx.strokeStyle = `rgba(255,20,20,${alpha * 0.2})`;
          ctx.lineWidth = w * 2;
          ctx.beginPath();
          ctx.moveTo(x0, y0);
          ctx.lineTo(x1, y1);
          ctx.stroke();
        }
      }
    }
  }
}
