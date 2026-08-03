/**
 * H1313: HUD CITY MAP — a map icon on the drive screen, and the panel it
 * opens.
 *
 * Why this exists. H1049 pulled the corner minimap off the touch HUD (GPS was
 * rare in 1999) and moved the map to the pause menu's MAP tab, and H178's
 * full-screen sheet (F / ✕) covers the whole windscreen. Both are *modal*
 * relative to driving: one pauses, the other blanks the road. Neither answers
 * "which way is home from here" without taking your eyes off the drive. This
 * adds the third thing — a glanceable city map you fold open and leave open
 * while you drive.
 *
 * Two styles, per the request:
 *   SOLID — an opaque sheet. Backing fill, the full road palette (dark by
 *           default; the 1990s paper-atlas colors when OPT → Map: Light is
 *           on), a title bar, and every marker the minimap paints.
 *   CLEAR — streets only, floating over the road with NO backing, the way the
 *           track map (ui/hud/trackMap.ts) draws a circuit: a dark casing
 *           stroke under a bright core, which is what makes a hairline
 *           readable over bright grass. Ambient pins (gas, car pins, cop
 *           dots) drop out; only where-you-must-go pins and the player
 *           survive, so the overlay stays an overlay.
 *
 * Cost model (project_perf_cost_model: dips are GPU stroke-call count, not
 * JS). The road network is BAKED to an offscreen canvas — ~130 polylines,
 * two passes — and the per-frame cost is one drawImage plus the marker pass.
 * The bake is keyed on everything that can change its pixels (size, style,
 * palette, night, active map, RENDER_ENTRIES length) so an editor save or a
 * map switch repaints it and nothing else does.
 *
 * City only. On a race venue drawTrackMap already owns this corner with the
 * shape of the lap, which is the right instrument there; the two gate on
 * opposite sides of `mapId === 'city'` so they can never both paint.
 */

import { TILE, WORLD_W, WORLD_H } from '@/config/world/tiles';
import type { PlayerState } from '@/state/player';
import type { LifeState } from '@/state/life';
import { RENDER_ENTRIES } from '@/render/worldMap';
// Palette + width lookups come STRAIGHT from the minimap rather than being
// forked here (fullMap.ts forked them because a full-screen sheet needs
// darker minors; this panel is minimap-sized, so the same table is correct).
import {
  drawWorldMarkers,
  colorForRoad as minimapRoadColor,
  colorForRoadPaper as paperRoadColor,
  widthForRoad as minimapRoadWidth,
} from '@/render/minimap';
import { isGt2Night, getGt2NightPalette } from '@/ui/gt2Chrome';
import { getActiveMapId } from '@/world/mapRuntime';
import { pagerAnchor, isPagerPopping } from './pager';

/** Left-column margin — the same x the pager parks at, so the icon, the
 *  pager badge and the panel all share one edge. */
const MARGIN = 8;
const ICON_W = 44;
const ICON_H = 26;
/** Gap between the pager badge's bottom and the icon's top. */
const ICON_GAP = 16;
/** Panel header strip: title + style chip + ✕. */
const HEAD_H = 15;
/** Sheet margin around the square map viewport. */
const PAD = 4;
/** Legibility floor for the square map viewport. Below this the ring road
 *  stops resolving into a shape you can navigate by. */
const MIN_MAP = 96;
const WORLD_SPAN = Math.max(WORLD_W, WORLD_H);

// ---------------------------------------------------------------------------
// Persisted state. Both live in gameplaySettings, which is saved wholesale
// (project_driver_city_save_is_wholesale) and carries an index signature, so
// new keys persist for free and old saves read undefined → default.
// ---------------------------------------------------------------------------

/** Is the fold-out map panel showing? Persisted: a player who drives with the
 *  map open wants it open again next session. */
export function isCityMapOpen(life: LifeState | null): boolean {
  return life?.gameplaySettings?.hudMapOpen === true;
}
export function setCityMapOpen(life: LifeState | null, open: boolean): void {
  if (life) life.gameplaySettings.hudMapOpen = open;
}
/** CLEAR (streets-only overlay) vs SOLID (opaque sheet). Default SOLID. */
export function isCityMapClear(life: LifeState | null): boolean {
  return life?.gameplaySettings?.hudMapClear === true;
}
export function toggleCityMapStyle(life: LifeState | null): void {
  if (life) life.gameplaySettings.hudMapClear = !isCityMapClear(life);
}

