/**
 * Shared low-level drawing helpers used by every V2 per-generation
 * renderer (registered in GEN_DATA, populated in C19b).
 *
 *   - v2GroundShadow  — centered scale-up shadow under the car body.
 *   - v2Wheels        — generic 4-tire renderer; falls through to the
 *                       GT4-driven X-ray geometry when isXray is on AND
 *                       the player car's name is set on the thread-local
 *                       v2RenderCarName.
 *   - v2TaillightGlow — radial-gradient halo at a taillight position,
 *                       fault-suppressed for the player's left/right
 *                       taillights when xrayBody is on.
 *   - v2HeadlightGlow — historical no-op (v8.99.15 disabled the in-body
 *                       halo; cone passes handle all night headlight VFX).
 *
 * The module-level _v2PlayerTailDraw flag is set by drawTopCar while
 * drawing the player's car, so v2TaillightGlow knows when to apply the
 * fault gate. Save/restore lets recursive drawTopCar calls (tow truck
 * hauling another car) nest safely.
 *
 * Ported from monolith L36800–37068.
 */

import type { GT4SpecLike } from './types';
import { xrayWheelGeomFromSpec, drawXrayTiresFromGeom } from './xrayGeom';

/** Tracer callback shape used by v2GroundShadow. The per-gen renderer
 *  passes the gen's own body-trace function so the shadow contour matches
 *  the silhouette. */
export type V2TracePathFn = (
  ctx: CanvasRenderingContext2D,
  hl: number,
  hw: number,
  L: number,
  W: number,
) => void;

/** Centered scale-up shadow. Reads as a grounded object — no implied
 *  vertical tilt, which the older translate(1.4,1.4) version implied
 *  (read as "front lifted like a planing speedboat"). */
export function v2GroundShadow(
  ctx: CanvasRenderingContext2D,
  tracePath: V2TracePathFn,
  hl: number,
  hw: number,
  L: number,
  W: number,
): void {
  ctx.save();
  ctx.scale(1.08, 1.10);
  tracePath(ctx, hl, hw, L, W);
  ctx.fillStyle = 'rgba(0,0,0,0.26)';
  ctx.fill();
  ctx.restore();
}

// ---- Player-tail-draw flag (thread-local equivalent) ----------------------

/** Set by drawTopCar (C19c) immediately before invoking a V2 per-gen
 *  render block for the player's car; reset after. Allows v2TaillightGlow
 *  to know it's drawing the player's lamps and so apply the per-side
 *  fault gate. Save/restore via the helpers below keeps recursive
 *  drawTopCar calls (tow truck on flatbed) nestable. */
let v2PlayerTailDraw = false;

export function setV2PlayerTailDraw(value: boolean): boolean {
  const prev = v2PlayerTailDraw;
  v2PlayerTailDraw = value;
  return prev;
}

export function getV2PlayerTailDraw(): boolean {
  return v2PlayerTailDraw;
}

/** Per-side taillight fault lookup, injected by the caller (the actual
 *  fault list lives on LIFE.faults). Returning true suppresses the lamp. */
export type TaillightFaultPredicate = (sideId: 'tl_taillightL' | 'tl_taillightR') => boolean;

let taillightFaultPredicate: TaillightFaultPredicate | null = null;

/** Configures the fault-suppression predicate. Called once at game start
 *  by the orchestrator wiring; safe to re-call to swap implementations. */
export function setTaillightFaultPredicate(p: TaillightFaultPredicate | null): void {
  taillightFaultPredicate = p;
}

/** Radial taillight halo. Suppresses the lamp when the matching player
 *  taillight fault is active AND the player-tail flag is set. */
export function v2TaillightGlow(
  ctx: CanvasRenderingContext2D,
  tx: number,
  ty: number,
  radius: number,
  alpha: number,
  rgbStr: string,
): void {
  if (v2PlayerTailDraw && taillightFaultPredicate) {
    const faultId = ty < 0 ? 'tl_taillightL' : 'tl_taillightR';
    if (taillightFaultPredicate(faultId)) return;
  }
  const grd = ctx.createRadialGradient(tx, ty, 0, tx, ty, radius);
  grd.addColorStop(0, `rgba(${rgbStr},${Math.min(1, alpha)})`);
  grd.addColorStop(1, `rgba(${rgbStr},0)`);
  ctx.fillStyle = grd;
  ctx.fillRect(tx - radius, ty - radius, radius * 2, radius * 2);
}

/** No-op kept as a stable hook. Historical v8.99.15 disabled the in-body
 *  headlight halo (yellow radial glow on the car's nose) — cone passes
 *  in the world layer now handle all nighttime headlight VFX. The hook
 *  is preserved instead of being removed across ~15 per-gen call sites. */
export function v2HeadlightGlow(
  _ctx: CanvasRenderingContext2D,
  _hx: number,
  _hy: number,
  _radius: number,
  _alpha: number,
): void {
  // intentionally empty
}

// ---- Generic 4-tire renderer ----------------------------------------------

/** Thread-local equivalent: drawCarBodyV2 sets this to the active player
 *  car name immediately before dispatching to GEN_DATA[id].render(), and
 *  clears it afterwards. v2Wheels reads it to short-circuit to the GT4-
 *  driven X-ray renderer when isXray is on, avoiding the need to thread
 *  the car name through every per-gen call site. */
let v2RenderCarName: string | null = null;

export function setV2RenderCarName(name: string | null): string | null {
  const prev = v2RenderCarName;
  v2RenderCarName = name;
  return prev;
}

/** GT4 spec lookup, injected by the orchestrator (the database lives in
 *  cfg/cars/gt4Database). */
type GT4Lookup = (name: string) => GT4SpecLike | undefined;
let gt4Lookup: GT4Lookup | null = null;

export function setGT4Lookup(lookup: GT4Lookup | null): void {
  gt4Lookup = lookup;
}

/**
 * Generic 4-tire renderer. In normal play, paints flat dark rectangles at
 * the axle positions specified by `axle` (a [front, rear] fraction of hl).
 * When isXray is on and the player car has a GT4 spec, switches to the
 * geom-driven path so tires match real-world dimensions.
 */
export function v2Wheels(
  ctx: CanvasRenderingContext2D,
  axle: readonly [number, number],
  hl: number,
  hw: number,
  L: number,
  steerAngle: number,
  isXray: boolean,
): void {
  if (isXray && v2RenderCarName && gt4Lookup) {
    const W = hw * 2;
    const spec = gt4Lookup(v2RenderCarName);
    if (spec) {
      const geom = xrayWheelGeomFromSpec(spec, L, W);
      if (geom) {
        drawXrayTiresFromGeom(ctx, geom, steerAngle);
        return;
      }
    }
  }
  const wl = L * 0.18;
  const ww = isXray ? 3 : 2;
  ctx.fillStyle = isXray ? '#ff0' : '#0a0a0a';
  ctx.fillRect(-hl * axle[1], -hw - 0.2, wl, ww);
  ctx.fillRect(-hl * axle[1],  hw - ww + 0.2, wl, ww);
  ctx.save();
  ctx.translate(hl * axle[0], -hw + ww / 2);
  ctx.rotate(steerAngle);
  ctx.fillRect(-wl / 2, -ww / 2, wl, ww);
  ctx.restore();
  ctx.save();
  ctx.translate(hl * axle[0],  hw - ww / 2);
  ctx.rotate(steerAngle);
  ctx.fillRect(-wl / 2, -ww / 2, wl, ww);
  ctx.restore();
}
