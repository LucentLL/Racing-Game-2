/**
 * H726: Shared Gran-Turismo-2-styled menu chrome.
 *
 * Three persistent strips GT2 paints on every garage/dealer/
 * upgrade/spec screen:
 *
 *   - drawGt2TopBar     top-left 4 icon tiles (options/home/race/
 *                       trophy) + top-right amber breadcrumb pill
 *                       tabs ("MAZDA › MAZDASPEED › TURBO").
 *   - drawGt2BottomBar  bottom strip: exit-arrow · days · Cr money ·
 *                       current-car silhouette + name.
 *   - drawGt2Backdrop   optional faint blueprint-grid overlay used by
 *                       root-level grid screens (Parts Lineup etc).
 *
 * Plus gt2TopBarHitTest / gt2BottomBarHitTest so callers route taps
 * without duplicating geometry. Geometry is exported as the
 * GT2_CHROME constants so subscreens can lay content inside the
 * available band (TOP_H..GH-BOT_H).
 *
 * Visual reference: six GT2 screenshots the user shared 2026-05-30
 * (HONDA dealer, SKYLINE car view + spec, MAZDASPEED parts lineup
 * + turbo sub-cats + stage-detail). Palette is locked to GT2's
 * amber-on-charcoal — see GT2_COLORS.
 */

import type { LifeState } from '@/state/life';
import { CAR_CATALOG } from '@/config/cars/catalog';

/** GT2 palette, frozen at module load so callers can read without
 *  branching. Hex picked from the screenshots — amber face #f7a623,
 *  bright active accent #ff7a18, charcoal backplate #1c1c1c. */
export const GT2_COLORS = {
  bg: '#1c1c1c',
  bgDeep: '#141414',
  panel: '#262626',
  amber: '#f7a623',
  amberDim: '#5a4220',
  amberDark: '#a36e15',
  active: '#ff7a18',
  text: '#f4f4f4',
  textMute: '#9a9a9a',
  textDim: '#5e5e5e',
  grid: 'rgba(120, 140, 170, 0.07)',
} as const;

/** Layout constants — exported so subscreens lay content inside
 *  the available content band (y in [TOP_H, GH - BOT_H]). */
export const GT2_CHROME = {
  TOP_H: 28,
  BOT_H: 28,
  ICON_TILE: 22,
  ICON_PAD: 3,
  TAB_H: 18,
  TAB_MAX_W: 92,
  TAB_GAP: 2,
} as const;

/** Which of the four top-left icons the chrome should highlight as
 *  "active" (the screen the player is currently on). null = none. */
export type Gt2NavIcon = 'options' | 'home' | 'race' | 'trophy' | null;

export interface Gt2TopBarOpts {
  /** Breadcrumb trail, root-first. Last entry is rendered as the
   *  active orange tab; earlier entries dim to grey. Caller can pass
   *  [] to suppress the breadcrumb (e.g. Parts Lineup root). */
  crumbs: string[];
  /** Which of the four top-left icons reads as the current screen. */
  activeIcon?: Gt2NavIcon;
}

export interface Gt2NavHandlers {
  /** Tap handlers for the four top-left icons. Any handler that's
   *  undefined disables hit-testing for that icon (the tile still
   *  paints, just doesn't respond — matches GT2 where greyed icons
   *  are visible but inert). */
  onOptions?: () => void;
  onHome?: () => void;
  onRace?: () => void;
  onTrophy?: () => void;
  /** Tap handler for the bottom-left exit arrow. */
  onExit?: () => void;
  /** Tap on a breadcrumb tab (index 0 = root). Last tab is the
   *  active screen and is not reported (tapping the active tab is
   *  a no-op in GT2). */
  onCrumb?: (index: number) => void;
}

const ICON_ORDER: ReadonlyArray<Exclude<Gt2NavIcon, null>> = [
  'options', 'home', 'race', 'trophy',
];

/** Top-left icon-tile X coord for slot i (0..3). */
function iconX(i: number): number {
  return GT2_CHROME.ICON_PAD + i * (GT2_CHROME.ICON_TILE + 2);
}

