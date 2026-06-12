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

/** H782: wall-clock anchor for the current frame, set by markFrameStart
 *  at the top of the raf callback and read by endPerfFrame to derive
 *  the "other" bucket (= total frame time minus the sum of tracked
 *  phases). When most of the 16 ms frame budget is in code that no
 *  perfTime() wraps, "other" becomes the largest line in the Debug HUD
 *  and tells the user exactly where to look — instead of seeing
 *  "grass 0.4ms / phys 0.1ms" and wondering where 15 ms went. */
let frameStartMs = 0;

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

/** H782: call at the top of the raf callback to anchor wall-clock time
 *  so endPerfFrame can derive total + other. Safe to call before any
 *  perfTime() in the same frame. */
export function markFrameStart(): void {
  frameStartMs = performance.now();
}

/** Fold this frame's pending ms into each phase's EMA, then reset.
 *  H782: also folds two derived buckets — `total` (the full raf
 *  callback wall-clock) and `other` (total minus sum-of-phases) — so
 *  the Debug HUD can show how much frame time is in unwrapped code
 *  (GC pauses, browser composition, HUD draws that aren't behind a
 *  perfTime). When `other` dwarfs every named phase, the next perf
 *  hop is wrapping more of the gameLoop, not optimizing the lines
 *  that already show up. */
export function endPerfFrame(): void {
  let sumPending = 0;
  for (const s of stats.values()) {
    if (s !== _totalRef && s !== _otherRef) sumPending += s.pending;
    s.ema = s.ema * (1 - EMA_ALPHA) + s.pending * EMA_ALPHA;
    s.pending = 0;
  }
  if (frameStartMs > 0) {
    const total = performance.now() - frameStartMs;
    if (!_totalRef) {
      _totalRef = { pending: 0, ema: 0 };
      stats.set('TOTAL', _totalRef);
    }
    if (!_otherRef) {
      _otherRef = { pending: 0, ema: 0 };
      stats.set('other', _otherRef);
    }
    _totalRef.ema = _totalRef.ema * (1 - EMA_ALPHA) + total * EMA_ALPHA;
    const other = Math.max(0, total - sumPending);
    _otherRef.ema = _otherRef.ema * (1 - EMA_ALPHA) + other * EMA_ALPHA;
    frameStartMs = 0;
  }
}

let _totalRef: PhaseStats | null = null;
let _otherRef: PhaseStats | null = null;

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
