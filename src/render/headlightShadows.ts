/**
 * Night pass — ambient tint, street-light pools, headlight cones, taillight
 * halos, traffic vehicle lights, and rim-light illumination.
 *
 * Ported from render() of the v8.99.126.89 monolith:
 *   - drawNightTint                         — L32889–32937
 *   - drawStreetLightPools                  — L32938–33009
 *   - drawHeadlightConesPassA               — L32359–32700
 *   - drawHeadlightConesPassB               — L33011–33304
 *   - drawPlayerTaillights                  — L33305–33504
 *   - drawTrafficHeadlightCones             — L33506–33680
 *   - drawHeadlightIlluminationOnTraffic    — L33681–33740
 *
 * Pass A and Pass B both run the player headlight cone — A in pre-tint
 * source-over (the warm yellow cone on the world ground before night tint
 * darkens it) and B on top of the dark night tint with 'lighter' composite
 * (so the cone visibly brightens). Both produce body + tire shadow shapes;
 * Pass B uses cheaper rect cuts (no sprite-alpha — perf-reverted v123.04).
 *
 * Shadow-casting primitives (drawSoftCone, rectCornersWS, castParallelShadow,
 * tireRectsWS) come from engine/shadows.ts.
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

// ---- Pass B player headlight cones (post-tint, 'lighter' composite) -------

export interface HeadlightPassBDeps extends HeadlightPassADeps {
  /** Same shape as Pass A. Kept as an alias so the orchestrator can pass
   *  the same deps object to both passes without rebuilding. */
}

/** Draws Pass B player cones (orange-amber instead of warm yellow) onto
 *  the mask. v126.89 keeps only the outer ambient cone. */
function drawPlayerConesPassBToMask(
  mctx: CanvasRenderingContext2D,
  deps: HeadlightPassADeps,
  beamX: number,
  beamY: number,
  hlLen: number,
  bI: number,
): void {
  if (deps.playerIsBike) {
    const grad = mctx.createRadialGradient(beamX, beamY, 0, beamX, beamY, hlLen * 4.0);
    grad.addColorStop(0,   'rgba(255,185,115,1)');
    grad.addColorStop(0.2, 'rgba(255,185,115,0.6)');
    grad.addColorStop(0.5, 'rgba(255,185,115,0.2)');
    grad.addColorStop(1,   'rgba(255,185,115,0)');
    mctx.globalAlpha = bI * 0.55;
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
      grad.addColorStop(0,   'rgba(255,185,115,1)');
      grad.addColorStop(0.2, 'rgba(255,185,115,0.6)');
      grad.addColorStop(0.5, 'rgba(255,185,115,0.2)');
      grad.addColorStop(1,   'rgba(255,185,115,0)');
      mctx.globalAlpha = bI * 0.55;
      mctx.fillStyle = grad;
      drawSoftCone(mctx, ox, oy, deps.pAngle, 0.32, hlLen * 4.0);
    }
  }
}

/** Pass B occluder builder. Same structure as Pass A but without sprite
 *  keys (v123.04 perf revert — Pass B uses fillRect-only cuts because the
 *  drawImage sprite-alpha path roughly doubled per-frame drawImage count
 *  for negligible visual gain since Pass A already shapes the halo). */