/** Right-edge X for the breadcrumb tab band. */
function crumbsRightX(GW: number): number {
  return GW - 4;
}

/** Width allocated to one breadcrumb tab given trail length. */
function crumbWidth(GW: number, trailLen: number): number {
  if (trailLen === 0) return 0;
  const available = GW - (GT2_CHROME.ICON_PAD + 4 * (GT2_CHROME.ICON_TILE + 2)) - 8;
  return Math.min(GT2_CHROME.TAB_MAX_W, Math.floor((available - (trailLen - 1) * GT2_CHROME.TAB_GAP) / trailLen));
}

/** Paint the top strip — 4 icon tiles on the left, breadcrumb pill
 *  tabs flowing right-to-left from the right edge. */
export function drawGt2TopBar(
  ctx: CanvasRenderingContext2D,
  GW: number,
  opts: Gt2TopBarOpts,
): void {
  // Strip backplate.
  ctx.fillStyle = GT2_COLORS.bgDeep;
  ctx.fillRect(0, 0, GW, GT2_CHROME.TOP_H);

  // 4 icon tiles.
  for (let i = 0; i < 4; i++) {
    drawIconTile(ctx, ICON_ORDER[i], iconX(i), GT2_CHROME.ICON_PAD,
      opts.activeIcon === ICON_ORDER[i]);
  }

  // Breadcrumb tabs, right-to-left so the active sits flush right.
  const trail = opts.crumbs;
  if (trail.length === 0) return;
  const tabW = crumbWidth(GW, trail.length);
  const tabY = (GT2_CHROME.TOP_H - GT2_CHROME.TAB_H) / 2;
  let x = crumbsRightX(GW);
  for (let i = trail.length - 1; i >= 0; i--) {
    const isActive = i === trail.length - 1;
    x -= tabW;
    drawCrumbTab(ctx, x, tabY, tabW, GT2_CHROME.TAB_H, trail[i], isActive);
    x -= GT2_CHROME.TAB_GAP;
  }
}

/** Single icon tile — amber rounded rect with a tiny canvas-drawn
 *  glyph (no font/emoji deps). `active` flips to the brighter
 *  active orange and a white border. */
