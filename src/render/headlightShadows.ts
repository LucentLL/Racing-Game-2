/**
 * Night pass — ambient tint, street-light pools, and the player's
 * Pass A headlight shadow cast.
 *
 * Ported from render() of the v8.99.126.89 monolith:
 *   - drawNightTint            — L32889–32937 (slot-based ambient overlay)
 *   - drawStreetLightPools     — L32938–33009 (intersection white punch +
 *                                              warm tint pass)
 *   - drawHeadlightConesPassA  — L32359–32700 (the pre-night-tint player
 *                                              cone with full body-and-
 *                                              tire shadow casting)
 *
 * The remaining cone passes (Pass B player on-tint, traffic + race + AI-tow
 * cones, rim-light illumination on traffic) live in C18c — they need the
 * carBody renderer order from C19 to wire correctly.
 *
 * Shadow-casting primitives (drawSoftCone, rectCornersWS, castShadowPoly,
 * castParallelShadow, tireRectsWS) come from engine/shadows.ts.
 */

import type { FrameView } from './types';
import {
  drawSoftCone,
  rectCornersWS,
  castParallelShadow,
  tireRectsWS,
  type Point2,
} from '@/engine/shadows';
import type { RoadCrossing } from './intersections';

// ---- Types ----------------------------------------------------------------

export type TimeSlot = 'morning' | 'afternoon' | 'evening' | 'night' | string;

export interface NightTintDeps {
  /** WORLD_GW * GH rect to tint each frame. */
  WORLD_GW: number;
  GH: number;
  /** Current outing's running session timer (seconds since outing start). */
  sessionTimer: number;
  /** Day/time slot ('morning'|'afternoon'|'evening'|'night'). */
  timeSlot: TimeSlot;
  /** When player is on the home screen, show the slot's ambient color. */
  isHomeScreenAmbient: boolean;
  /** Slot → hour-of-day map (used by home-screen ambient). */
  slotHours: Readonly<Record<string, number>>;
}

export interface StreetLightDeps {
  TILE: number;
  WORLD_GW: number;
  GH: number;
  /** Active camera transform parameters. */
  camY: number;
  ZOOM: number;
  pCamAngle: number;
  smoothFocusX: number;
  smoothFocusY: number;
  /** Road crossings to drop pools at. */
  crossings: ReadonlyArray<RoadCrossing>;
  /** Strength multiplier from the ambient tint pass (0..1). */
  punchStrength: number;
  /** Night-vision fault multiplier (_faultFX.nightVisMult). 1 = normal. */
  nightVisMult: number;
}

/** Vehicle occluder used by the headlight shadow cast. */
export interface HeadlightOccluder {
  /** World position of the occluder center. */
  x: number;
  y: number;
  /** Body angle (radians). */
  ang: number;
  /** Half-length / half-width (world units). */
  hl: number;
  hw: number;
  /** True for bikes (single tire pair). */
  isBike: boolean;
  /** True for the 53' / traffic semi trailer (4-tire tandem). */
  isTrailer?: boolean;
  /** When set, the sprite is drawn into the mask for the body cutout —
   *  preserves transparent-corner silhouettes. Null = use the L×W rect. */
  spriteKey?: string | null;
}

export interface TrafficCarForHeadlights {
  x: number;
  y: number;
  angle: number;
  bodyType: string;
  bikeSpriteKey?: string;
  _despawned?: boolean;
  tTrailer?: {
    angle?: number;
    length: number;
    width: number;
  } | null;
}

export interface RaceOpponent {
  active: boolean;
  phase: string;
  oppX: number;
  oppY: number;
  oppAngle: number;
}

/** Off-screen mask canvas state — shared between Pass A and Pass B. */
export interface MaskCanvas {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
}

