/**
 * H784: runtime render-pass kill switches for performance triage.
 *
 * The highway/bridge FPS dips persisted through three JS-side fixes
 * (H770 gradient caching, H771/H783 stroke-call reduction) while the
 * perf HUD's TOTAL bucket stayed under 1 ms — the frame time lives in
 * the browser's raster/composite stage, which JS instrumentation can't
 * attribute. These switches let the user A/B the real session: stand
 * at the slow spot, kill one pass at a time (Alt+Shift+digit), and
 * watch the FPS pill. Whichever switch restores the frame rate names
 * the pass that owns the raster cost.
 *
 * Deliberately NOT persisted and NOT in the pause menu — these are
 * scaffolding for diagnosis, visible only via the OPT → Debug HUD
 * panel, and reset on every reload.
 */

export const diagKill = {
  /** Alt+Shift+1 — grass / water / buildings / parking-lot tiles. */
  terrain: false,
  /** Alt+Shift+2 — drawBaselineRoads (asphalt + all markings). */
  roads: false,
  /** Alt+Shift+3 — drawBridgeOverlays (mainCtx ×2 + pcCtx). */
  bridge: false,
  /** Alt+Shift+4 — headlight passes (player + traffic, ground+elev). */
  lights: false,
  /** Alt+Shift+5 — day/night tint composites (mainCtx + pcCtx). */
  tint: false,
  /** Alt+Shift+6 — gauge cluster + minimap on the HUD canvas. */
  hud: false,
};

const HOTKEYS: ReadonlyArray<[code: string, key: keyof typeof diagKill]> = [
  ['Digit1', 'terrain'],
  ['Digit2', 'roads'],
  ['Digit3', 'bridge'],
  ['Digit4', 'lights'],
  ['Digit5', 'tint'],
  ['Digit6', 'hud'],
];

let installed = false;

/** Install the Alt+Shift+digit listener (idempotent). */
export function initDiagKill(): void {
  if (installed) return;
  installed = true;
  window.addEventListener('keydown', (e) => {
    if (!e.altKey || !e.shiftKey) return;
    for (const [code, key] of HOTKEYS) {
      if (e.code === code) {
        diagKill[key] = !diagKill[key];
        e.preventDefault();
        return;
      }
    }
  });
}

/** One-line state summary for the Debug HUD panel, or null when every
 *  pass is live. */
export function diagKillSummary(): string | null {
  const off: string[] = [];
  for (const k of Object.keys(diagKill) as Array<keyof typeof diagKill>) {
    if (diagKill[k]) off.push(k);
  }
  return off.length > 0 ? 'KILLED: ' + off.join(',') : null;
}

// ---- H793: session-decay forensics ----------------------------------------
// The user's recording shows FPS decaying monotonically with play time
// (144 → 40 over ~45 s) while the rAF callback stays at ~0.7 ms and the
// scene varies from empty fields to interstates — so the cost lives
// outside the measured JS window. These counters discriminate between
// the remaining theories in ONE Debug-HUD screenshot:
//   raf/s   — rAF callbacks per second. If this exceeds the FPS pill,
//             the render loop has forked (N loops × cheap callbacks).
//   heap    — JS heap MB (Chrome only). Monotonic growth = leak → GC.
//   cv      — canvases in DOM + created since boot (texture growth).
//   lt      — PerformanceObserver 'longtask' ms in the last second
//             (GC pauses / main-thread stalls outside the callback).
let _rafCount = 0;
let _rafWindowStart = 0;
let _rafsPerSec = 0;
let _ltWindowMs = 0;
let _ltPerSec = 0;
let _canvasesCreated = 0;

/** Call once per gameLoop tick. Folds per-second windows. */
export function diagNoteRaf(nowMs: number): void {
  _rafCount++;
  if (_rafWindowStart === 0) _rafWindowStart = nowMs;
  if (nowMs - _rafWindowStart >= 1000) {
    _rafsPerSec = Math.round(_rafCount * 1000 / (nowMs - _rafWindowStart));
    _rafCount = 0;
    _rafWindowStart = nowMs;
    _ltPerSec = Math.round(_ltWindowMs);
    _ltWindowMs = 0;
  }
}

export function initDiagForensics(): void {
  // Count every canvas created after boot (sprite caches, bakes).
  const origCreate = document.createElement.bind(document);
  (document as { createElement: typeof document.createElement }).createElement = ((tag: string, opts?: ElementCreationOptions) => {
    if (String(tag).toLowerCase() === 'canvas') _canvasesCreated++;
    return origCreate(tag as keyof HTMLElementTagNameMap, opts);
  }) as typeof document.createElement;
  try {
    const po = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) _ltWindowMs += e.duration;
    });
    po.observe({ entryTypes: ['longtask'] });
  } catch { /* longtask unsupported — line shows lt 0 */ }
}

/** One-line forensics summary for the Debug HUD panel. */
export function diagForensicsSummary(): string {
  const mem = (performance as { memory?: { usedJSHeapSize: number } }).memory;
  const heap = mem ? Math.round(mem.usedJSHeapSize / 1048576) + 'M' : '?';
  const cv = document.getElementsByTagName('canvas').length + '+' + _canvasesCreated;
  return `raf${_rafsPerSec} heap${heap} cv${cv} lt${_ltPerSec}`;
}
