/**
 * World Editor — bond-endpoint dispatcher.
 *
 * Picks the per-mergeType branch that rewrites the endpoints of a draft
 * road to bond onto baseline roads. mergeType is an integer carried
 * from draftProps; the dispatcher gates each branch so adding a new
 * type (Diamond, SPDI, DDI, Roundabout, etc.) is purely additive — the
 * existing branches are untouched.
 *
 *   0 (Standard) → coordinated cubic Bezier through interior (v126.12).
 *   1 (Cloverleaf) → tangent-tangent circular-arc loop ramp.
 *   2 (Stop) → src taper + perpendicular landing at cross-road edge.
 *   3 (Yield) → src taper + dest taper merging into cross-road flow.
 *
 * v8.99.126.43 split Stop and Yield off Standard into a shared
 * function that branches internally on mergeType; pre-126.43 the two
 * produced identical Standard-shaped geometry. The shared `_stop`
 * branch takes `mergeType` so the function picks the right
 * termination without needing two top-level entry points.
 *
 * Unknown / zero mergeType falls through to Standard — safest default,
 * matches the monolith's `(mergeType|0) || 0` coercion.
 *
 * Ported 1:1 from monolith L13324-13344.
 */

import type { TilePoint } from '../stamp';
import { _weMergeBondEndpoints_standard, type MergeDeps, type MergeBondTarget } from './standard';
import { _weMergeBondEndpoints_cloverleaf } from './cloverleaf';
import { _weMergeBondEndpoints_stop } from './stop';

/** Dispatcher inputs. Superset of the per-branch opts; per-branch
 *  fields that don't apply to the chosen mergeType are simply unread.
 *  loopDiameter is only consulted when mergeType === 1. */
export interface MergeBondOpts {
  pts: TilePoint[];
  dW: number;
  mergeAlign: number;
  /** 0 = Standard, 1 = Cloverleaf, 2 = Stop, 3 = Yield. */
  mergeType: number;
  /** Tiles. Only consulted for Cloverleaf (mergeType === 1). */
  loopDiameter?: number;
  /** H888/H890: ramp elevation. Threaded to ALL bond detectors (Standard,
   *  Cloverleaf, Stop/Yield) so a bridge-deck ramp bonds to a same-z
   *  destination, not the ground road beneath it. */
  rampZ?: number;
  /** H887: optional out-param. When supplied, the STANDARD branch writes
   *  the resolved inward (toward-destination) unit vector for each bonded
   *  endpoint so the commit can persist the merge's side. Cloverleaf/Stop
   *  leave it untouched (their side is re-derived as before — no behavior
   *  change there, and loop sidedness stays forced). */
  sideOut?: MergeSideOut;
  /** H902: explicit clicked-lane targets for the start / end endpoints.
   *  Forwarded ONLY to the STANDARD branch; cloverleaf/stop ignore them. */
  startTarget?: MergeBondTarget | null;
  endTarget?: MergeBondTarget | null;
}

/** H887: per-endpoint resolved inward direction (toward the destination
 *  body), captured at commit so the merge's side survives a rebuild
 *  instead of being re-guessed from baked geometry. Each vector is a unit
 *  [dx, dy] in tile space; absent when no side resolved. */
export interface MergeSideOut {
  start?: [number, number];
  end?: [number, number];
}

/** Rewrite a draft road's endpoints per the configured mergeType.
 *  Returns a new pts array (input is not mutated). */
export function _weMergeBondEndpoints(
  opts: MergeBondOpts,
  deps: MergeDeps,
): TilePoint[] {
  const _mt = (opts.mergeType | 0) || 0;
  if (_mt === 1) {
    return _weMergeBondEndpoints_cloverleaf(
      {
        pts: opts.pts,
        dW: opts.dW,
        mergeAlign: opts.mergeAlign,
        loopDiameter: opts.loopDiameter || 0,
        rampZ: opts.rampZ,
      },
      deps,
    );
  }
  if (_mt === 2 || _mt === 3) {
    return _weMergeBondEndpoints_stop(
      {
        pts: opts.pts,
        dW: opts.dW,
        mergeAlign: opts.mergeAlign,
        mergeType: _mt,
        rampZ: opts.rampZ,
      },
      deps,
    );
  }
  return _weMergeBondEndpoints_standard(
    {
      pts: opts.pts,
      dW: opts.dW,
      mergeAlign: opts.mergeAlign,
      rampZ: opts.rampZ,
      // H902: bind each end to the clicked lane/side.
      startTarget: opts.startTarget,
      endTarget: opts.endTarget,
    },
    deps,
    opts.sideOut,
  );
}

export type { MergeDeps } from './standard';
