/**
 * H1220: per-device HUD layout store — FFXIV-style customizable widget
 * placement (user request 2026-07-24).
 *
 * Each movable DOM widget keeps its DEFAULT position exactly as today
 * (CSS anchors, --wheel-dia sizing, RHD mirror, per-frame SVG sync) and
 * a user offset composes ON TOP as an inline `transform: translate()`.
 * Because the base mechanisms stay untouched, resize / orientation /
 * LHD-RHD swaps / render-scale changes keep working; the offset simply
 * rides along. Offsets are stored as FRACTIONS of the viewport so a
 * layout scales sanely across window sizes on the same device.
 *
 * Persistence: dedicated localStorage key (gt2NightPalette pattern) —
 * deliberately NOT a gameplaySettings field, because gameplaySettings
 * is serialized into the portable save blob (save/persistence.ts) and
 * travels with exported .json saves; a HUD layout is per-DEVICE (the
 * H1165 pcRenderScale migration is the cautionary precedent).
 */

export interface HudWidgetDef {
  id: string;
  /** Label shown on the drag box in layout mode. */
  label: string;
  /** DOM selector of the widget root. */
  sel: string;
  /** CSS base transform the widget's stylesheet relies on (composed
   *  before the user translate — e.g. the cruise pill's centering). */
  baseTransform: string;
}

/** The movable widget set (P1: DOM/SVG widgets; canvas-drawn widgets
 *  like pager/money need per-widget draw-anchor threading — later). */
export const HUD_WIDGETS: readonly HudWidgetDef[] = [
  { id: 'wheel', label: 'STEERING WHEEL', sel: '#steerBar', baseTransform: '' },
  { id: 'cruise', label: 'CRUISE', sel: '#cruiseBtn', baseTransform: 'translateX(-50%)' },
  { id: 'brake', label: 'BRAKE', sel: '#brkBtn', baseTransform: '' },
  { id: 'gas', label: 'GAS', sel: '#gasBtn', baseTransform: '' },
  { id: 'ebrk', label: 'E-BRAKE', sel: '#ebrkBtn', baseTransform: '' },
  { id: 'shifter', label: 'SHIFTER', sel: '#shiftKnob', baseTransform: '' },
  { id: 'speedo', label: 'SPEEDOMETER', sel: '#speedoSvg', baseTransform: '' },
  { id: 'rpm', label: 'TACHOMETER', sel: '#mobileRpmSvg', baseTransform: '' },
];

/** Viewport-fraction offset from the widget's default position. */
export interface HudOffset { fx: number; fy: number }
export type HudLayoutMap = Record<string, HudOffset>;

const STORAGE_KEY = 'driverCity_hudLayout_v1';

let _offsets: HudLayoutMap = loadStoredLayout();

function loadStoredLayout(): HudLayoutMap {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as { v?: number; off?: Record<string, { fx?: unknown; fy?: unknown }> };
    if (!parsed || parsed.v !== 1 || typeof parsed.off !== 'object' || !parsed.off) return {};
    const out: HudLayoutMap = {};
    for (const [id, o] of Object.entries(parsed.off)) {
      const fx = Number(o?.fx);
      const fy = Number(o?.fy);
      if (!Number.isFinite(fx) || !Number.isFinite(fy)) continue;
      // Sanity clamp: an offset can never exceed one full viewport.
      out[id] = { fx: Math.max(-1, Math.min(1, fx)), fy: Math.max(-1, Math.min(1, fy)) };
    }
    return out;
  } catch {
    return {}; // corrupted / private-mode — defaults
  }
}

export function getHudOffsets(): HudLayoutMap {
  const copy: HudLayoutMap = {};
  for (const [k, v] of Object.entries(_offsets)) copy[k] = { ...v };
  return copy;
}

/** Replace the WORKING offsets (no persistence) and re-apply. Used by
 *  the layout editor for live drag + cancel-restore. */
export function setHudOffsets(next: HudLayoutMap): void {
  _offsets = {};
  for (const [k, v] of Object.entries(next)) _offsets[k] = { ...v };
  applyHudLayout();
}

/** Persist the current working offsets to this device. */
export function saveHudLayout(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const off: HudLayoutMap = {};
    for (const [k, v] of Object.entries(_offsets)) {
      if (v.fx !== 0 || v.fy !== 0) off[k] = v;
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ v: 1, off }));
  } catch {
    // write rejected — layout lasts the session only
  }
}

function widgetEl(def: HudWidgetDef): HTMLElement | null {
  return document.querySelector<HTMLElement>(def.sel);
}

/** Compose base + user translate onto one widget. Empty offset clears
 *  the inline transform so the stylesheet default fully owns it again. */
function applyOne(def: HudWidgetDef, off: HudOffset | undefined): void {
  const el = widgetEl(def);
  if (!el) return;
  if (!off || (off.fx === 0 && off.fy === 0)) {
    el.style.transform = '';
    return;
  }
  const dx = Math.round(off.fx * window.innerWidth);
  const dy = Math.round(off.fy * window.innerHeight);
  el.style.transform = `${def.baseTransform} translate(${dx}px, ${dy}px)`.trim();
}

/** Apply all stored offsets. Called at boot, on resize (fractions →
 *  px against the new viewport), and by the layout editor during drags. */
export function applyHudLayout(): void {
  for (const def of HUD_WIDGETS) applyOne(def, _offsets[def.id]);
}

/** Set one widget's offset in raw px (drag math) — converted to
 *  viewport fractions internally. */
export function setWidgetOffsetPx(id: string, dxPx: number, dyPx: number): void {
  const def = HUD_WIDGETS.find((w) => w.id === id);
  if (!def) return;
  const vw = Math.max(1, window.innerWidth);
  const vh = Math.max(1, window.innerHeight);
  _offsets[id] = { fx: dxPx / vw, fy: dyPx / vh };
  applyOne(def, _offsets[id]);
}

export function getWidgetOffsetPx(id: string): { dx: number; dy: number } {
  const off = _offsets[id];
  if (!off) return { dx: 0, dy: 0 };
  return {
    dx: Math.round(off.fx * window.innerWidth),
    dy: Math.round(off.fy * window.innerHeight),
  };
}

/** Clear all offsets (working state only — SAVE persists). */
export function resetHudOffsets(): void {
  _offsets = {};
  applyHudLayout();
}
