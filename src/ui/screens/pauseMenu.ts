/**
 * Main pause menu — full-screen black overlay with the STATUS / JOBS
 * / RACE / CAL / OPT tab strip. Opened by tapping the top-right HUD
 * corner (tx > GW-82 && ty < 64) or gamepad START / Y. Closed by
 * tapping the same corner again, tapping the CLOSE button, gamepad
 * B, or pressing Escape.
 *
 * H192 SHELL ONLY — paints the backdrop + title + tab strip + close
 * button + a "TODO" body placeholder per tab. Tab bodies port in
 * H193+ each (STATUS / JOBS / RACE / CAL / OPT, one per commit).
 *
 * Ported from monolith L34528-34563 (shell paint) + L20992 (top-
 * right tap entry).
 */

/** Tab keys. The 'car' key name is legacy (the visible label is
 *  'STATUS' since v8.99.122.43 — the renamed tab kept the internal
 *  key for hotkey + tab-order continuity). 1:1 with monolith
 *  TAB_ORDER at L20115. */
export type MenuTab = 'car' | 'jobs' | 'race' | 'cal' | 'opt';

export const MENU_TAB_ORDER: readonly MenuTab[] = ['car', 'jobs', 'race', 'cal', 'opt'] as const;

/** Display labels for the tab strip. */
const TAB_LABELS: Record<MenuTab, string> = {
  car: 'STATUS',
  jobs: 'JOBS',
  race: 'RACE',
  cal: 'CAL',
  opt: 'OPT',
};

export interface PauseMenuState {
  open: boolean;
  tab: MenuTab;
}

export interface PauseMenuOpts {
  state: PauseMenuState;
  GW: number;
  GH: number;
}

export interface PauseMenuDeps {
  setTab(tab: MenuTab): void;
  close(): void;
}

/** Top-right HUD corner — tap target the monolith uses to OPEN the
 *  menu while playing. 1:1 with L20992 / L22078. */
export function isMenuOpenCornerHit(tx: number, ty: number, GW: number): boolean {
  return tx > GW - 82 && ty < 64;
}

/** Paints the shell. 1:1 port of monolith L34534-34563 — full-canvas
 *  black backdrop, big "DRIVER CITY" title, 5-tab strip with the
 *  selected tab highlighted cyan. Below the strip a "TAB BODY (TODO)"
 *  placeholder for H193+. */
export function drawPauseMenu(ctx: CanvasRenderingContext2D, opts: PauseMenuOpts): void {
  const { state, GW, GH } = opts;
  if (!state.open) return;

  // Full-canvas black backdrop.
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, GW, GH);

  ctx.textAlign = 'center';
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 20px monospace';
  ctx.fillText('DRIVER CITY', GW / 2, 22);

  // Tab strip — 5 evenly spaced. Cyan-highlight on the active tab,
  // dim white otherwise. 1:1 with L34552-34563.
  const tabSpacing = Math.floor(GW / 5);
  MENU_TAB_ORDER.forEach((t, i) => {
    const tx = Math.floor(tabSpacing / 2) + i * tabSpacing;
    const tw = tabSpacing - 4;
    const active = state.tab === t;
    ctx.fillStyle = active ? 'rgba(0, 200, 255, 0.2)' : 'rgba(255, 255, 255, 0.1)';
    ctx.fillRect(tx - tw / 2, 28, tw, 18);
    ctx.strokeStyle = active ? '#0ff' : '#444';
    ctx.lineWidth = 1;
    ctx.strokeRect(tx - tw / 2, 28, tw, 18);
    ctx.fillStyle = active ? '#0ff' : '#888';
    ctx.font = 'bold 9px monospace';
    ctx.fillText(TAB_LABELS[t], tx, 40);
  });

  // H192 placeholder body — each tab content ports next.
  ctx.fillStyle = '#666';
  ctx.font = 'bold 12px monospace';
  ctx.fillText(TAB_LABELS[state.tab] + ' tab — body ports in H193+', GW / 2, GH / 2);
  ctx.fillStyle = '#555';
  ctx.font = '10px monospace';
  ctx.fillText('(tap top-right corner or CLOSE to exit)', GW / 2, GH / 2 + 16);

  // CLOSE button at bottom-center.
  const cbx = GW / 2 - 50;
  const cby = GH - 40;
  ctx.fillStyle = 'rgba(255, 80, 0, 0.2)';
  ctx.fillRect(cbx, cby, 100, 24);
  ctx.strokeStyle = '#f80';
  ctx.lineWidth = 2;
  ctx.strokeRect(cbx, cby, 100, 24);
  ctx.fillStyle = '#f80';
  ctx.font = 'bold 11px monospace';
  ctx.fillText('CLOSE', GW / 2, cby + 16);
  ctx.lineWidth = 1;

  ctx.textAlign = 'left';
}

/** Tab-strip rect for tap dispatch. */
function tabRect(GW: number, i: number): { x: number; w: number } {
  const tabSpacing = Math.floor(GW / 5);
  const cx = Math.floor(tabSpacing / 2) + i * tabSpacing;
  const tw = tabSpacing - 4;
  return { x: cx - tw / 2, w: tw };
}

/** Hit-tests the tab strip + close button. Returns true when the
 *  tap was consumed (either route fired or tap landed inside the
 *  menu's canvas — the full-screen modal eats all taps). 1:1 port
 *  of the monolith's main-menu tap dispatch at L20771-20800ish for
 *  the shell parts only — tab-body hit-tests port per tab. */
export function handlePauseMenuClick(
  tx: number,
  ty: number,
  opts: PauseMenuOpts,
  deps: PauseMenuDeps,
): boolean {
  const { state, GW, GH } = opts;
  if (!state.open) return false;

  // Top-right corner tap closes the menu (same target that opens it
  // from the playing-state HUD).
  if (isMenuOpenCornerHit(tx, ty, GW)) {
    deps.close();
    return true;
  }

  // Tab strip hit (y ∈ [28, 46]).
  if (ty >= 28 && ty <= 46) {
    for (let i = 0; i < MENU_TAB_ORDER.length; i++) {
      const { x, w } = tabRect(GW, i);
      if (tx >= x && tx <= x + w) {
        deps.setTab(MENU_TAB_ORDER[i]);
        return true;
      }
    }
  }

  // CLOSE button (centered, GH-40 to GH-16).
  const cbx = GW / 2 - 50;
  const cby = GH - 40;
  if (tx >= cbx && tx <= cbx + 100 && ty >= cby && ty <= cby + 24) {
    deps.close();
    return true;
  }

  // Full-screen modal eats every tap.
  return true;
}
