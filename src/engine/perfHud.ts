/**
 * H664: per-phase timing accumulator for the FPS HUD. Lets the user
 * see WHICH draw pass is eating frame time instead of just the FPS
 * number. Without this every perf hop is guess-and-check; with it
 * the slowest phase is sitting right above the FPS pill.
 *
 * Usage from gameLoop:
 *   import { time, endPerfFrame, perfReport } from '@/engine/perfHud';
 *   time('roads', () => drawBaselineRoads(...));
 *   ...
 *   endPerfFrame();
 *   // later in HUD draw:
 *   for (const line of perfReport()) hctx.fillText(line, x, y);
 *
 * Internals: each phase has an exponential moving average over the
 * last ~30 frames (alpha = 0.1). Frame-local ms accumulates inside
 * `time()` and folds into the EMA when `endPerfFrame()` fires. Out-
 * of-band — the HUD reads the EMAs, which are stable enough to be
 * readable at 60 fps.
 */

const EMA_ALPHA = 0.1;

interface PhaseStats {
  /** Frame-local ms accumulated by `time()` since the last endPerfFrame. */
  pending: number;
  /** Exponential moving average of pending across recent frames (ms). */
  ema: number;
}

const stats = new Map<string, PhaseStats>();

/** Wrap a synchronous draw call to accumulate its ms into the named
 *  phase bucket. performance.now() runs at sub-ms resolution in
 *  modern browsers; total overhead per call is on the order of 1 µs
 *  so wrapping every world-draw is fine. */
export function time<T>(phase: string, fn: () => T): T {
  const t0 = performance.now();
  try {
    return fn();
  } finally {
    const dt = performance.now() - t0;
    let s = stats.get(phase);
    if (!s) {
      s = { pending: 0, ema: 0 };
      stats.set(phase, s);
    }
    s.pending += dt;
  }
}

/** Fold this frame's pending ms into each phase's EMA, then reset. */
export function endPerfFrame(): void {
  for (const s of stats.values()) {
    s.ema = s.ema * (1 - EMA_ALPHA) + s.pending * EMA_ALPHA;
    s.pending = 0;
  }
}

/** Returns the top phases by EMA ms, formatted "name 12.3ms".
 *  Sorted descending so the worst offender is line 0. */
export function perfReport(topN: number = 6): string[] {
  const sorted: Array<[string, number]> = [];
  for (const [name, s] of stats) {
    if (s.ema >= 0.05) sorted.push([name, s.ema]);
  }
  sorted.sort((a, b) => b[1] - a[1]);
  const out: string[] = [];
  for (let i = 0; i < Math.min(topN, sorted.length); i++) {
    const [name, ms] = sorted[i];
    out.push(`${name.padEnd(7)} ${ms.toFixed(1)}ms`);
  }
  return out;
}
