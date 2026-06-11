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