function drawIconTile(
  ctx: CanvasRenderingContext2D,
  kind: Exclude<Gt2NavIcon, null>,
  x: number, y: number,
  active: boolean,
): void {
  const s = GT2_CHROME.ICON_TILE;
  ctx.fillStyle = active ? GT2_COLORS.active : GT2_COLORS.amber;
  roundRect(ctx, x, y, s, s, 3);
  ctx.fill();
  ctx.strokeStyle = active ? '#fff' : GT2_COLORS.amberDark;
  ctx.lineWidth = 1;
  roundRect(ctx, x + 0.5, y + 0.5, s - 1, s - 1, 3);
  ctx.stroke();

  ctx.fillStyle = GT2_COLORS.bgDeep;
  ctx.strokeStyle = GT2_COLORS.bgDeep;
  ctx.lineWidth = 1.5;
  const cx = x + s / 2;
  const cy = y + s / 2;
  switch (kind) {
    case 'options': {
      for (let dy = -1; dy <= 1; dy += 2) {
        for (let dx = -1; dx <= 1; dx += 2) {
          ctx.fillRect(cx + dx * 3 - 1.5, cy + dy * 3 - 1.5, 3, 3);
        }
      }
      break;
    }
    case 'home': {
      ctx.beginPath();
      ctx.moveTo(cx - 5, cy + 4);
      ctx.lineTo(cx - 5, cy - 1);
      ctx.lineTo(cx, cy - 6);
      ctx.lineTo(cx + 5, cy - 1);
      ctx.lineTo(cx + 5, cy + 4);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case 'race': {
      for (let row = 0; row < 3; row++) {
        for (let col = 0; col < 3; col++) {
          if (((row + col) & 1) === 0) {
            ctx.fillRect(cx - 4 + col * 3, cy - 4 + row * 3, 3, 3);
          }
        }
      }
      break;
    }
    case 'trophy': {
      ctx.beginPath();
      ctx.moveTo(cx - 4, cy - 4);
      ctx.lineTo(cx + 4, cy - 4);
      ctx.lineTo(cx + 3, cy + 1);
      ctx.lineTo(cx - 3, cy + 1);
      ctx.closePath();
      ctx.fill();
      ctx.fillRect(cx - 2, cy + 1, 4, 3);
      ctx.fillRect(cx - 4, cy + 4, 8, 1);
      break;
    }
  }
}

/** One breadcrumb pill tab — active = bright orange, past = dark
 *  grey with muted text. Truncates the label with an ellipsis when
 *  it overflows. */
function drawCrumbTab(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
  label: string, active: boolean,
): void {
  ctx.fillStyle = active ? GT2_COLORS.active : '#3a3a3a';
  roundRect(ctx, x, y, w, h, 3);
  ctx.fill();
  ctx.fillStyle = active ? '#fff' : GT2_COLORS.textMute;
  ctx.font = 'bold 9px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const lab = truncateToWidth(ctx, label.toUpperCase(), w - 8);
  ctx.fillText(lab, x + w / 2, y + h / 2 + 0.5);
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
}

export interface Gt2BottomBarOpts {
  /** Override displayed car name — defaults to ownedCars[0]'s
   *  catalog name. Pass an empty string to suppress entirely. */
  carName?: string;
  /** Override displayed money — defaults to life.money. */
  money?: number;
  /** Override displayed days — defaults to life.day. */
  day?: number;
}

/** Paint the bottom strip — exit arrow · day counter · money · car
 *  silhouette + name. Reads from `life` for the live numbers unless
 *  overridden via opts. */
export function drawGt2BottomBar(
  ctx: CanvasRenderingContext2D,
  life: LifeState | null,
  GW: number, GH: number,
  opts: Gt2BottomBarOpts = {},
): void {
  const y = GH - GT2_CHROME.BOT_H;
  ctx.fillStyle = GT2_COLORS.bgDeep;
  ctx.fillRect(0, y, GW, GT2_CHROME.BOT_H);

  // Exit arrow — amber circle with a left-pointing chevron.
  const ax = 14;
  const ay = y + GT2_CHROME.BOT_H / 2;
  ctx.fillStyle = GT2_COLORS.amber;
  ctx.beginPath();
  ctx.arc(ax, ay, 10, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = GT2_COLORS.bgDeep;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(ax + 3, ay - 3);
  ctx.lineTo(ax - 2, ay);
  ctx.lineTo(ax + 3, ay + 3);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(ax - 2, ay);
  ctx.lineTo(ax + 4, ay);
  ctx.stroke();

  ctx.textBaseline = 'middle';

  // Days counter.
  const day = opts.day ?? life?.day ?? 0;
  ctx.fillStyle = GT2_COLORS.text;
  ctx.font = 'bold 10px monospace';
  ctx.textAlign = 'left';
  const daysLabel = day + ' days';
  ctx.fillText(daysLabel, 32, ay + 0.5);
  const dayW = ctx.measureText(daysLabel).width;

  // Cr coin disc.
  const crX = 32 + dayW + 8;
  ctx.fillStyle = GT2_COLORS.amber;
  ctx.beginPath();
  ctx.arc(crX, ay, 7, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = GT2_COLORS.bgDeep;
  ctx.font = 'bold 8px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('Cr', crX, ay + 0.5);

  // Money.
  const money = opts.money ?? life?.money ?? 0;
  ctx.fillStyle = GT2_COLORS.text;
  ctx.font = 'bold 11px monospace';
  ctx.textAlign = 'left';
  ctx.fillText(formatMoney(money), crX + 12, ay + 0.5);

  // Right side: car silhouette + name.
  const carName = opts.carName ?? defaultCarName(life);
  if (carName) {
    const rightX = GW - 8;
    ctx.font = 'bold 10px monospace';
    ctx.fillStyle = GT2_COLORS.text;
    ctx.textAlign = 'right';
    ctx.fillText(carName, rightX, ay + 0.5);
    const nameW = ctx.measureText(carName).width;
    drawCarBlob(ctx, rightX - nameW - 24, ay, 18, 9);
  }

  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}

/** Small amber car-silhouette blob — rounded pill with a darker
 *  cabin notch. Cheap canvas primitive, no sprite dep. */
function drawCarBlob(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number, w: number, h: number,
): void {
  ctx.fillStyle = GT2_COLORS.amber;
  roundRect(ctx, cx - w / 2, cy - h / 2, w, h, 3);
  ctx.fill();
  ctx.fillStyle = GT2_COLORS.bgDeep;
  ctx.fillRect(cx - w / 4, cy - h / 2 + 1, w / 2, 2);
}

/** Faint blueprint-grid backdrop used on Parts Lineup root. Caller
 *  fills the body band before calling this. */
export function drawGt2Backdrop(
  ctx: CanvasRenderingContext2D,
  GW: number, GH: number,
  cell = 16,
): void {
  const top = GT2_CHROME.TOP_H;
  const bot = GH - GT2_CHROME.BOT_H;
  ctx.strokeStyle = GT2_COLORS.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x <= GW; x += cell) {
    ctx.moveTo(x + 0.5, top);
    ctx.lineTo(x + 0.5, bot);
  }
  for (let y = top; y <= bot; y += cell) {
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(GW, y + 0.5);
  }
  ctx.stroke();
}

/** Top-bar hit test — returns true if the tap landed inside the
 *  strip (caller should still report eaten). Dispatches to the
 *  matching handler when one is registered for the hit icon /
 *  breadcrumb tab. */
export function gt2TopBarHitTest(
  tx: number, ty: number,
  GW: number,
  trailLen: number,
  nav: Gt2NavHandlers,
): boolean {
  if (ty < 0 || ty > GT2_CHROME.TOP_H) return false;

  const s = GT2_CHROME.ICON_TILE;
  for (let i = 0; i < 4; i++) {
    const x = iconX(i);
    if (tx >= x && tx <= x + s && ty >= GT2_CHROME.ICON_PAD && ty <= GT2_CHROME.ICON_PAD + s) {
      const handler = {
        options: nav.onOptions,
        home: nav.onHome,
        race: nav.onRace,
        trophy: nav.onTrophy,
      }[ICON_ORDER[i]];
      handler?.();
      return true;
    }
  }

  if (trailLen > 0 && nav.onCrumb) {
    const tabW = crumbWidth(GW, trailLen);
    const tabY = (GT2_CHROME.TOP_H - GT2_CHROME.TAB_H) / 2;
    if (ty >= tabY && ty <= tabY + GT2_CHROME.TAB_H) {
      let x = crumbsRightX(GW);
      for (let i = trailLen - 1; i >= 0; i--) {
        x -= tabW;
        if (tx >= x && tx <= x + tabW) {
          if (i < trailLen - 1) nav.onCrumb(i);
          return true;
        }
        x -= GT2_CHROME.TAB_GAP;
      }
    }
  }

  return ty <= GT2_CHROME.TOP_H;
}

/** Bottom-bar hit test — currently only the exit arrow is tappable;
 *  the days/Cr/money/car-name readouts are informational. */
export function gt2BottomBarHitTest(
  tx: number, ty: number,
  GH: number,
  nav: Gt2NavHandlers,
): boolean {
  const y = GH - GT2_CHROME.BOT_H;
  if (ty < y) return false;
  const ax = 14;
  const ay = y + GT2_CHROME.BOT_H / 2;
  const dx = tx - ax;
  const dy = ty - ay;
  if (dx * dx + dy * dy <= 12 * 12) {
    nav.onExit?.();
    return true;
  }
  return true;
}

function formatMoney(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  return n.toLocaleString();
}

function defaultCarName(life: LifeState | null): string {
  const id = life?.ownedCars?.[0];
  if (!id) return '';
  return CAR_CATALOG[id]?.name ?? '';
}

function truncateToWidth(
  ctx: CanvasRenderingContext2D, s: string, maxW: number,
): string {
  if (ctx.measureText(s).width <= maxW) return s;
  let lo = 0, hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ctx.measureText(s.slice(0, mid) + '…').width <= maxW) lo = mid + 1;
    else hi = mid;
  }
  return s.slice(0, Math.max(0, lo - 1)) + '…';
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}