export interface HeadlightPassADeps {
  WORLD_GW: number;
  GH: number;
  /** Camera transform (must match the one applied to the main ctx). */
  camY: number;
  ZOOM: number;
  pCamAngle: number;
  smoothFocusX: number;
  smoothFocusY: number;
  /** Player pose for headlight origin. */
  px: number;
  py: number;
  drawX: number;
  drawY: number;
  pAngle: number;
  pSpeed: number;
  /** Player car size [length, width] (CAR().size). */
  playerCarSize: readonly [number, number];
  /** True for bikes (cone emitted from center, not perpendicular pair). */
  playerIsBike: boolean;
  /** Player sprite key for the body cutout silhouette. */
  playerSpriteKey: string | null;
  /** Optional trailer pose (53' player trailer). */
  playerTrailer: { angle: number; length: number; width: number } | null;
  /** Night factor 0..1 — gates the whole pass (skipped if < 0.05). */
  nf: number;
  /** True if either headlight bulb is faulted. */
  leftHeadlightOut: boolean;
  rightHeadlightOut: boolean;
  /** X-ray body mode — skips body-rect cuts (still draws tire shadows). */
  xrayBody: boolean;
  /** AI tow truck state — pass A is skipped while the player is being
   *  loaded onto / transported by the AI tow. */
  incomingTowPhase: string | null;
  /** Traffic + race opponent (for shadow casting from forward occluders). */
  traffic: ReadonlyArray<TrafficCarForHeadlights>;
  race: RaceOpponent;
  /** Mask canvas (lazy-allocated, persists across frames). */
  mask: MaskCanvas;
  /** Sprite resolver — used by the silhouette body cutout. */
  getVehicleSprite(key: string, _someFlag: boolean): HTMLCanvasElement | HTMLImageElement | null;
  /** Bridge-deck punch — clears the mask under bridge decks the player is
   *  driving beneath so cones don't paint upward through the bridge. */
  bridgePunchDeckFromMask(mctx: CanvasRenderingContext2D): void;
}

// ---- Night ambient tint ---------------------------------------------------

/** Slot-based ambient color and target alpha. */
interface AmbientTint { r: number; g: number; b: number; a: number; }

/** Returns the slot-based ambient tint plus the strength used to gate the
 *  light-punch pass that follows. */
export function computeNightTint(deps: NightTintDeps): AmbientTint {
  const { sessionTimer: st, timeSlot: slot, isHomeScreenAmbient, slotHours } = deps;
  let r = 0, g = 0, b = 0, a = 0;

  if (slot === 'morning') {
    if (st < 60) {
      const t = st / 60;
      r = 10; g = 10; b = 40; a = 0.40 - t * 0.20;
    } else if (st < 90) {
      const t = (st - 60) / 30;
      r = Math.round(200 - t * 120);
      g = Math.round(120 - t * 80);
      b = Math.round(50 - t * 30);
      a = 0.20 - t * 0.16;
    } else {
      r = 255; g = 240; b = 200; a = 0.02;
    }
  } else if (slot === 'afternoon') {
    if (st < 180) {
      r = 255; g = 240; b = 200; a = 0.02;
    } else if (st < 300) {
      const t = (st - 180) / 120;
      r = Math.round(255 - 175 * t);
      g = Math.round(240 - 200 * t);
      b = Math.round(200 - 190 * t);
      a = 0.02 + t * 0.10;
    } else {
      r = 80; g = 40; b = 10; a = 0.12;
    }
  } else {
    // 'night' (and 'evening' fallthrough) — always dark.
    r = 5; g = 5; b = 25; a = 0.65;
  }

  if (isHomeScreenAmbient) {
    const hs = slotHours[slot] || 5;
    if (hs >= 21 || hs < 5) { r = 5;   g = 5;   b = 25;  a = 0.55; }
    else if (hs >= 12)      { r = 255; g = 240; b = 200; a = 0.02; }
    else                    { r = 20;  g = 30;  b = 80;  a = 0.25; }
  }

  return { r, g, b, a };
}

export function drawNightTint(
  ctx: CanvasRenderingContext2D,
  _view: FrameView,
  deps: NightTintDeps,
): number {
  const tint = computeNightTint(deps);
  if (tint.a > 0.005) {
    ctx.fillStyle = `rgba(${tint.r},${tint.g},${tint.b},${tint.a})`;
    ctx.fillRect(0, 0, deps.WORLD_GW, deps.GH);
  }
  return tint.a;
}

// ---- Street-light pools ---------------------------------------------------

/** Paints destination-out white circles at minor-road intersections, then
 *  overlays a warm tint at 60% radius. Skipped at any crossing involving
 *  a major (w >= 8) road — real interstates don't have city-grid blanket
 *  lighting. */