/** The widget only makes sense on the city — see the header note. */
export function cityMapAvailable(): boolean {
  return getActiveMapId() === 'city';
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

export interface Rect { x: number; y: number; w: number; h: number }

/** Closed-state icon: left edge, directly under the pager badge. Anchored off
 *  the SAME formula the pager uses (gauge box → gauge bottom → badge), so the
 *  two stay stacked at every viewport instead of drifting apart. */
export function cityMapIconRect(GW: number, GH: number): Rect {
  const a = pagerAnchor(GW, GH);
  return { x: a.x, y: Math.round(a.y + ICON_GAP), w: ICON_W, h: ICON_H };
}

/** Project a DOM rect into HUD-canvas coordinates. The HUD canvas is pinned
 *  at (0,0) spanning the viewport and CSS-upscaled to fill it, so a per-axis
 *  scale with no offset is exact. Returns null when there's no usable DOM
 *  (headless, boot race). */
function domFloorForColumn(
  hctx: CanvasRenderingContext2D, x0: number, x1: number, GH: number,
): number {
  const fallback = GH - MARGIN;
  if (typeof document === 'undefined') return fallback;
  const cv = hctx.canvas as HTMLCanvasElement | undefined;
  if (!cv || typeof cv.getBoundingClientRect !== 'function') return fallback;
  const cvr = cv.getBoundingClientRect();
  if (cvr.width <= 0 || cvr.height <= 0) return fallback;
  const sx = hctx.canvas.width / cvr.width;
  const sy = hctx.canvas.height / cvr.height;
  // Everything the drive HUD parks along the bottom. The individual pedal /
  // e-brake / shifter bars, NOT their .pedal-zone container — that spans the
  // full width and would read as an overlap on both sides. Which bottom
  // corner holds the wheel flips with handedness (H1111), so measure them all
  // and keep only what actually overlaps this column.
  const ids = ['steerBar', 'cruiseBtn', 'brkBtn', 'gasBtn', 'ebrkBtn', 'shiftKnob'];
  let floor = fallback;
  for (const id of ids) {
    const el = document.getElementById(id);
    if (!el) continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1) continue;      // hidden → not in the way
    const rx0 = (r.left - cvr.left) * sx;
    const rx1 = (r.right - cvr.left) * sx;
    if (rx1 < x0 || rx0 > x1) continue;               // horizontally clear
    floor = Math.min(floor, (r.top - cvr.top) * sy - 6);
  }
  return floor;
}

/** Open-state panel. Starts exactly where the icon sat — the panel REPLACES
 *  the icon, its header taking over as the thing you tap (title, style chip,
 *  ✕) — and is a touch under a quarter of the screen wide.
 *
 *  It SHRINKS TO ITS CONTENT rather than filling the band down to the wheel.
 *  The world is square (2500 × 2500 tiles) and gets a uniform fit, so a panel
 *  taller than it is wide is just dead sheet under the map; the available
 *  height is a ceiling on the square, not a target to fill.
 *
 *  On a viewport too short to clear the controls at all — a squat landscape
 *  window at full HUD Size, where the gauge and the pedal stack nearly meet —
 *  the square bottoms out at MIN_MAP and the pedal / e-brake bars simply
 *  overlap it. That is a deliberate degradation, not an oversight: those bars
 *  are DOM at z-index 6 and the HUD canvas is z-index 3, so they paint OVER
 *  the sheet and stay fully usable; the player loses part of the map, never a
 *  control. Shrinking further would just make the map unreadable instead. */
export function cityMapPanelRect(
  hctx: CanvasRenderingContext2D, GW: number, GH: number,
): Rect {
  const icon = cityMapIconRect(GW, GH);
  const wantW = Math.max(140, Math.min(GW * 0.22, GW * 0.45));
  const floor = domFloorForColumn(hctx, icon.x, icon.x + wantW, GH);
  const availH = floor - icon.y - HEAD_H - PAD * 2;
  const s = Math.round(Math.max(MIN_MAP, Math.min(wantW - PAD * 2, availH)));
  return { x: icon.x, y: icon.y, w: s + PAD * 2, h: s + HEAD_H + PAD * 2 };
}

/** Square map viewport inside a panel, under the header strip. */
function contentBox(p: Rect): Rect {
  return { x: p.x + PAD, y: p.y + HEAD_H + PAD, w: p.w - PAD * 2, h: p.w - PAD * 2 };
}