function buildOccludersPassB(
  deps: HeadlightPassBDeps,
  beamX: number,
  beamY: number,
  hlLen: number,
): HeadlightOccluder[] {
  const occluders: HeadlightOccluder[] = [];
  const cullR = hlLen * 4.0 + 50;
  const cullR2 = cullR * cullR;

  for (const ct of deps.traffic) {
    if (ct._despawned) continue;
    const cdx = ct.x - beamX;
    const cdy = ct.y - beamY;
    const cabIn = cdx * cdx + cdy * cdy <= cullR2;
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
      trIn = tdx * tdx + tdy * tdy <= cullR2;
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
      occluders.push({
        x: ct.x, y: ct.y, ang: ct.angle,
        hl: ctHL, hw: ctHW,
        isBike: bt === 'bike',
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
    if (rdx * rdx + rdy * rdy <= cullR2) {
      occluders.push({
        x: race.oppX, y: race.oppY, ang: race.oppAngle,
        hl: 10, hw: 4, isBike: false,
      });
    }
  }

  const pSize = deps.playerCarSize;
  occluders.push({
    x: deps.drawX, y: deps.drawY, ang: deps.pAngle,
    hl: pSize[0] / 2, hw: pSize[1] / 2,
    isBike: deps.playerIsBike,
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

/** Player Pass B — post-tint headlight cones with body + tire shadow
 *  casting, composited via 'lighter' so the cone visibly brightens the
 *  night-tinted world. */
export function drawHeadlightConesPassB(
  ctx: CanvasRenderingContext2D,
  _view: FrameView,
  deps: HeadlightPassBDeps,
): void {
  if (deps.nf <= 0.05) return;
  const phase = deps.incomingTowPhase;
  if (phase && phase !== 'arriving' && phase !== 'reversing') return;

  const hlLen = 20 + Math.abs(deps.pSpeed) * 0.1;
  const carHL = deps.playerCarSize[0] / 2;
  const originX = deps.playerIsBike ? deps.drawX : deps.px;
  const originY = deps.playerIsBike ? deps.drawY : deps.py;
  const beamX = originX + Math.cos(deps.pAngle) * carHL;
  const beamY = originY + Math.sin(deps.pAngle) * carHL;
  const bI = deps.nf * 0.32;

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

  drawPlayerConesPassBToMask(mctx, deps, beamX, beamY, hlLen, bI);

  const occluders = buildOccludersPassB(deps, beamX, beamY, hlLen);

  // Step 1: cut body rects for occluders BEHIND beam origin (fillRect only).
  mctx.globalCompositeOperation = 'destination-out';
  mctx.globalAlpha = 1;
  mctx.fillStyle = 'rgba(0,0,0,1)';
  const bdCos = Math.cos(deps.pAngle);
  const bdSin = Math.sin(deps.pAngle);
  for (const occ of occluders) {
    if ((occ.x - beamX) * bdCos + (occ.y - beamY) * bdSin > 0) continue;
    mctx.save();
    mctx.translate(occ.x, occ.y);
    mctx.rotate(occ.ang);
    mctx.fillRect(-occ.hl, -occ.hw, occ.hl * 2, occ.hw * 2);
    mctx.restore();
  }

  // Step 2: body shadows past forward occluders + step 3: tire shadows.
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
    let bodyFarD = -Infinity;
    for (const c of bc) {
      const di = (c[0] - occ.x) * ndx + (c[1] - occ.y) * ndy;
      if (di > bodyFarD) bodyFarD = di;
    }
    const bodyFarDFromLight = distC + bodyFarD;

    if (!deps.xrayBody) {
      mctx.fillStyle = 'rgba(0,0,0,1)';
      mctx.save();
      mctx.translate(occ.x, occ.y);
      mctx.rotate(occ.ang);
      mctx.fillRect(-occ.hl, -occ.hw, occ.hl * 2, occ.hw * 2);
      mctx.restore();
    }
    mctx.fillStyle = 'rgba(0,0,0,0.75)';
    castParallelShadow(mctx, occ.x, occ.y, bc as Point2[], ndx, ndy,
                       beamX, beamY, bodyFarDFromLight, shadowFarR);
  }

  mctx.fillStyle = 'rgba(0,0,0,1)';
  for (const occ of occluders) {
    if ((occ.x - beamX) * bdCos + (occ.y - beamY) * bdSin <= 0) continue;
    if (Math.hypot(occ.x - beamX, occ.y - beamY) < 0.001) continue;
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

  deps.bridgePunchDeckFromMask(mctx);

  // Reset mask, composite with 'lighter' to brighten night-tinted world.
  mctx.globalCompositeOperation = 'source-over';
  mctx.globalAlpha = 1;
  mctx.setTransform(1, 0, 0, 1, 0, 0);

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = 1;
  ctx.drawImage(mask.canvas, 0, 0);
  ctx.restore();
}

// ---- Player taillight halos (running + brake + reverse) -------------------

export interface PlayerTaillightsDeps {
  WORLD_GW: number;
  camY: number;
  ZOOM: number;
  pCamAngle: number;
  smoothFocusX: number;
  smoothFocusY: number;
  /** Player rear-bumper origin reference. */
  px: number;
  py: number;
  drawX: number;
  drawY: number;
  pAngle: number;
  playerCarSize: readonly [number, number];
  playerIsBike: boolean;
  playerTrailer: { angle: number; length: number; width: number } | null;
  /** Driver-intent reverse flag (NOT velocity sign — real reverse lamps fire
   *  on gear selector, not on rollback velocity). */
  isReversing: boolean;
  isBraking: boolean;
  /** Per-side taillight fault flags. */
  leftTaillightOut: boolean;
  rightTaillightOut: boolean;
  nf: number;
  traffic: ReadonlyArray<TrafficCarForHeadlights>;
  mask: MaskCanvas;
  bridgePunchDeckFromMask(mctx: CanvasRenderingContext2D): void;
}

/** Draws the three rear-lamp states (running / brake / reverse) onto the
 *  mask, punches trailer + traffic + bridge occluders, then composites the
 *  result onto the main canvas with 'lighter'. */
export function drawPlayerTaillights(
  ctx: CanvasRenderingContext2D,
  _view: FrameView,
  deps: PlayerTaillightsDeps,
): void {
  if (deps.nf <= 0.05) return;
  const { nf, isReversing, isBraking } = deps;
  const tlHL = deps.playerCarSize[0] / 2;
  const tlHw = deps.playerCarSize[1] / 2;
  const tlCX = (deps.playerIsBike ? deps.drawX : deps.px) - Math.cos(deps.pAngle) * tlHL;
  const tlCY = (deps.playerIsBike ? deps.drawY : deps.py) - Math.sin(deps.pAngle) * tlHL;
  const tlPerpCos = Math.cos(deps.pAngle + Math.PI / 2);
  const tlPerpSin = Math.sin(deps.pAngle + Math.PI / 2);
  const tlSides  = deps.playerIsBike ? [0] : [-1, 1];
  const tlLampOff = deps.playerIsBike ? 0  : tlHw * 0.72;

  const mask = ensureMaskCanvas(ctx.canvas, deps.mask);
  const tlMC = mask.ctx;
  tlMC.setTransform(1, 0, 0, 1, 0, 0);
  tlMC.globalCompositeOperation = 'source-over';
  tlMC.globalAlpha = 1;
  tlMC.clearRect(0, 0, mask.canvas.width, mask.canvas.height);
  tlMC.translate(deps.WORLD_GW / 2, deps.camY);
  tlMC.scale(deps.ZOOM, deps.ZOOM);
  tlMC.rotate(-deps.pCamAngle - Math.PI / 2);
  tlMC.translate(-deps.smoothFocusX, -deps.smoothFocusY);

  // ---- Three lamp states -----------------------------------------------
  for (const s of tlSides) {
    if (!deps.playerIsBike) {
      if (s === -1 && deps.leftTaillightOut) continue;
      if (s ===  1 && deps.rightTaillightOut) continue;
    }
    const lx = tlCX + tlPerpCos * s * tlLampOff;
    const ly = tlCY + tlPerpSin * s * tlLampOff;

    // (a) Running lights — small dim red aura, always on at night.
    const runR = 3.5;
    const runA = nf * 0.28;
    const runG = tlMC.createRadialGradient(lx, ly, 0, lx, ly, runR);
    runG.addColorStop(0, `rgba(255,40,20,${runA})`);
    runG.addColorStop(1, 'rgba(255,40,20,0)');
    tlMC.fillStyle = runG;
    tlMC.beginPath();
    tlMC.arc(lx, ly, runR, 0, Math.PI * 2);
    tlMC.fill();

    // (b) Brake lights — brighter red halo (no rear-projected cone since
    // v8.99.123.91 removed it; the central halo is the entire brake light).
    if (isBraking) {
      const brkR = 5.5;
      const brkA = nf * 0.55;
      const brkG = tlMC.createRadialGradient(lx, ly, 0, lx, ly, brkR);
      brkG.addColorStop(0,    `rgba(255,70,40,${brkA})`);
      brkG.addColorStop(0.55, `rgba(255,55,25,${brkA * 0.40})`);
      brkG.addColorStop(1,    'rgba(255,55,25,0)');
      tlMC.fillStyle = brkG;
      tlMC.beginPath();
      tlMC.arc(lx, ly, brkR, 0, Math.PI * 2);
      tlMC.fill();
    }

    // (c) Reverse lights — warm-white halo.
    if (isReversing) {
      const revR = 5.0;
      const revA = nf * 0.55;
      const revG = tlMC.createRadialGradient(lx, ly, 0, lx, ly, revR);
      revG.addColorStop(0,   `rgba(255,245,220,${revA})`);
      revG.addColorStop(0.5, `rgba(255,235,190,${revA * 0.45})`);
      revG.addColorStop(1,   'rgba(255,235,190,0)');
      tlMC.fillStyle = revG;
      tlMC.beginPath();
      tlMC.arc(lx, ly, revR, 0, Math.PI * 2);
      tlMC.fill();
    }
  }

  // ---- Punch occluder rects (trailer + nearby traffic + bridge) -------
  tlMC.globalCompositeOperation = 'destination-out';
  tlMC.globalAlpha = 1;
  tlMC.fillStyle = 'rgba(0,0,0,1)';
  const tlMaxReach = 5.5;
  const tlOccCullR = tlMaxReach + tlLampOff + 40;
  const tlOccCullR2 = tlOccCullR * tlOccCullR;

  // Player's own trailer.
  if (deps.playerTrailer) {
    const pt = deps.playerTrailer;
    const pfwX = deps.drawX - Math.cos(deps.pAngle) * 6;
    const pfwY = deps.drawY - Math.sin(deps.pAngle) * 6;
    const ptrCX = pfwX - Math.cos(pt.angle) * (pt.length / 2);
    const ptrCY = pfwY - Math.sin(pt.angle) * (pt.length / 2);
    tlMC.save();
    tlMC.translate(ptrCX, ptrCY);
    tlMC.rotate(pt.angle);
    tlMC.fillRect(-pt.length / 2, -pt.width / 2, pt.length, pt.width);
    tlMC.restore();
  }

  // Nearby traffic cabs + trailers.
  for (const ct of deps.traffic) {
    if (ct._despawned) continue;
    const cdx = ct.x - tlCX;
    const cdy = ct.y - tlCY;
    const cabIn = cdx * cdx + cdy * cdy <= tlOccCullR2;
    let trIn = false;
    let ctrAng = 0, ctrCX = 0, ctrCY = 0;
    if (ct.tTrailer) {
      const ctr = ct.tTrailer;
      const cfwX = ct.x - Math.cos(ct.angle) * 6;
      const cfwY = ct.y - Math.sin(ct.angle) * 6;
      ctrAng = ctr.angle != null ? ctr.angle : ct.angle;
      ctrCX = cfwX - Math.cos(ctrAng) * (ctr.length / 2);
      ctrCY = cfwY - Math.sin(ctrAng) * (ctr.length / 2);
      const tdx = ctrCX - tlCX;
      const tdy = ctrCY - tlCY;
      trIn = tdx * tdx + tdy * tdy <= tlOccCullR2;
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
      tlMC.save();
      tlMC.translate(ct.x, ct.y);
      tlMC.rotate(ct.angle);
      tlMC.fillRect(-ctHL, -ctHW, ctHL * 2, ctHW * 2);
      tlMC.restore();
    }
    if (trIn && ct.tTrailer) {
      const ctr = ct.tTrailer;
      tlMC.save();
      tlMC.translate(ctrCX, ctrCY);
      tlMC.rotate(ctrAng);
      tlMC.fillRect(-ctr.length / 2, -ctr.width / 2, ctr.length, ctr.width);
      tlMC.restore();
    }
  }

  // Bridge deck punch.
  deps.bridgePunchDeckFromMask(tlMC);

  tlMC.globalCompositeOperation = 'source-over';
  tlMC.globalAlpha = 1;
  tlMC.setTransform(1, 0, 0, 1, 0, 0);

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = 1;
  ctx.drawImage(mask.canvas, 0, 0);
  ctx.restore();
}

// ---- Traffic + race + AI-tow headlight/tail cones -------------------------

/** Race-opponent state with the optional speed for the cone-length curve. */
export interface RaceOpponentForHeadlights extends RaceOpponent {
  oppSpeed?: number;
}

/** Traffic-car shape for the headlight-cone emit pass — adds maxSpeed/speed
 *  so the brake-state can be derived from "stopped or under 50% maxSpeed". */
export interface TrafficCarForHeadlightCones extends TrafficCarForHeadlights {
  speed?: number;
  maxSpeed?: number;
  stopped?: boolean;
}

/** AI tow truck for the cone pass. */
export interface IncomingTowForHeadlights {
  x: number;
  y: number;
  angle: number;
  phase: string;
  speed?: number;
}

export interface TrafficHeadlightsDeps {
  TILE: number;
  WORLD_GW: number;
  camY: number;
  ZOOM: number;
  pCamAngle: number;
  smoothFocusX: number;
  smoothFocusY: number;
  /** Player position — cone-pass uses Manhattan-ish cull against the
   *  TRAF_RENDER_R radius (= TILE*25). */
  px: number;
  py: number;
  nf: number;
  traffic: ReadonlyArray<TrafficCarForHeadlightCones>;
  race: RaceOpponentForHeadlights;
  incomingTow: IncomingTowForHeadlights | null;
  /** Bridge-deck exclusion clip — narrows the canvas clip so traffic cones
   *  don't paint onto a bridge the player is driving under. */
  bridgeApplyDeckExclusionClip(ctx: CanvasRenderingContext2D): void;
}

// ---- H770: pre-baked sprites for traffic head/taillight glows --------------
// drawTrafficHeadlightCones previously created up to 4 radial gradients per
// visible vehicle per frame (~80+/frame at night with a full traffic pool) —
// the same per-frame gradient churn already fixed for streetlights (H60) and
// traffic-signal cones. Sprites are baked once per quantized cone length and
// drawn with globalAlpha carrying the night-fade, so dusk transitions stay
// continuous and the cache never grows past a few dozen small canvases.
const CONE_SS = 2; // supersample so cones stay crisp under camera zoom
const coneSprites = new Map<string, HTMLCanvasElement>();

/** H794: cache sizes for the perf-drain logger. These maps are keyed by
 *  quantized (length, spread/radius, color) so they should plateau; a
 *  count that climbs across a session points the canvas/texture growth
 *  theory at the light sprites. (haloSprites is declared below; this is
 *  hoisted so both reads live in one place.) */
export function headlightCacheStats(): { cone: number; halo: number } {
  return { cone: coneSprites.size, halo: haloSprites.size };
}

function getTrafficConeSprite(
  outerLen: number,
  halfSpread: number,
): HTMLCanvasElement | null {
  const lenQ = Math.max(16, Math.round(outerLen / 8) * 8);
  const key = lenQ + '|' + halfSpread;
  const hit = coneSprites.get(key);
  if (hit) return hit;
  const halfH = Math.ceil(lenQ * halfSpread * 1.05);
  const c = document.createElement('canvas');
  c.width = lenQ * CONE_SS;
  c.height = halfH * 2 * CONE_SS;
  const cx = c.getContext('2d');
  if (!cx) return null;
  cx.scale(CONE_SS, CONE_SS);
  cx.translate(0, halfH);
  // Baked at full alpha — the draw call's globalAlpha scales all stops
  // linearly, producing pixels identical to the old per-frame gradient.
  const g = cx.createRadialGradient(0, 0, 0, 0, 0, lenQ);
  g.addColorStop(0,   'rgba(255,204,119,1)');
  g.addColorStop(0.2, 'rgba(255,204,119,0.6)');
  g.addColorStop(0.5, 'rgba(255,204,119,0.2)');
  g.addColorStop(1,   'rgba(255,204,119,0)');
  cx.fillStyle = g;
  drawSoftCone(cx, 0, 0, 0, halfSpread, lenQ);
  coneSprites.set(key, c);
  return c;
}

const HALO_SS = 4; // taillight halos are tiny — bake them oversampled
const haloSprites = new Map<string, HTMLCanvasElement>();

function getTrafficHaloSprite(r: number, rgb: string): HTMLCanvasElement | null {
  const key = r + '|' + rgb;
  const hit = haloSprites.get(key);
  if (hit) return hit;
  const size = Math.ceil(r * 2 * HALO_SS);
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const cx = c.getContext('2d');
  if (!cx) return null;
  const half = size / 2;
  const g = cx.createRadialGradient(half, half, 0, half, half, r * HALO_SS);
  g.addColorStop(0, `rgba(${rgb},1)`);
  g.addColorStop(1, `rgba(${rgb},0)`);
  cx.fillStyle = g;
  cx.fillRect(0, 0, size, size);
  haloSprites.set(key, c);
  return c;
}

const LAMP_SIDES_SINGLE: readonly number[] = [0];
const LAMP_SIDES_PAIR: readonly number[] = [-1, 1];

/** Draws short, dim halogen-style headlight cones + small taillight halos
 *  for every visible traffic vehicle, the race opponent, and the AI tow
 *  truck (when arriving / reversing). Single 'lighter' composite directly
 *  on the main canvas — no off-screen mask, no per-vehicle occlusion. */
export function drawTrafficHeadlightCones(
  ctx: CanvasRenderingContext2D,
  _view: FrameView,
  deps: TrafficHeadlightsDeps,
): void {
  if (deps.nf <= 0.05) return;
  const { TILE, px, py, traffic, race, incomingTow, nf } = deps;

  ctx.save();
  ctx.translate(deps.WORLD_GW / 2, deps.camY);
  ctx.scale(deps.ZOOM, deps.ZOOM);
  ctx.rotate(-deps.pCamAngle - Math.PI / 2);
  ctx.translate(-deps.smoothFocusX, -deps.smoothFocusY);
  deps.bridgeApplyDeckExclusionClip(ctx);
  ctx.globalCompositeOperation = 'lighter';

  const cullR = TILE * 25;
  const cullR2 = cullR * cullR;
  const coneAOuter = nf * 0.16;
  const tlA = nf * 0.30;
  const brkA = nf * 0.55;

  const emit = (
    vx: number, vy: number, vAng: number,
    bodyType: string, isBraking: boolean, vSpeed: number,
    cabHasTrailer: boolean,
  ): void => {
    const isBk = bodyType === 'bike';
    const isSm = bodyType === 'semi';
    const isBx = bodyType === 'boxtruck';
    const isTw = bodyType === 'towtruck';
    const isTruck = isSm || isBx || isTw;
    const fwdHL = isSm ? 17 : (isBx ? 16.5 : (isTw ? 19.25 : (isBk ? 7 : 10)));
    const halfW = isSm ? 6  : (isBx ? 5.5  : (isTw ? 5.85  : (isBk ? 2.5 : 4)));
    const hlLenT = 20 + Math.abs(vSpeed || 0) * 0.1;
    const outerLen = isTruck ? hlLenT * 4.8 : hlLenT * 4.0;

    ctx.save();
    ctx.translate(vx, vy);
    ctx.rotate(vAng);

    // ---- Headlight cones — one per lamp (bike = 1 center; car/truck = 2).
    const hlSides = isBk ? LAMP_SIDES_SINGLE : LAMP_SIDES_PAIR;
    const hlLampOff = isBk ? 0 : (halfW - 1);
    const outerSpread = isBk ? 0.40 : 0.36;
    const cone = getTrafficConeSprite(outerLen, outerSpread);
    if (cone) {
      const dw = cone.width / CONE_SS;
      const dh = cone.height / CONE_SS;
      ctx.globalAlpha = coneAOuter;
      for (const s of hlSides) {
        ctx.drawImage(cone, fwdHL, s * hlLampOff - dh / 2, dw, dh);
      }
    }

    // ---- Taillight halos. Skipped when a trailer is hitched (v123.26):
    // the trailer would physically occlude these lights, and the trailer
    // has its own taillight glow rendered separately by drawTrafficTrailer.
    if (!cabHasTrailer) {
      const tlSides = isBk ? LAMP_SIDES_SINGLE : LAMP_SIDES_PAIR;
      const tlLampOff = isBk ? 0 : halfW * 0.72;
      const tlR = isBraking ? 4.2 : 3.0;
      const halo = getTrafficHaloSprite(tlR, isBraking ? '255,70,40' : '255,40,20');
      if (halo) {
        const d = halo.width / HALO_SS;
        ctx.globalAlpha = isBraking ? brkA : tlA;
        for (const s of tlSides) {
          ctx.drawImage(halo, -fwdHL - d / 2, s * tlLampOff - d / 2, d, d);
        }
      }
    }
    ctx.restore();
  };

  // ---- Traffic ----
  for (const tv of traffic) {
    if (tv._despawned) continue;
    const tdx = tv.x - px;
    const tdy = tv.y - py;
    if (tdx * tdx + tdy * tdy > cullR2) continue;
    const tvBraking = !!(tv.stopped
      || (tv.maxSpeed && tv.maxSpeed > 0 && (tv.speed ?? 0) < tv.maxSpeed * 0.5));
    emit(tv.x, tv.y, tv.angle, tv.bodyType, tvBraking, tv.speed ?? 0, !!tv.tTrailer);
  }

  // ---- Race opponent (sedan body type, never braking visibly) ----
  if (race.active && (race.phase === 'countdown' || race.phase === 'racing')) {
    const rdx = race.oppX - px;
    const rdy = race.oppY - py;
    if (rdx * rdx + rdy * rdy <= cullR2) {
      emit(race.oppX, race.oppY, race.oppAngle, 'sedan', false, race.oppSpeed ?? 0, false);
    }
  }

  // ---- AI tow truck (only arriving / reversing — the towed car has no electrics) ----
  if (incomingTow && (incomingTow.phase === 'arriving' || incomingTow.phase === 'reversing')) {
    const idx = incomingTow.x - px;
    const idy = incomingTow.y - py;
    if (idx * idx + idy * idy <= cullR2) {
      emit(incomingTow.x, incomingTow.y, incomingTow.angle, 'towtruck', false, incomingTow.speed ?? 0, false);
    }
  }

  ctx.globalCompositeOperation = 'source-over';
  ctx.restore();
}

// ---- Rim-light illumination on traffic ------------------------------------

export interface RimLightDeps {
  WORLD_GW: number;
  camY: number;
  ZOOM: number;
  pCamAngle: number;
  smoothFocusX: number;
  smoothFocusY: number;
  /** Beam origin (matches Pass A/B's beamX/beamY). */
  beamOriginX: number;
  beamOriginY: number;
  pAngle: number;
  /** Headlight reach (= hlLen from Pass A/B, used for falloff curve). */
  hlLen: number;
  nf: number;
  traffic: ReadonlyArray<TrafficCarForHeadlights>;
  bridgeApplyDeckExclusionClip(ctx: CanvasRenderingContext2D): void;
}

/** Paints a bright rim on the face of nearby traffic cars that's pointed
 *  toward the player's headlights. Creates the "lit from the front" look —
 *  the player's beam visibly hits car sides/fronts. Runs on main canvas
 *  via 'lighter' composite, no mask. */
export function drawHeadlightIlluminationOnTraffic(
  ctx: CanvasRenderingContext2D,
  _view: FrameView,
  deps: RimLightDeps,
): void {
  if (deps.nf <= 0.05) return;
  const { beamOriginX: bX, beamOriginY: bY, hlLen, pAngle, traffic, nf } = deps;

  ctx.save();
  ctx.translate(deps.WORLD_GW / 2, deps.camY);
  ctx.scale(deps.ZOOM, deps.ZOOM);
  ctx.rotate(-deps.pCamAngle - Math.PI / 2);
  ctx.translate(-deps.smoothFocusX, -deps.smoothFocusY);
  deps.bridgeApplyDeckExclusionClip(ctx);
  ctx.globalCompositeOperation = 'lighter';

  const beamCos = Math.cos(pAngle);
  const beamSin = Math.sin(pAngle);
  const rimBI = nf * 0.18;

  for (const t of traffic) {
    if (t._despawned) continue;
    const tdx = t.x - bX;
    const tdy = t.y - bY;
    const td2 = tdx * tdx + tdy * tdy;
    if (td2 > hlLen * hlLen || td2 < 4) continue;
    const tDist = Math.sqrt(td2);
    const dot = (tdx * beamCos + tdy * beamSin) / tDist;
    if (dot < 0.9) continue; // outside the cone
    const distFrac = 1 - tDist / hlLen;
    const brightness = distFrac * distFrac * rimBI * 1.5;
    if (brightness < 0.02) continue;

    const isBk = t.bodyType === 'bike';
    const tHL =
      t.bodyType === 'semi'     ? 17 :
      t.bodyType === 'boxtruck' ? 16 :
      isBk                      ? 7  : 10;
    const tHW =
      t.bodyType === 'semi'     ? 6   :
      t.bodyType === 'boxtruck' ? 5.5 :
      isBk                      ? 2.5 : 4;

    const tCos = Math.cos(t.angle);
    const tSin = Math.sin(t.angle);
    // Project light direction into car-local space.
    const ldx = beamCos * tCos + beamSin * tSin;
    const ldy = -beamCos * tSin + beamSin * tCos;

    ctx.save();
    ctx.translate(t.x, t.y);
    ctx.rotate(t.angle);
    ctx.globalAlpha = brightness;
    ctx.fillStyle = 'rgba(120,110,80,1)';
    if (Math.abs(ldx) > Math.abs(ldy)) {
      // Front or rear face.
      const fx = ldx > 0 ? tHL : -tHL;
      ctx.fillRect(fx - 1, -tHW, 2, tHW * 2);
    } else {
      // Left or right side.
      const fy = ldy > 0 ? tHW : -tHW;
      ctx.fillRect(-tHL, fy - 1, tHL * 2, 2);
    }
    ctx.restore();
  }

  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.restore();
}
