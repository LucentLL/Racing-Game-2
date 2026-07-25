/**
 * H1241: Gran Turismo-style TRACK MAP for race-venue maps.
 *
 * On a circuit you do not want the city minimap — you want the shape of the
 * lap: the track as a bare outline, the start/finish line, where you are on
 * it, and where everyone else is. That is what this draws.
 *
 * Source geometry is RENDER_ENTRIES (the same polylines the world renderer
 * and the minimap bake read), NOT the config tables. On a non-city map the
 * entry list IS the track — one closed ring for the real circuits, one open
 * ribbon for a touge, a straight for the drag strip — so this stays correct
 * for free if the geometry is ever regenerated, and it needs no per-map data.
 *
 * Fit is UNIFORM into a square box (never stretched to fill), so Monza reads
 * as Monza and the drag strip reads as a straight line instead of being
 * smeared to the box aspect.
 *
 * Skipped entirely on the city — that world has a minimap and a full map.
 */
import { RENDER_ENTRIES } from '@/render/worldMap';
import { TILE } from '@/config/world/tiles';
import { getMapDef } from '@/world/mapRegistry';
import { getActiveMapId } from '@/world/mapRuntime';
import { getTrackRaceRun } from '@/sim/trackRace';

const AMBER = '255, 180, 60';

/** Box edge in HUD-canvas units. The HUD canvas is ~757x427 on desktop, so
 *  96 is a bit under a quarter of the height — big enough to read a corner
 *  sequence, small enough to fit the clear band between the top gauge and the
 *  wheel/pedal row without crowding the driving view. */
const BOX = 96;
const PAD = 10;

interface TrackMapBake {
  mapId: string;
  /** RENDER_ENTRIES.length when baked — a map switch changes it, which is
   *  the cheap invalidation signal (rebuildRenderEntries replaces the list). */
  entryCount: number;
  /** Each track polyline in 0..1 box space, flat [u0,v0,u1,v1,...]. */
  polys: number[][];
  /** Tile-space fit params, kept so live world positions (player, rivals)
   *  can be projected with the same transform the outline was baked with. */
  cx: number;
  cy: number;
  span: number;
}

let _bake: TrackMapBake | null = null;

/** Project a TILE-space point into 0..1 box space using a bake's fit. */
function proj(b: TrackMapBake, tx: number, ty: number): [number, number] {
  return [0.5 + (tx - b.cx) / b.span, 0.5 + (ty - b.cy) / b.span];
}

