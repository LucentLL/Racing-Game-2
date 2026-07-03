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
 *   2 (Stop) → src taper + PERPENDICULAR landing at cross-road edge
 *              (T/cross junction — driver stops before merging).
 *   3 (Yield) → TANGENTIAL freeway-entrance ramp: routed through the
 *              Standard tangent-pinned builder so the merge approaches
 *              the destination PARALLEL to its travel direction and
 *              enters at a SHALLOW angle (merge at speed, no stop).
 *
 * v8.99.126.43 split Stop and Yield off Standard into a shared
 * function that branches internally on mergeType; pre-126.43 the two
 * produced identical Standard-shaped geometry. The shared `_stop`
 * branch takes `mergeType` so the function picks the right
 * termination without needing two top-level entry points.
 *
 * H917: Yield (3) split back OFF the shared `_stop` function — its
 * destination side was still anchored to the PERPENDICULAR sUV apex
 * (only a dest taper was added), so it never read as a tangential
 * merge-at-speed. Yield now routes through `_weMergeBondEndpoints_
 * standard`, whose both-ends builder pins each end tangent to the
 * road's travel direction (`_bondTravelDir`) — the shallow tangential
 * approach the user approved. Stop (2) keeps `_stop` unchanged.
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
import { buildConnectorPath, type LaneAnchor } from './connector';

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
  /** H967: set true by the STANDARD/YIELD branch when the returned
   *  polyline was shifted to the LANE CENTER (drive path). The commit
   *  persists it (overlayRoadProps sidecar) so every consumer — render
   *  band, tile stamp, traffic, surface physics — knows the stored line
   *  IS the lane, and the render draws a symmetric band instead of the
   *  legacy outboard polygon. Absent on cloverleaf/stop + legacy rows. */
  laneCentered?: boolean;
  /** H985 (ROADSPEC Stage 2): geometry construction version. 2 = the
   *  polyline came from the constructive biarc builder — the render
   *  draws a pure symmetric band around it with NO reconstruction, NO
   *  stripe pinning, NO road re-scans. */
  builderV?: number;
}

/** Rewrite a draft road's endpoints per the configured mergeType.
 *  Returns a new pts array (input is not mutated). */
/** H985 — resolve a clicked-lane BondTarget into a directed lane anchor
 *  for the constructive builder. The click point (the draft endpoint)
 *  already sits ON the clicked lane's center (snap.ts put it there);
 *  only the travel direction needs deriving — EXACT copy of the
 *  snap.ts travelDir rule so the arrow the user saw is the tangent the
 *  builder honors. */
function _anchorFromTarget(
  target: MergeBondTarget,
  clickPt: TilePoint,
  deps: MergeDeps,
): { anchor: LaneAnchor; inward: [number, number] } | null {
  const roads = deps.getMajorRoads();
  const road = roads[target.roadIdx as number];
  const rp = road?.pts as ReadonlyArray<readonly number[]> | undefined;
  if (!rp || rp.length < 2) return null;
  const seg = Math.max(0, Math.min((target.segIdx as number) | 0, rp.length - 2));
  const ax = rp[seg][0], ay = rp[seg][1];
  const bx = rp[seg + 1][0], by = rp[seg + 1][1];
  const tx = bx - ax, ty = by - ay;
  const L = Math.hypot(tx, ty) || 1;
  const t: [number, number] = [tx / L, ty / L];
  const side = (target.side as number) >= 0 ? 1 : -1;
  const oneway = (road as { oneway?: boolean }).oneway === true;
  const dir: [number, number] = oneway || side >= 0 ? t : [-t[0], -t[1]];
  // inward = from the lane-center click point toward the road centerline
  let qx = ax + Math.max(0, Math.min(1, ((clickPt[0] - ax) * tx + (clickPt[1] - ay) * ty) / (L * L))) * tx;
  let qy = ay + Math.max(0, Math.min(1, ((clickPt[0] - ax) * tx + (clickPt[1] - ay) * ty) / (L * L))) * ty;
  let ix = qx - clickPt[0], iy = qy - clickPt[1];
  const il = Math.hypot(ix, iy);
  if (il > 0.05) { ix /= il; iy /= il; }
  else { ix = side >= 0 ? t[1] : -t[1]; iy = side >= 0 ? -t[0] : t[0]; }
  return { anchor: { pt: [clickPt[0], clickPt[1]], dir }, inward: [ix, iy] };
}

export function _weMergeBondEndpoints(
  opts: MergeBondOpts,
  deps: MergeDeps,
): TilePoint[] {
  const _mt = (opts.mergeType | 0) || 0;
  // H985 (ROADSPEC Stage 2): when BOTH endpoints carry clicked-lane
  // targets, the geometry is fully determined — build it constructively
  // (departure run → biarc honoring both travel directions → arrival
  // run). Loops fall out of the tangents; no modes. An unsolvable pose
  // pair (e.g. the clicked source lane travels AWAY from the
  // destination) returns null and falls through to the legacy path
  // unchanged — Stage 3 replaces that fallback with an explicit reject.
  if ((_mt === 0 || _mt === 3) && opts.startTarget && opts.endTarget && opts.pts.length >= 2) {
    const a0 = _anchorFromTarget(opts.startTarget, opts.pts[0], deps);
    const a1 = _anchorFromTarget(opts.endTarget, opts.pts[opts.pts.length - 1], deps);
    if (a0 && a1) {
      const built = buildConnectorPath(a0.anchor, a1.anchor);
      if (built) {
        if (opts.sideOut) {
          opts.sideOut.start = a0.inward;
          opts.sideOut.end = a1.inward;
          opts.sideOut.laneCentered = true;
          opts.sideOut.builderV = 2;
        }
        return built.pts.map((p) => [p[0], p[1]] as TilePoint);
      }
    }
  }
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
  if (_mt === 2) {
    // STOP — perpendicular T/cross junction. The destination side
    // terminates at ~90° (the driver STOPS before merging). Keep the
    // perpendicular sUV-apex termination in _weMergeBondEndpoints_stop.
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
  // YIELD (mergeType 3) — freeway-entrance ramp: the merge must approach
  // the destination road PARALLEL to its travel direction, entering at a
  // SHALLOW angle (merge AT SPEED, no stop), TANGENTIAL to the road's flow.
  // The perpendicular sUV-apex termination in _weMergeBondEndpoints_stop is
  // wrong for that. The Standard (mergeType 0) builder already produces the
  // tangent-pinned approach the user approved (_bondTravelDir end tangents +
  // parallel-run + taper), so route YIELD through it. Falls through to the
  // same call as Standard below — the only difference from Stop is which
  // dispatch branch it takes.
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
