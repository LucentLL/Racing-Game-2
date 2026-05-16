/**
 * Main pause menu — full-screen black overlay with the STATUS / JOBS
 * / RACE / CAL / OPT tab strip. Opened by tapping the top-right HUD
 * corner (tx > GW-82 && ty < 64) or gamepad START / Y. Closed by
 * tapping the same corner again, tapping the CLOSE button, gamepad
 * B, or pressing Escape.
 *
 * Ported from monolith L34528-34563 (shell paint) + L20992 (top-
 * right tap entry).
 *
 * Tab-body progress: H193 STATUS (player block) done; vehicle block
 * + SWITCH CAR pending in H194. JOBS / RACE / CAL / OPT pending.
 */
import type { LifeState } from '@/state/life';
import { getHealthStatus, getFitnessStatus } from '@/sim/health';

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
  /** LIFE — null pre-playing-state. Tab bodies that need LIFE
   *  fall through to the placeholder when null. */
  life: LifeState | null;
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

  // Tab-body dispatch. The monolith branches on `menuTab` inside
  // the same drawPlaying block at L34566+; we mirror that with one
  // helper per tab. Bodies that need LIFE early-return to the
  // placeholder for pre-playing-state opens (shouldn't happen in
  // practice — the open-tap guard requires gameState='playing' —
  // but defensive).
  const cy = 56; // monolith L34565 — first content y below the tab strip
  if (state.tab === 'car' && opts.life) {
    drawStatusTab(ctx, opts.life, GW, GH, cy);
  } else {
    drawTabPlaceholder(ctx, state.tab, GW, GH);
  }

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

/** H193: STATUS tab — player block (portrait + alias/age/job/money +
 *  Health + Fitness bars + hunger/sleep warnings + divider). Vehicle
 *  block (sprite preview, condition specs, faults, SWITCH CAR
 *  button) ports in H194.
 *
 *  1:1 port of monolith L34576-34628 minus the drawCharacterBase
 *  call — portrait renders as a stub colored rect with the gender
 *  letter for now (drawCharacterBase isn't ported yet). */
function drawStatusTab(
  ctx: CanvasRenderingContext2D,
  life: LifeState,
  GW: number,
  _GH: number,
  cy: number,
): void {
  // ---- PLAYER BLOCK ----
  // Portrait STUB. The monolith calls
  //   drawCharacterBase(ctx, LIFE.gender, LIFE.fitness, LIFE.skinTone, 8, cy+2, 32);
  // which paints a top-down body sprite scaled to fitness. Not
  // ported yet — H<followup> picks this up. For now a 32×32 cyan-
  // bordered placeholder with the gender initial keeps the layout
  // stable.
  const _stPortS = 32;
  ctx.fillStyle = '#234';
  ctx.fillRect(8, cy + 2, _stPortS, _stPortS);
  ctx.strokeStyle = '#0ff';
  ctx.lineWidth = 1;
  ctx.strokeRect(8, cy + 2, _stPortS, _stPortS);
  ctx.fillStyle = '#aaa';
  ctx.font = 'bold 18px monospace';
  ctx.textAlign = 'center';
  ctx.fillText(life.gender, 8 + _stPortS / 2, cy + 2 + 22);

  // Right-of-portrait info column. 1:1 with L34585-34591.
  ctx.textAlign = 'left';
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 11px monospace';
  ctx.fillText(life.playerAlias + ' • ' + life.age, 46, cy + 12);
  ctx.fillStyle = '#888';
  ctx.font = '9px monospace';
  ctx.fillText(life.playerJob || 'Unemployed', 46, cy + 24);
  ctx.fillStyle = '#0f0';
  ctx.font = 'bold 10px monospace';
  ctx.fillText('$' + life.money.toLocaleString(), 46, cy + 36);

  ctx.textAlign = 'center';
  const _bX = 10;
  const _bW = GW - 20;
  const _bH = 10;

  // Health bar. 1:1 with L34594-34602.
  const _hsSt = getHealthStatus(life.health);
  const _hPctSt = Math.max(0, Math.min(1, life.health / 100));
  const _hbY = cy + 42;
  ctx.fillStyle = '#222';
  ctx.fillRect(_bX, _hbY, _bW, _bH);
  ctx.fillStyle = _hsSt.color;
  ctx.fillRect(_bX, _hbY, Math.round(_bW * _hPctSt), _bH);
  ctx.strokeStyle = '#444';
  ctx.lineWidth = 1;
  ctx.strokeRect(_bX, _hbY, _bW, _bH);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 8px monospace';
  ctx.fillText(
    _hsSt.icon + ' Health ' + Math.round(life.health) + '% — ' + _hsSt.label,
    GW / 2,
    _hbY + 8,
  );

  // Fitness bar. 1:1 with L34604-34611.
  const _fsSt = getFitnessStatus(life.fitness);
  const _fPctSt = Math.max(0, Math.min(1, life.fitness / 100));
  const _fbY = cy + 54;
  ctx.fillStyle = '#222';
  ctx.fillRect(_bX, _fbY, _bW, _bH);
  ctx.fillStyle = _fsSt.color;
  ctx.fillRect(_bX, _fbY, Math.round(_bW * _fPctSt), _bH);
  ctx.strokeStyle = '#444';
  ctx.lineWidth = 1;
  ctx.strokeRect(_bX, _fbY, _bW, _bH);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 8px monospace';
  ctx.fillText(
    '💪 Fitness ' + Math.round(life.fitness) + '% — ' + _fsSt.label,
    GW / 2,
    _fbY + 8,
  );

  // Status warnings (hunger / sleep). 1:1 with L34613-34623.
  const warn: string[] = [];
  if (life.daysSinceEat >= 2) warn.push('🚨 Starving');
  else if (life.daysSinceEat >= 1) warn.push('⚠ Hungry');
  if (life.daysSinceSleep >= 2) warn.push('🚨 Exhausted');
  else if (life.daysSinceSleep >= 1) warn.push('⚠ Tired');
  let extraY = 0;
  if (warn.length > 0) {
    ctx.fillStyle = '#f88';
    ctx.font = '8px monospace';
    ctx.fillText(warn.join(' • '), GW / 2, cy + 74);
    extraY = 10;
  }

  // Divider. 1:1 with L34626-34628.
  const divY = cy + 76 + extraY;
  ctx.strokeStyle = '#444';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(10, divY);
  ctx.lineTo(GW - 10, divY);
  ctx.stroke();

  // VEHICLE BLOCK + SWITCH CAR pending in H194.
  ctx.fillStyle = '#444';
  ctx.font = '9px monospace';
  ctx.fillText('— vehicle block ports in H194 —', GW / 2, divY + 24);
}

/** Tab-body placeholder for not-yet-ported tabs. Keeps the menu
 *  shell usable while bodies land one-by-one. */
function drawTabPlaceholder(
  ctx: CanvasRenderingContext2D,
  tab: MenuTab,
  GW: number,
  GH: number,
): void {
  ctx.fillStyle = '#666';
  ctx.font = 'bold 12px monospace';
  ctx.textAlign = 'center';
  ctx.fillText(TAB_LABELS[tab] + ' tab — body ports next', GW / 2, GH / 2);
  ctx.fillStyle = '#555';
  ctx.font = '10px monospace';
  ctx.fillText('(tap top-right corner or CLOSE to exit)', GW / 2, GH / 2 + 16);
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