/** Build (or reuse) the fitted outline for the active map. */
function getBake(mapId: string): TrackMapBake | null {
  if (_bake && _bake.mapId === mapId && _bake.entryCount === RENDER_ENTRIES.length) {
    return _bake;
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const raw: number[][] = [];
  for (const entry of RENDER_ENTRIES) {
    const pts = entry.smoothed;
    if (!pts || pts.length < 4) continue;
    raw.push(pts as number[]);
    for (let i = 0; i + 1 < pts.length; i += 2) {
      const x = pts[i], y = pts[i + 1];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (raw.length === 0 || !isFinite(minX)) return null;
  // Uniform span + a little breathing room so the ribbon's stroke width
  // doesn't clip against the panel edge.
  const span = Math.max(maxX - minX, maxY - minY, 1) * 1.08;
  const b: TrackMapBake = {
    mapId,
    entryCount: RENDER_ENTRIES.length,
    polys: [],
    cx: (minX + maxX) / 2,
    cy: (minY + maxY) / 2,
    span,
  };
  for (const pts of raw) {
    const out: number[] = [];
    for (let i = 0; i + 1 < pts.length; i += 2) {
      const [u, v] = proj(b, pts[i], pts[i + 1]);
      out.push(u, v);
    }
    b.polys.push(out);
  }
  _bake = b;
  return b;
}

/** H1241: drop the cache (map switch / geometry rebuild). Cheap to call. */
export function resetTrackMap(): void {
  _bake = null;
}

/** Where the panel sits.
 *
 *  The drive HUD fills all four corners — tach and speedo on top, steering
 *  wheel and pedals on the bottom — and which bottom corner holds the wheel
 *  flips with the player's handedness. So rather than hard-code a corner, read
 *  the live DOM rects (the same trick the race readout uses to find its clear
 *  band) and sit in the vertical gap on the side AWAY from the wheel:
 *  under that side's gauge, above the wheel/pedal row.
 *
 *  Falls back to a plain top-right margin with no DOM (headless, preview). */
function panelOrigin(
  ctx: CanvasRenderingContext2D, GW: number, GH: number,
): { x: number; y: number; size: number } {
  let x = GW - BOX - PAD;
  const y = PAD;
  if (typeof document === 'undefined') return { x, y, size: BOX };
  const cv = ctx.canvas as HTMLCanvasElement | undefined;
  if (!cv || typeof cv.getBoundingClientRect !== 'function') return { x, y, size: BOX };
  const cvRect = cv.getBoundingClientRect();
  if (cvRect.width <= 0 || cvRect.height <= 0) return { x, y, size: BOX };
  const sx = GW / cvRect.width;
  const sy = GH / cvRect.height;
  const rectOf = (sel: string): DOMRect | null => {
    const el = document.querySelector(sel) as HTMLElement | null;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1 ? r : null;
  };
  const tach = rectOf('#mobileRpmSvg');
  const speedo = rectOf('#speedoSvg');
  // Everything the drive HUD parks below the gauges. The individual pedal /
  // e-brake bars, NOT their .pedal-zone container — that spans the full width
  // and would always read as an overlap on both sides.
  const obstacles = [
    rectOf('#steerBar'), rectOf('#cruiseBtn'),
    rectOf('#brkBtn'), rectOf('#gasBtn'), rectOf('#ebrkBtn'),
  ];

  /** Clear vertical band on one side: from just under that side's gauge down
   *  to the first thing in the way. The gauge bottom is a hard CEILING — the
   *  gauges are opaque DOM painted above the HUD canvas, so a panel that rides
   *  up under one is simply invisible. */
  const bandFor = (right: boolean): { x: number; ceil: number; band: number } => {
    const bx0 = right ? GW - BOX - PAD : PAD;
    const gauge = right ? speedo : tach;
    const ceil = gauge ? Math.max(PAD, (gauge.bottom - cvRect.top) * sy + 8) : PAD;
    let floor = GH - PAD;
    for (const r of obstacles) {
      if (!r) continue;
      const rx0 = (r.left - cvRect.left) * sx;
      const rx1 = (r.right - cvRect.left) * sx;
      if (rx1 < bx0 || rx0 > bx0 + BOX) continue;   // horizontally clear
      floor = Math.min(floor, (r.top - cvRect.top) * sy - 6);
    }
    return { x: bx0, ceil, band: floor - ceil };
  };

  // Take the roomier side. "Opposite the steering wheel" is NOT good enough:
  // with the wheel bottom-right the LEFT column still carries the e-brake +
  // pedal stack, which on a short viewport starts ~20px under the tach and
  // leaves less room than the wheel side does. Handedness flips which column
  // holds what, so measure both and choose.
  const left = bandFor(false);
  const right = bandFor(true);
  const pick = right.band >= left.band ? right : left;

  // Shrink to fit rather than sliding up under the gauge. MIN_BOX is the
  // legibility floor — below it a small overlap beats an unreadable map.
  const MIN_BOX = 62;
  const size = Math.max(MIN_BOX, Math.min(BOX, pick.band));
  x = pick === right ? GW - size - PAD : PAD;
  return { x, y: pick.ceil, size };
}

export interface TrackMapPlayer {
  px: number;
  py: number;
  pAngle: number;
}

/** Draw the track map. No-op on the city, or when the active map has no
 *  drawable polyline yet. */
export function drawTrackMap(
  hctx: CanvasRenderingContext2D,
  GW: number,
  GH: number,
  player: TrackMapPlayer,
  blocked: boolean,
): void {
  if (blocked) return;
  const mapId = getActiveMapId();
  if (mapId === 'city') return;
  const b = getBake(mapId);
  if (!b) return;

  const { x: bx, y: by, size } = panelOrigin(hctx, GW, GH);
  const X = (u: number): number => bx + u * size;
  const Y = (v: number): number => by + v * size;

  hctx.save();

  // Panel — same dark amber-bordered card the rest of the race HUD uses.
  // Near-opaque on purpose: at 0.66 the grass read straight through and the
  // outline stopped being legible against a bright world.
  hctx.fillStyle = 'rgba(8, 7, 4, 0.88)';
  hctx.fillRect(bx, by, size, size);
  hctx.strokeStyle = `rgba(${AMBER}, 0.85)`;
  hctx.lineWidth = 2;
  hctx.strokeRect(bx, by, size, size);

  // Track ribbon: a wide dark casing under a bright core, so the outline
  // reads as a road rather than a hairline scribble.
  hctx.lineJoin = 'round';
  hctx.lineCap = 'round';
  for (const pass of [
    { w: 6, style: 'rgba(30, 26, 16, 0.95)' },
    { w: 3, style: 'rgba(232, 232, 220, 0.92)' },
  ]) {
    hctx.strokeStyle = pass.style;
    hctx.lineWidth = pass.w;
    for (const poly of b.polys) {
      if (poly.length < 4) continue;
      hctx.beginPath();
      hctx.moveTo(X(poly[0]), Y(poly[1]));
      for (let i = 2; i + 1 < poly.length; i += 2) hctx.lineTo(X(poly[i]), Y(poly[i + 1]));
      hctx.stroke();
    }
  }

  // Start/finish line — a short bar across the track at the timing zone.
  const spec = getMapDef(mapId).race;
  if (spec) {
    const [su, sv] = proj(b, spec.startTile[0], spec.startTile[1]);
    const sx = X(su), sy = Y(sv);
    hctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
    hctx.lineWidth = 3;
    hctx.beginPath();
    hctx.moveTo(sx - 5, sy);
    hctx.lineTo(sx + 5, sy);
    hctx.stroke();
    hctx.strokeStyle = 'rgba(20, 18, 10, 0.9)';
    hctx.lineWidth = 1;
    hctx.beginPath();
    hctx.moveTo(sx - 5, sy);
    hctx.lineTo(sx + 5, sy);
    hctx.stroke();
  }

  // Rivals. Read as an array so the H1243 opp -> opps[] refactor is a
  // one-line change here rather than a rewrite.
  const run = getTrackRaceRun();
  const rivals = run?.opp ? [run.opp] : [];
  for (const o of rivals) {
    const [u, v] = proj(b, o.x / TILE, o.y / TILE);
    hctx.fillStyle = `rgba(${AMBER}, 0.95)`;
    hctx.beginPath();
    hctx.arc(X(u), Y(v), 3, 0, Math.PI * 2);
    hctx.fill();
    hctx.strokeStyle = 'rgba(20, 18, 10, 0.9)';
    hctx.lineWidth = 1;
    hctx.stroke();
  }

  // Player — a heading triangle so you can read which way you're pointed
  // after a spin, not just where you are.
  const [pu, pv] = proj(b, player.px / TILE, player.py / TILE);
  const px = X(pu), py = Y(pv);
  hctx.translate(px, py);
  hctx.rotate(player.pAngle + Math.PI / 2);
  hctx.shadowColor = 'rgba(90, 220, 255, 0.9)';
  hctx.shadowBlur = 4;
  hctx.fillStyle = 'rgba(120, 235, 255, 1)';
  hctx.strokeStyle = 'rgba(6, 20, 28, 0.95)';
  hctx.lineWidth = 1.2;
  hctx.beginPath();
  hctx.moveTo(0, -7);
  hctx.lineTo(4.8, 5.2);
  hctx.lineTo(0, 2.6);
  hctx.lineTo(-4.8, 5.2);
  hctx.closePath();
  hctx.fill();
  hctx.shadowBlur = 0;
  hctx.stroke();

  hctx.restore();
}