// ---------------------------------------------------------------------------
// Road bake
// ---------------------------------------------------------------------------

interface Bake { canvas: HTMLCanvasElement; size: number; key: string }
let _bake: Bake | null = null;

function bakeRoads(size: number, clear: boolean, light: boolean, night: boolean): HTMLCanvasElement {
  const cv = document.createElement('canvas');
  cv.width = size;
  cv.height = size;
  const c = cv.getContext('2d');
  if (!c) return cv;
  const sc = size / WORLD_SPAN;

  if (!clear) {
    // SOLID: an opaque sheet. Dark navy by default; cream when the player has
    // opted into the paper-atlas palette (OPT → Map: Light), matching what
    // that toggle already does to the minimap.
    c.fillStyle = light ? '#f7f4ea' : 'rgba(9, 10, 17, 0.94)';
    c.fillRect(0, 0, size, size);
  }

  c.lineCap = 'round';
  c.lineJoin = 'round';
  // Two passes so majors sit over minors regardless of RENDER_ENTRIES order —
  // the same ordering the minimap (H176) and full map use.
  const passes: ReadonlyArray<(maj: number) => boolean> = [
    (maj) => maj !== 1,
    (maj) => maj === 1,
  ];
  for (const pred of passes) {
    for (const entry of RENDER_ENTRIES) {
      const w = entry.row[0] as number;
      const maj = entry.row[1] as number;
      const name = String(entry.row[2] ?? '');
      if (!pred(maj)) continue;
      const pts = entry.smoothed;
      if (pts.length < 4) continue;
      // Honor the real carriageway width where it beats the per-class floor,
      // so I-485's 10 tiles visibly outweighs a 4-tile US route.
      const base = Math.max(minimapRoadWidth(name, maj === 1), w * TILE * sc);
      const trace = (): void => {
        c.beginPath();
        c.moveTo(pts[0] * TILE * sc, pts[1] * TILE * sc);
        for (let i = 2; i + 1 < pts.length; i += 2) {
          c.lineTo(pts[i] * TILE * sc, pts[i + 1] * TILE * sc);
        }
        c.stroke();
      };
      if (clear) {
        // Casing + core. With no backing fill this pair IS the legibility —
        // the dark casing is what separates a white hairline from bright
        // grass, exactly as the track map's ribbon does. The core carries a
        // FLOOR: a minor street's true width bakes out under 1px, and a core
        // thinner than its casing just paints a black line.
        const core = Math.max(base, maj === 1 ? 1.8 : 0.9);
        c.strokeStyle = 'rgba(10, 10, 14, 0.72)';
        c.lineWidth = core + (maj === 1 ? 2.4 : 1.5);
        trace();
        c.strokeStyle = maj === 1 ? 'rgba(255, 255, 255, 0.97)' : 'rgba(226, 231, 238, 0.9)';
        c.lineWidth = core;
        trace();
      } else {
        c.lineWidth = base;
        c.strokeStyle = light
          ? paperRoadColor(name, maj === 1)
          : minimapRoadColor(name, maj === 1, night);
        trace();
      }
    }
  }
  return cv;
}

function getBake(size: number, clear: boolean, light: boolean, night: boolean): Bake {
  // RENDER_ENTRIES.length is the cheap invalidation signal an editor save or a
  // map switch trips (rebuildRenderEntries replaces the list) — same trick the
  // track map uses.
  const key = [
    size, clear ? 'c' : 's', light ? 'l' : 'd', night ? 'n' : 'y',
    getActiveMapId(), RENDER_ENTRIES.length, getGt2NightPalette(),
  ].join('|');
  if (_bake && _bake.key === key) return _bake;
  _bake = { canvas: bakeRoads(size, clear, light, night), size, key };
  return _bake;
}

/** Drop the cache (map switch / geometry rebuild). Cheap to call. */
export function resetCityMap(): void {
  _bake = null;
}

// ---------------------------------------------------------------------------
// Paint
// ---------------------------------------------------------------------------

/** Tap targets stamped at paint time, hit-tested by handleCityMapTap — the
 *  rect-cache pattern the pause menu and full map both use, so a control is
 *  tappable exactly where it was drawn and nowhere else. */
type CityMapAct = 'open' | 'close' | 'style' | 'face';
let _rects: Array<Rect & { act: CityMapAct }> = [];