export function drawStreetLightPools(
  ctx: CanvasRenderingContext2D,
  _view: FrameView,
  deps: StreetLightDeps,
): void {
  const { TILE, camY, ZOOM, pCamAngle, smoothFocusX, smoothFocusY, crossings,
          punchStrength, nightVisMult, WORLD_GW, GH } = deps;

  // ---- White punch pass --------------------------------------------------
  ctx.globalCompositeOperation = 'destination-out';
  ctx.save();
  ctx.translate(WORLD_GW / 2, camY);
  ctx.scale(ZOOM, ZOOM);
  ctx.rotate(-pCamAngle - Math.PI / 2);
  ctx.translate(-smoothFocusX, -smoothFocusY);
  const slViewR = Math.max(WORLD_GW, GH) / ZOOM + 20;
  const slViewR2 = slViewR * slViewR;
  for (const c of crossings) {
    if (c.r1w >= 8 || c.r2w >= 8) continue;
    const sdx = c.x - smoothFocusX;
    const sdy = c.y - smoothFocusY;
    if (sdx * sdx + sdy * sdy > slViewR2) continue;
    const slR = Math.max(10, Math.min(22, (c.r1w + c.r2w) * TILE * 0.4));
    const slGrd = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, slR);
    slGrd.addColorStop(0,   `rgba(255,255,255,${punchStrength * 0.3 * nightVisMult})`);
    slGrd.addColorStop(0.6, `rgba(255,255,255,${punchStrength * 0.12 * nightVisMult})`);
    slGrd.addColorStop(1,   'rgba(255,255,255,0)');
    ctx.fillStyle = slGrd;
    ctx.beginPath();
    ctx.arc(c.x, c.y, slR, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  ctx.globalCompositeOperation = 'source-over';

  // ---- Warm tint overlay -------------------------------------------------
  ctx.save();
  ctx.translate(WORLD_GW / 2, camY);
  ctx.scale(ZOOM, ZOOM);
  ctx.rotate(-pCamAngle - Math.PI / 2);
  ctx.translate(-smoothFocusX, -smoothFocusY);
  for (const c of crossings) {
    if (c.r1w >= 8 || c.r2w >= 8) continue;
    const sdx = c.x - smoothFocusX;
    const sdy = c.y - smoothFocusY;
    if (sdx * sdx + sdy * sdy > slViewR2) continue;
    const slR = Math.max(10, Math.min(22, (c.r1w + c.r2w) * TILE * 0.4));
    const wtGrd = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, slR * 0.7);
    wtGrd.addColorStop(0, 'rgba(255,220,150,0.06)');
    wtGrd.addColorStop(1, 'rgba(255,220,150,0)');
    ctx.fillStyle = wtGrd;
    ctx.beginPath();
    ctx.arc(c.x, c.y, slR * 0.7, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

// ---- Mask canvas ----------------------------------------------------------

/** Lazy-allocates / resizes the off-screen mask canvas. Idempotent — call
 *  this before either Pass A or Pass B writes to mask.ctx. */
export function ensureMaskCanvas(
  main: HTMLCanvasElement,
  mask: MaskCanvas | null,
): MaskCanvas {
  if (!mask) {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Mask canvas 2D context unavailable');
    if (ctx.imageSmoothingEnabled !== undefined) ctx.imageSmoothingEnabled = false;
    canvas.width = main.width;
    canvas.height = main.height;
    return { canvas, ctx };
  }
  if (mask.canvas.width !== main.width || mask.canvas.height !== main.height) {
    mask.canvas.width = main.width;
    mask.canvas.height = main.height;
    if (mask.ctx.imageSmoothingEnabled !== undefined) {
      mask.ctx.imageSmoothingEnabled = false;
    }
  }
  return mask;
}

// ---- Player Pass A headlight cone + shadows -------------------------------

/** Builds the occluder list — traffic + race opponent + player + player
 *  trailer — within the pre-cull radius. */
function buildOccluders(
  deps: HeadlightPassADeps,
  beamX: number,
  beamY: number,
  hlLen: number,
): HeadlightOccluder[] {
  const occluders: HeadlightOccluder[] = [];
  const preCullR = hlLen * 4.0 + 50;
  const preCullR2 = preCullR * preCullR;

  for (const ct of deps.traffic) {
    if (ct._despawned) continue;
    const cdx = ct.x - beamX;
    const cdy = ct.y - beamY;
    const cabIn = cdx * cdx + cdy * cdy <= preCullR2;
    let trIn = false;
    let ctrAng = 0, ctrCX = 0, ctrCY = 0;
    if (ct.tTrailer) {
      const ctr = ct.tTrailer;
      const cfwX = ct.x - Math.cos(ct.angle) * 6;
      const cfwY = ct.y - Math.sin(ct.angle) * 6;
      ctrAng = ctr.angle != null ? ctr.angle : ct.angle;
      ctrCX = cfwX - Math.cos(ctrAng) * (ctr.length / 2);
      ctrCY = cfwY - Math.sin(ctrAng) * (ctr.length / 2);
      const tdx = ctrCX - beamX;
      const tdy = ctrCY - beamY;
      trIn = tdx * tdx + tdy * tdy <= preCullR2;
    }
    if (!cabIn && !trIn) continue;
    if (cabIn) {
      const bt = ct.bodyType;
      const ctHL =
        bt === 'semi'     ? 17   :
        bt === 'boxtruck' ? 16.5 :
        bt === 'towtruck' ? 19.25:
        bt === 'bike'     ? 7    : 10;
      const ctHW =
        bt === 'semi'     ? 6    :
        bt === 'boxtruck' ? 5.5  :
        bt === 'towtruck' ? 5.85 :
        bt === 'bike'     ? 2.5  : 4;
      // Bikes need the per-spawn `bikeSpriteKey` because 'bike' isn't a
      // sprite key on its own (the four bike sprites are kawasaki_ninja /
      // honda_cb500 / suzuki_bandit / suzuki_katana).
      const spriteKey = bt === 'bike' ? (ct.bikeSpriteKey || null) : bt;
      occluders.push({
        x: ct.x, y: ct.y, ang: ct.angle,
        hl: ctHL, hw: ctHW,
        isBike: bt === 'bike',
        spriteKey,
      });
    }
    if (trIn && ct.tTrailer) {
      const ctr = ct.tTrailer;
      occluders.push({
        x: ctrCX, y: ctrCY, ang: ctrAng,
        hl: ctr.length / 2, hw: ctr.width / 2,
        isBike: false, isTrailer: true,
      });
    }
  }

  const race = deps.race;
  if (race.active && (race.phase === 'countdown' || race.phase === 'racing')) {
    const rdx = race.oppX - beamX;
    const rdy = race.oppY - beamY;
    if (rdx * rdx + rdy * rdy <= preCullR2) {
      occluders.push({
        x: race.oppX, y: race.oppY, ang: race.oppAngle,
        hl: 10, hw: 4, isBike: false,
      });
    }
  }

  // Player + player trailer always go in (so cone never paints on own body).
  const pSize = deps.playerCarSize;
  occluders.push({
    x: deps.drawX, y: deps.drawY, ang: deps.pAngle,
    hl: pSize[0] / 2, hw: pSize[1] / 2,
    isBike: deps.playerIsBike,
    spriteKey: deps.playerSpriteKey,
  });
  const pt = deps.playerTrailer;
  if (pt) {
    const pfwX = deps.drawX - Math.cos(deps.pAngle) * 6;
    const pfwY = deps.drawY - Math.sin(deps.pAngle) * 6;
    const ptrCX = pfwX - Math.cos(pt.angle) * (pt.length / 2);
    const ptrCY = pfwY - Math.sin(pt.angle) * (pt.length / 2);
    occluders.push({
      x: ptrCX, y: ptrCY, ang: pt.angle,
      hl: pt.length / 2, hw: pt.width / 2,
      isBike: false, isTrailer: true,
    });
  }
  return occluders;
}

/** Draws warm halogen cones (player) onto the mask. v126.89 renders only
 *  the outer ambient cone — the inner "strong beam" core was removed in
 *  v8.99.123.94. */
function drawPlayerConesToMask(
  mctx: CanvasRenderingContext2D,
  deps: HeadlightPassADeps,
  beamX: number,
  beamY: number,
  hlLen: number,
  beamAlpha: number,
): void {
  if (deps.playerIsBike) {
    const grad = mctx.createRadialGradient(beamX, beamY, 0, beamX, beamY, hlLen * 4.0);
    grad.addColorStop(0,   'rgba(255,204,119,1)');
    grad.addColorStop(0.2, 'rgba(255,204,119,0.6)');
    grad.addColorStop(0.5, 'rgba(255,204,119,0.2)');
    grad.addColorStop(1,   'rgba(255,204,119,0)');
    mctx.globalAlpha = beamAlpha * 0.5;
    mctx.fillStyle = grad;
    drawSoftCone(mctx, beamX, beamY, deps.pAngle, 0.40, hlLen * 4.0);
  } else {
    const perp = Math.PI / 2;
    const hw = deps.playerCarSize[1] / 2;
    for (const side of [-1, 1]) {
      if (side === -1 && deps.leftHeadlightOut) continue;
      if (side ===  1 && deps.rightHeadlightOut) continue;
      const ox = beamX + Math.cos(deps.pAngle + perp) * side * (hw - 1);
      const oy = beamY + Math.sin(deps.pAngle + perp) * side * (hw - 1);
      const grad = mctx.createRadialGradient(ox, oy, 0, ox, oy, hlLen * 4.0);
      grad.addColorStop(0,   'rgba(255,204,119,1)');
      grad.addColorStop(0.2, 'rgba(255,204,119,0.6)');
      grad.addColorStop(0.5, 'rgba(255,204,119,0.2)');
      grad.addColorStop(1,   'rgba(255,204,119,0)');
      mctx.globalAlpha = beamAlpha * 0.5;
      mctx.fillStyle = grad;
      drawSoftCone(mctx, ox, oy, deps.pAngle, 0.36, hlLen * 4.0);
    }
  }
}

/** Player Pass A — pre-tint headlight cones with body + tire shadow casting.
 *  Renders to an off-screen mask canvas with vehicle bodies cut out, then
 *  composites the result onto the main canvas. */
export function drawHeadlightConesPassA(
  ctx: CanvasRenderingContext2D,
  _view: FrameView,
  deps: HeadlightPassADeps,
): void {
  // Skip during AI-tow loading/departing (cone would paint over the tow
  // animation in a confusing way). Arriving/reversing are fine — the
  // player car is still in its own pose.
  const phase = deps.incomingTowPhase;
  if (phase && phase !== 'arriving' && phase !== 'reversing') return;
  if (deps.nf <= 0.05) return;

  const hlLen = 20 + Math.abs(deps.pSpeed) * 0.1;
  const carHL = deps.playerCarSize[0] / 2;
  const originX = deps.playerIsBike ? deps.drawX : deps.px;
  const originY = deps.playerIsBike ? deps.drawY : deps.py;
  const beamX = originX + Math.cos(deps.pAngle) * carHL;
  const beamY = originY + Math.sin(deps.pAngle) * carHL;
  const beamAlpha = deps.nf * 0.32;

  // ---- Set up mask canvas + apply world transform -----------------------
  const mask = ensureMaskCanvas(ctx.canvas, deps.mask);
  const mctx = mask.ctx;
  mctx.setTransform(1, 0, 0, 1, 0, 0);
  mctx.globalCompositeOperation = 'source-over';
  mctx.globalAlpha = 1;
  mctx.clearRect(0, 0, mask.canvas.width, mask.canvas.height);
  mctx.translate(deps.WORLD_GW / 2, deps.camY);
  mctx.scale(deps.ZOOM, deps.ZOOM);
  mctx.rotate(-deps.pCamAngle - Math.PI / 2);
  mctx.translate(-deps.smoothFocusX, -deps.smoothFocusY);

  // ---- Draw cone triangles ----------------------------------------------
  drawPlayerConesToMask(mctx, deps, beamX, beamY, hlLen, beamAlpha);

  // ---- Build occluder list ----------------------------------------------
  const occluders = buildOccluders(deps, beamX, beamY, hlLen);

  // ---- Step 1: cut body rects for occluders BEHIND beam origin ----------
  // (Player + trailer only — keeps the cone from ever painting on its own
  //  body. Forward traffic bodies are NOT cut here; step 2 handles them.)
  mctx.globalCompositeOperation = 'destination-out';
  mctx.globalAlpha = 1;
  const bdCos = Math.cos(deps.pAngle);
  const bdSin = Math.sin(deps.pAngle);
  for (const occ of occluders) {
    if ((occ.x - beamX) * bdCos + (occ.y - beamY) * bdSin > 0) continue;
    mctx.save();
    mctx.translate(occ.x, occ.y);
    mctx.rotate(occ.ang);
    const sprite = occ.spriteKey ? deps.getVehicleSprite(occ.spriteKey, false) : null;
    if (sprite) {
      mctx.drawImage(sprite, -occ.hl, -occ.hw, occ.hl * 2, occ.hw * 2);
    } else {
      mctx.fillStyle = 'rgba(0,0,0,1)';
      mctx.fillRect(-occ.hl, -occ.hw, occ.hl * 2, occ.hw * 2);
    }
    mctx.restore();
  }

  // ---- Step 2: body shadows past forward occluders ----------------------
  const shadowFarR = hlLen * 1.5;
  for (const occ of occluders) {
    if ((occ.x - beamX) * bdCos + (occ.y - beamY) * bdSin <= 0) continue;
    const ddx = occ.x - beamX;
    const ddy = occ.y - beamY;
    const distC = Math.hypot(ddx, ddy);
    if (distC < 0.001) continue;
    const ndx = ddx / distC;
    const ndy = ddy / distC;
    const bc = rectCornersWS(occ.x, occ.y, occ.ang, occ.hl, occ.hw);
    // Body's far d-offset from center along the beam→occluder direction.
    // Shadow polygon starts at this d to avoid seam/overlap with the rect.
    let bodyFarD = -Infinity;
    for (const c of bc) {
      const di = (c[0] - occ.x) * ndx + (c[1] - occ.y) * ndy;
      if (di > bodyFarD) bodyFarD = di;
    }
    const bodyFarDFromLight = distC + bodyFarD;

    // Step 2a: solid alpha-1 cut of the body rect (skipped in x-ray).
    if (!deps.xrayBody) {
      mctx.save();
      mctx.translate(occ.x, occ.y);
      mctx.rotate(occ.ang);
      const sprite = occ.spriteKey ? deps.getVehicleSprite(occ.spriteKey, false) : null;
      if (sprite) {
        mctx.drawImage(sprite, -occ.hl, -occ.hw, occ.hl * 2, occ.hw * 2);
      } else {
        mctx.fillStyle = 'rgba(0,0,0,1)';
        mctx.fillRect(-occ.hl, -occ.hw, occ.hl * 2, occ.hw * 2);
      }
      mctx.restore();
    }

    // Step 2b: body-shadow polygon past body at alpha 0.75. Leaves 25% of
    // cone alive in the body-shadow wedge — models light leaking under
    // the undercarriage; step 3 then drops hard tire shadows into that
    // dim strip.
    mctx.fillStyle = 'rgba(0,0,0,0.75)';
    castParallelShadow(mctx, occ.x, occ.y, bc as Point2[], ndx, ndy,
                       beamX, beamY, bodyFarDFromLight, shadowFarR);
  }

  // ---- Step 3: tire shadows (parallel, hard alpha) ----------------------
  mctx.fillStyle = 'rgba(0,0,0,1)';
  for (const occ of occluders) {
    if ((occ.x - beamX) * bdCos + (occ.y - beamY) * bdSin <= 0) continue;
    const ddx = occ.x - beamX;
    const ddy = occ.y - beamY;
    if (Math.hypot(ddx, ddy) < 0.001) continue;
    const tires = tireRectsWS(occ.x, occ.y, occ.ang, occ.hl, occ.hw,
                              occ.isBike, !!occ.isTrailer);
    for (const t of tires) {
      const tdx = t.x - beamX;
      const tdy = t.y - beamY;
      const tDist = Math.hypot(tdx, tdy);
      if (tDist < 0.001) continue;
      const tNdx = tdx / tDist;
      const tNdy = tdy / tDist;
      const tc = rectCornersWS(t.x, t.y, t.ang, t.hl, t.hw);
      castParallelShadow(mctx, t.x, t.y, tc as Point2[], tNdx, tNdy,
                         beamX, beamY, 0, shadowFarR);
    }
  }

  // ---- Bridge deck punch -----------------------------------------------
  // Must run while mctx is still in world-space transform.
  deps.bridgePunchDeckFromMask(mctx);

  // ---- Composite mask onto main canvas ---------------------------------
  mctx.globalCompositeOperation = 'source-over';
  mctx.globalAlpha = 1;
  mctx.setTransform(1, 0, 0, 1, 0, 0);

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.drawImage(mask.canvas, 0, 0);
  ctx.restore();
  ctx.globalAlpha = 1;
}