/** Folded-map glyph: three panels with a fold crease, a route squiggle and a
 *  pin. Small, but it has to read as a MAP at 44×26 — hence the accordion
 *  silhouette (angled top/bottom edges) rather than a plain rectangle. */
function paintIconGlyph(c: CanvasRenderingContext2D, r: Rect, night: boolean): void {
  const { x, y, w, h } = r;
  c.save();
  // Bezel — same charcoal shell as the pager, so the left column reads as one
  // stack of instruments rather than a pile of unrelated boxes.
  c.fillStyle = 'rgba(35, 37, 42, 0.92)';
  c.fillRect(x, y, w, h);
  c.strokeStyle = '#0c0d10';
  c.lineWidth = 1;
  c.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);

  const ix = x + 5;
  const iy = y + 4;
  const iw = w - 10;
  const ih = h - 8;
  const third = iw / 3;
  const fold = ih * 0.16;
  // Sheet: an accordion of three panels, alternate folds sitting high/low.
  c.beginPath();
  c.moveTo(ix, iy + fold);
  c.lineTo(ix + third, iy);
  c.lineTo(ix + third * 2, iy + fold);
  c.lineTo(ix + iw, iy);
  c.lineTo(ix + iw, iy + ih - fold);
  c.lineTo(ix + third * 2, iy + ih);
  c.lineTo(ix + third, iy + ih - fold);
  c.lineTo(ix, iy + ih);
  c.closePath();
  c.fillStyle = night ? '#d9d3c0' : '#ece5d2';   // manila sheet
  c.fill();
  c.strokeStyle = 'rgba(40, 36, 24, 0.75)';
  c.lineWidth = 0.8;
  c.stroke();
  // Fold creases.
  c.strokeStyle = 'rgba(90, 79, 56, 0.45)';
  c.beginPath();
  c.moveTo(ix + third, iy);
  c.lineTo(ix + third, iy + ih - fold);
  c.moveTo(ix + third * 2, iy + fold);
  c.lineTo(ix + third * 2, iy + ih);
  c.stroke();
  // Route: one blue highway crossing the sheet.
  c.strokeStyle = '#1f5bbf';
  c.lineWidth = 1.3;
  c.beginPath();
  c.moveTo(ix + 1.5, iy + ih * 0.72);
  c.lineTo(ix + iw * 0.42, iy + ih * 0.4);
  c.lineTo(ix + iw * 0.66, iy + ih * 0.62);
  c.lineTo(ix + iw - 1.5, iy + ih * 0.22);
  c.stroke();
  // Pin.
  c.fillStyle = '#d0021b';
  c.beginPath();
  c.arc(ix + iw * 0.66, iy + ih * 0.62, 2, 0, Math.PI * 2);
  c.fill();
  c.restore();
}

/** Header chrome for the open panel: title, SOLID/CLEAR chip, ✕. In CLEAR
 *  style the chips carry their own small plates (there's no sheet behind them
 *  to sit on) so they stay readable and tappable over the moving world. */
function paintChrome(
  c: CanvasRenderingContext2D, p: Rect, clear: boolean, light: boolean,
): void {
  const chipH = 11;
  const chipY = p.y + 2;
  const closeW = 13;
  const styleW = 34;
  const closeX = p.x + p.w - 3 - closeW;
  const styleX = closeX - 3 - styleW;

  // Title only when there's room left of the chips — on a narrow panel the
  // chips matter and the city's name doesn't.
  if (!clear && styleX - (p.x + 5) > 46) {
    c.fillStyle = light ? '#2a2418' : '#cfd6e2';
    c.font = 'bold 8px monospace';
    c.textAlign = 'left';
    c.fillText('CHARLOTTE', p.x + 5, p.y + 11);
  }

  const chip = (
    x: number, w: number, label: string, on: boolean,
  ): void => {
    c.fillStyle = on ? 'rgba(31, 91, 191, 0.85)' : 'rgba(24, 26, 32, 0.85)';
    c.fillRect(x, chipY, w, chipH);
    c.strokeStyle = on ? '#7fb0ff' : '#6a6f7a';
    c.lineWidth = 1;
    c.strokeRect(x + 0.5, chipY + 0.5, w - 1, chipH - 1);
    c.fillStyle = on ? '#fff' : '#c8ccd4';
    c.font = 'bold 7px monospace';
    c.textAlign = 'center';
    c.fillText(label, x + w / 2, chipY + 8);
  };
  chip(styleX, styleW, clear ? 'CLEAR' : 'SOLID', clear);
  chip(closeX, closeW, '✕', false);
  c.textAlign = 'left';

  // Generous touch boxes around the small chips.
  _rects.push({ x: styleX - 3, y: chipY - 3, w: styleW + 6, h: chipH + 8, act: 'style' });
  _rects.push({ x: closeX - 4, y: chipY - 3, w: closeW + 8, h: chipH + 8, act: 'close' });
}

/**
 * Paint the widget: the icon when closed, the panel when open.
 *
 * `blocked` is the caller's suppression predicate. It MUST be the same value
 * passed to handleCityMapTap in the same frame — project_tap_router_priority:
 * a hit zone that outlives its draw is an invisible tap thief (H1281 fixed
 * exactly that bug for the pager).
 */
export function drawCityMap(
  hctx: CanvasRenderingContext2D,
  GW: number,
  GH: number,
  player: PlayerState,
  life: LifeState | null,
  traffic: ReadonlyArray<{ px: number; py: number; isPursuing?: boolean }> | null,
  blocked: boolean,
): void {
  _rects = [];
  if (blocked || !life || !cityMapAvailable()) return;

  const night = isGt2Night();

  if (!isCityMapOpen(life)) {
    // The pager's 7-second pop-in lands on top of this slot. Rather than let
    // an invisible button sit under it, the icon stands down for the duration
    // — draw and hit-test together, so neither can steal the other's tap.
    if (isPagerPopping(life)) return;
    const r = cityMapIconRect(GW, GH);
    paintIconGlyph(hctx, r, night);
    _rects.push({ x: r.x - 4, y: r.y - 4, w: r.w + 8, h: r.h + 8, act: 'open' });
    return;
  }

  const clear = isCityMapClear(life);
  const light = life.gameplaySettings?.mapLight === true;
  const p = cityMapPanelRect(hctx, GW, GH);
  const box = contentBox(p);

  if (!clear) {
    // Opaque sheet + bezel.
    hctx.fillStyle = light ? 'rgba(214, 208, 190, 0.96)' : 'rgba(16, 18, 26, 0.94)';
    hctx.fillRect(p.x, p.y, p.w, p.h);
    hctx.strokeStyle = light ? '#8b8168' : '#454a58';
    hctx.lineWidth = 1;
    hctx.strokeRect(p.x + 0.5, p.y + 0.5, p.w - 1, p.h - 1);
    // The sheet swallows taps that land on it. It's opaque, so whatever sits
    // underneath is invisible and a hit there would be a phantom. Pushed
    // BEFORE the chrome so the chips (pushed later) still win — the hit test
    // walks the list backwards. CLEAR gets no such rect on purpose: with
    // nothing drawn there, an invisible tap thief is exactly the H1281 bug.
    _rects.push({ x: p.x, y: p.y, w: p.w, h: p.h, act: 'face' });
  }

  // Roads. Bake size is rounded to even pixels so a 1px layout jitter (the
  // DOM-measured floor moves when the shifter shows/hides) can't thrash the
  // cache into re-baking every frame.
  const bakeSize = Math.max(48, Math.round(box.w / 2) * 2);
  const bake = getBake(bakeSize, clear, light, night);
  hctx.save();
  hctx.beginPath();
  hctx.rect(box.x, box.y, box.w, box.h);
  hctx.clip();
  hctx.drawImage(bake.canvas, box.x, box.y, box.w, box.h);

  // Markers, in the bake's own coordinate space: origin + worldPx * sc.
  const sc = box.w / WORLD_SPAN;
  // The minimap's marker sizes are tuned for a 140px disc; scale them with the
  // panel so pins stay proportionate instead of swelling on a big viewport.
  const ms = Math.max(0.7, Math.min(1.6, box.w / 140));
  drawWorldMarkers(hctx, box.x, box.y, sc, ms, player, life, traffic, {
    objectivesOnly: clear,
    arrow: true,
  });
  hctx.restore();

  paintChrome(hctx, p, clear, light);
}

/** Route a tap. Returns the control that was hit, or 'none'. `blocked` must
 *  match the value the same frame's draw used — see drawCityMap. */
export function handleCityMapTap(tx: number, ty: number): CityMapAct | 'none' {
  for (let i = _rects.length - 1; i >= 0; i--) {
    const r = _rects[i];
    if (tx < r.x || tx > r.x + r.w || ty < r.y || ty > r.y + r.h) continue;
    return r.act;
  }
  return 'none';
}
