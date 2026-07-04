/**
 * World Editor — overlay application + world rebuild.
 *
 * `_weApplyOverlay` is the central reconciliation step that takes the
 * current overlay state and re-stamps the world. It is idempotent by
 * deliberate design — every call:
 *
 *  1. Restores majorRoads / map[] / roadCrossings from the baseline
 *     snapshot (editor/baseline.ts).
 *  2. Re-pushes each overlay road into majorRoads, stamping its tiles.
 *  3. Computes incremental crossings for each overlay road against
 *     every other road (mirrors the boot-time _rp crossing pass).
 *  4. Re-stamps surfaces, parking lots, rivers, lakes, buildings — order
 *     matters: roads → surfaces → parking lots → water → buildings so
 *     each layer's tile priority is honored without explicit z-sorting
 *     (water is a soft-skip stamp that preserves road/structure/lot
 *     tiles below it; buildings overwrite everything beneath them).
 *     Parking lots (H693, tile=18) are hard-write — drawing a lot over
 *     a surface replaces the visual with striped pavement.
 *  5. Auto-computes bridgePts on every elevated user road by scanning
 *     for crossings against every lower-z road (Pass A + Pass B —
 *     mid-segment hit and snap-endpoint projection).
 *
 * Idempotence matters because the editor calls _weApplyOverlay every
 * time anything changes (vertex move, draft commit, road delete, etc.)
 * — if the function were not idempotent, those calls would accumulate.
 *
 * BASELINE DELETES (v8.99.126.47):
 * Roads marked for deletion in WORLD_EDITOR.baselineDeletes are pushed
 * with EMPTY pts so they keep their slot in majorRoads (preserving
 * i==0..baseLen-1 index alignment that pick logic depends on) but
 * vanish from render and pick. Every render/pick path already short-
 * circuits on r.pts.length<2. The underlying map tile imprint and
 * original crossings stay — gameplay still treats those tiles as road —
 * so the user can draw an overlay on top to "replace" the baseline
 * visually. Reload Baseline reverts the delete set.
 *
 * Ported from monolith L10201-10470.
 */

import type { WorldEditorState } from './index';
import type { BaselineSnapshot } from './baseline';
import {
  _weStampSurface,
  _weStampBuilding,
  _weStampRiverTiles,
  _weStampLake,
  _weStampRoadTiles,
  _weStampParkingLot,
  _weParseParkingLotMeta,
  _weIsDrivewayName,
  _weGarageLanesForBuilding,
  type StampDeps,
} from './stamp';
import { _decodeMergeFlag } from './draft';
import { TILE } from '@/config/world/tiles';

/** A live majorRoads array entry as seen by the editor's apply path.
 *  Shape matches what `RenderDeps.getMajorRoads` consumes in render.ts —
 *  the index signature allows the render-pass cache fields
 *  (_mainPath / _bbox / _prof / _chunks / _dividerPaths) to be tacked
 *  on by preprocessRoadsForRender without further casting. */
export interface OverlayMajorRoad {
  pts: number[][];
  w: number;
  maj: number;
  name: string;
  z: number;
  bridgePts?: Array<{ x: number; y: number }>;
  merge?: boolean;
  mergeAlign?: number;
  mergeType?: number;
  material?: string;
  age?: string;
  materialOverrides?: unknown[];
  /** H886: one-way directional flag (no yellow opposing centerline). */
  oneway?: boolean;
  /** H887: persisted merge inward (toward-destination) unit vectors per
   *  bonded endpoint — keeps the merge on the user-chosen side across
   *  rebuilds instead of re-deriving it. Unit [dx, dy] in tile space. */
  bondInnerStart?: readonly number[];
  bondInnerEnd?: readonly number[];
  /** H967: the row's polyline IS the lane center (drive path) — the
   *  render builds a symmetric band instead of the legacy outboard
   *  polygon. Set at commit by the standard/yield bonder. */
  laneCentered?: boolean;
  /** H985: 2 = constructive biarc builder row. */
  builderV?: number;
  /** v8.99.126.47: empty-pts placeholder marker for baselineDeletes. */
  deleted?: boolean;
  [k: string]: unknown;
}

/** Host bindings for applying the overlay. */
export interface ApplyDeps extends StampDeps {
  /** The live majorRoads array — _weApplyOverlay mutates this directly
   *  (.length=0 then push). */
  majorRoads: OverlayMajorRoad[];
  /** The live roadCrossings array — same pattern (clear + repopulate). */
  roadCrossings: Array<Record<string, unknown>>;
  /** Restores world tile bytes from the baseline snapshot. */
  restoreMapBytes(bytes: Uint8Array): void;
  /** Persist the overlay to localStorage. Called by _weRebuildWorld
   *  before re-applying so a crashing apply step doesn't leave a
   *  stale localStorage record. */
  saveOverlayToStorage(state: WorldEditorState): void;
  /** Rebuild the game-side render caches (per-road _mainPath / _bbox /
   *  _prof / _chunks / _dividerPaths and _sortedRoadsByZ). Optional
   *  because the editor can run with a no-op caches step during early
   *  porting; the monolith's call site at L10467 also guards on
   *  `typeof preprocessRoadsForRender === 'function'`. */
  preprocessRoadsForRender?(): void;
  /** Set the editor's redraw flag. The state itself owns `needsRedraw`
   *  but going through deps keeps the call ordering explicit at the
   *  edge of the module (matches the existing `needsRedraw=true` line
   *  at monolith L10468). */
  markNeedsRedraw(state: WorldEditorState): void;
}

/** Local line-segment intersection — 1:1 port of monolith L9624-9631.
 *  Returns the intersection point if both segments cross strictly
 *  inside their parameter ranges (the 0.01 / 0.99 inner band excludes
 *  shared endpoints, which would otherwise be reported as false
 *  crossings between adjacent segments of the same polyline).
 *
 *  Duplicates the helper at render/worldMap.ts segHit — the monolith
 *  also has a single function called from multiple sites (apply +
 *  bridge-pt boot detector at L9634). Keeping a module-local copy
 *  here matches that structure and avoids forcing render/worldMap.ts
 *  to export a previously-internal helper. */
function segHit(
  x1: number, y1: number, x2: number, y2: number,
  x3: number, y3: number, x4: number, y4: number,
): { x: number; y: number } | null {
  const d = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
  if (Math.abs(d) < 0.01) return null;
  const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / d;
  const u = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / d;
  if (t > 0.01 && t < 0.99 && u > 0.01 && u < 0.99) {
    return { x: x1 + t * (x2 - x1), y: y1 + t * (y2 - y1) };
  }
  return null;
}

/** A baseline road entry may carry material/age/materialOverrides
 *  fields after UI mutations write them via the per-baseline-road
 *  property setters (monolith L15455 / L17288-17299). The capture
 *  step at editor/baseline.ts L96-103 does NOT copy them in (matches
 *  the monolith L9981-9994 capture), so they are absent on fresh
 *  capture and appear later when the user edits a baseline road's
 *  surface or age. Cast at the read site so we stay decoupled from
 *  BaselineRoad's nominal shape. */
/** H887: narrow an untrusted sidecar value to a finite, non-degenerate
 *  unit-ish [dx, dy] tile-space vector, or undefined. Guards against
 *  malformed JSON (NaN / wrong length / zero vector) before it reaches
 *  the merge geometry. */
function _validBondVec(v: unknown): [number, number] | undefined {
  if (!Array.isArray(v) || v.length !== 2) return undefined;
  const dx = Number(v[0]);
  const dy = Number(v[1]);
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return undefined;
  if (dx === 0 && dy === 0) return undefined;
  return [dx, dy];
}

type BaselineRoadWithSurface = {
  w: number; maj: number; name: string; z: number;
  pts: number[][];
  bridgePts?: Array<{ x: number; y: number }>;
  material?: string;
  age?: string;
  materialOverrides?: unknown[];
  oneway?: boolean;
};

/** Re-apply the entire overlay on top of the baseline. Single entry
 *  point for everything that mutates the visible world from the editor.
 *
 *  Ordering is significant and matches the monolith:
 *    Phase 1  baseline restore (roads, map bytes, crossings)
 *    Phase 2  overlay roads — push + stamp tile=1
 *    Phase 3  same-z incremental crossings (overlay vs every road)
 *    Phase 4  surfaces (tile=1), then water (tile=9, soft)
 *    Phase 5  buildings (tile=17) — LAST so footprints win
 *    Phase 6  bridgePts auto-compute on elevated user roads
 *
 *  Ported 1:1 from monolith _weApplyOverlay (L10201-10458). */
export function _weApplyOverlay(
  state: WorldEditorState,
  baseline: BaselineSnapshot,
  deps: ApplyDeps,
): void {
  // Phase 1: restore baseline roads / map / crossings. Skips when the
  // snapshot is not yet captured — matches the monolith guard at L10212.
  if (baseline.liveMajorRoads && baseline.mapBytes && baseline.crossings) {
    deps.majorRoads.length = 0;
    const delSet = new Set((state.baselineDeletes || []).map((i) => +i));
    for (let bi = 0; bi < baseline.liveMajorRoads.length; bi++) {
      const r = baseline.liveMajorRoads[bi] as BaselineRoadWithSurface;
      if (delSet.has(bi)) {
        // v8.99.126.47: empty-pts placeholder. Every render/pick path
        // skips it via the existing pts.length<2 guard, so the road
        // visually vanishes while baseline indexing stays stable.
        deps.majorRoads.push({
          w: r.w, maj: r.maj, name: r.name, z: r.z,
          pts: [], deleted: true,
          bridgePts: undefined,
        });
      } else {
        // v8.99.126.50: propagate material / age / materialOverrides
        // from the live baseline so per-road or per-section surface
        // choices survive the rebuild.
        deps.majorRoads.push({
          w: r.w, maj: r.maj, name: r.name, z: r.z,
          pts: r.pts.map((p) => [p[0], p[1]]),
          bridgePts: r.bridgePts
            ? r.bridgePts.map((p) => ({ x: p.x, y: p.y }))
            : undefined,
          material: r.material,
          age: r.age,
          materialOverrides: Array.isArray(r.materialOverrides)
            ? (JSON.parse(JSON.stringify(r.materialOverrides)) as unknown[])
            : undefined,
          oneway: r.oneway || undefined,
        });
      }
    }
    deps.restoreMapBytes(baseline.mapBytes);
    deps.roadCrossings.length = 0;
    for (const c of baseline.crossings) deps.roadCrossings.push({ ...c });
  }

  // Phase 2: append overlay roads.
  const overlay = (state.overlay || []) as unknown[];
  const newRoadStartIdx = deps.majorRoads.length;
  for (const row of overlay) {
    if (!Array.isArray(row) || row.length < 6) continue;
    const r = row as Array<number | string>;
    const w = r[0] as number;
    const maj = r[1] as number;
    const name = r[2] as string;
    const z = r[3] as number;
    // v8.99.126.00: row schema detection by length parity.
    //   Even length = legacy 4-meta row, no merge column.
    //   Odd length  = 5-meta row, r[4] encodes (mergeType, mergeAlign).
    // v8.99.126.05 encoded alignment 1/2/3; v8.99.126.36 added
    // mergeType in the tens digit (see _decodeMergeFlag).
    const hasMerge126 = (r.length & 1) === 1;
    const mergeFlag = hasMerge126 ? ((r[4] as number) | 0) : 0;
    const mDec = _decodeMergeFlag(mergeFlag);
    // Modular _decodeMergeFlag returns { mergeType, mergeAlign } without
    // the monolith's `merge` boolean. Equivalent: merge ↔ flag > 0.
    const merge = mergeFlag > 0;
    const mergeAlign = mDec.mergeAlign || 1;
    const mergeType = mDec.mergeType || 0;
    const ptStart126 = hasMerge126 ? 5 : 4;
    const pts: number[][] = [];
    for (let i = ptStart126; i < r.length; i += 2) {
      if (typeof r[i] === 'number' && typeof r[i + 1] === 'number') {
        pts.push([r[i] as number, r[i + 1] as number]);
      }
    }
    if (pts.length < 2) continue;
    // v8.99.126.50 sidecars — overlayRoadProps + overlayMaterialOverrides
    // keyed by overlay row index. Lets the row schema stay positional
    // while material/age/per-section overrides ride alongside.
    const ovIdx = deps.majorRoads.length - newRoadStartIdx;
    const ovProps = (state.overlayRoadProps && state.overlayRoadProps[ovIdx]) || {};
    const ovMatOv = (state.overlayMaterialOverrides && state.overlayMaterialOverrides[ovIdx]) || null;
    const ovMaterial = (ovProps as { material?: string }).material;
    const ovAge = (ovProps as { age?: string }).age;
    // H886: one-way directional flag rides the same sidecar.
    const ovOneway = (ovProps as { oneway?: boolean }).oneway === true;
    // H887: persisted merge bond-side vectors (validated unit [dx, dy]).
    const ovBondS = _validBondVec((ovProps as { bondInnerStart?: unknown }).bondInnerStart);
    const ovBondE = _validBondVec((ovProps as { bondInnerEnd?: unknown }).bondInnerEnd);
    // H967: lane-centered marker — polyline is the drive path.
    const ovLaneCentered = (ovProps as { laneCentered?: unknown }).laneCentered === true;
    // H985: constructive-builder version rides the same sidecar.
    const ovBuilderV = typeof (ovProps as { builderV?: unknown }).builderV === 'number'
      ? (ovProps as { builderV: number }).builderV : undefined;
    deps.majorRoads.push({
      w, maj, name, z, pts, merge, mergeAlign, mergeType,
      material: (ovMaterial === 'asphalt' || ovMaterial === 'concrete') ? ovMaterial : undefined,
      age: (ovAge === 'new' || ovAge === 'old' || ovAge === 'auto') ? ovAge : undefined,
      materialOverrides: Array.isArray(ovMatOv)
        ? (JSON.parse(JSON.stringify(ovMatOv)) as unknown[])
        : undefined,
      oneway: ovOneway || undefined,
      bondInnerStart: ovBondS,
      bondInnerEnd: ovBondE,
      laneCentered: ovLaneCentered || undefined,
      builderV: ovBuilderV,
    });
    _weStampRoadTiles(w, pts as Array<[number, number]>, deps);
  }

  // Phase 3: incremental crossings — each overlay road vs every other
  // road (including other overlay roads). Mirrors the same sameZ /
  // elevated guard the source-side _rp pass uses.
  for (let i = newRoadStartIdx; i < deps.majorRoads.length; i++) {
    for (let j = 0; j < deps.majorRoads.length; j++) {
      if (i === j) continue;
      const r1 = deps.majorRoads[i];
      const r2 = deps.majorRoads[j];
      const z1 = r1.z || 0;
      const z2 = r2.z || 0;
      const sameZ = z1 === z2;
      if (!sameZ && z1 < 2 && z2 < 2) continue;
      for (let a = 0; a < r1.pts.length - 1; a++) {
        for (let b = 0; b < r2.pts.length - 1; b++) {
          const h = segHit(
            r1.pts[a][0], r1.pts[a][1], r1.pts[a + 1][0], r1.pts[a + 1][1],
            r2.pts[b][0], r2.pts[b][1], r2.pts[b + 1][0], r2.pts[b + 1][1],
          );
          if (h) {
            const dx1 = r1.pts[a + 1][0] - r1.pts[a][0];
            const dy1 = r1.pts[a + 1][1] - r1.pts[a][1];
            const dx2 = r2.pts[b + 1][0] - r2.pts[b][0];
            const dy2 = r2.pts[b + 1][1] - r2.pts[b][1];
            const ang1 = Math.atan2(dy1, dx1);
            const ang2 = Math.atan2(dy2, dx2);
            if (sameZ) {
              deps.roadCrossings.push({
                x: h.x * TILE + TILE / 2,
                y: h.y * TILE + TILE / 2,
                r1w: r1.w, r2w: r2.w, r1z: z1, r2z: z2,
                ang1, ang2, r1maj: r1.maj, r2maj: r2.maj,
              });
            }
          }
        }
      }
    }
  }

  // Phase 4: stamp surface polygons (tile=1) AFTER roads so they fill
  // in around road footprints. Both stamps tile=1; terrain renderer
  // treats this as drivable.
  const surfaces = (state.surfaces || []) as unknown[];
  for (const srow of surfaces) {
    if (!Array.isArray(srow) || srow.length < 8) continue;
    const s = srow as Array<number | string>;
    const name = s[0] as string;
    const z = s[1] as number;
    const pts: Array<[number, number]> = [];
    for (let i = 2; i < s.length; i += 2) {
      if (typeof s[i] === 'number' && typeof s[i + 1] === 'number') {
        pts.push([s[i] as number, s[i + 1] as number]);
      }
    }
    if (pts.length < 3) continue;
    // H999: driveways stamp concrete (tile=19); plain surfaces stay tile=1.
    _weStampSurface({ name, z, pts }, deps, _weIsDrivewayName(name) ? 19 : 1);
  }

  // H693 Phase 4.25: parking lots (tile=18 asphalt / tile=19 concrete).
  // AFTER roads + surfaces so a parking lot drawn over plain asphalt
  // visually replaces it with striped lot, but BEFORE water (rivers/lakes
  // flow around lots like they flow around surfaces) and BEFORE buildings
  // (a building drawn on a lot still wins — tile=17 stamps last).
  // H695: row schema gained an optional material slot — _weParseParkingLotMeta
  // resolves both the H693 legacy ([name, x1, y1, ...]) and the H695
  // ([name, material, x1, y1, ...]) forms via length parity.
  const parkingLots = (state.parkingLots || []) as unknown[];
  for (const plRow of parkingLots) {
    if (!Array.isArray(plRow) || plRow.length < 7) continue;
    const pl = plRow as Array<number | string>;
    const meta = _weParseParkingLotMeta(pl);
    const pts: Array<[number, number]> = [];
    for (let i = meta.xStart; i < pl.length; i += 2) {
      if (typeof pl[i] === 'number' && typeof pl[i + 1] === 'number') {
        pts.push([pl[i] as number, pl[i + 1] as number]);
      }
    }
    if (pts.length < 3) continue;
    _weStampParkingLot({
      name: meta.name,
      material: meta.material,
      stallW: meta.stallW,
      stallL: meta.stallL,
      aisleW: meta.aisleW,
      pts,
    }, deps);
  }

  // v8.99.124.28: rivers + lakes (Phase 4 — water). AFTER roads + surfaces
  // (the soft-skip preserves user drivable areas — water flows around them)
  // but BEFORE buildings (user buildings override water at the building
  // footprint, which is physically what you'd expect). Both write tile=9
  // only on natural ground; the GBC pixel-water tile renderer picks up
  // tile=9 automatically, and off-road physics already handles tile=9 as
  // 50% top speed — driving into water just slows you down.
  const rivers = (state.rivers || []) as unknown[];
  for (const rrow of rivers) {
    if (!Array.isArray(rrow) || rrow.length < 6) continue;
    const rv = rrow as Array<number | string>;
    const w = rv[0] as number;
    const pts: Array<[number, number]> = [];
    for (let i = 2; i < rv.length; i += 2) {
      if (typeof rv[i] === 'number' && typeof rv[i + 1] === 'number') {
        pts.push([rv[i] as number, rv[i + 1] as number]);
      }
    }
    if (pts.length < 2) continue;
    _weStampRiverTiles(w, pts, deps);
  }
  const lakes = (state.lakes || []) as unknown[];
  for (const lrow of lakes) {
    if (!Array.isArray(lrow) || lrow.length < 8) continue;
    const lk = lrow as Array<number | string>;
    const name = lk[0] as string;
    const pts: Array<[number, number]> = [];
    for (let i = 1; i < lk.length; i += 2) {
      if (typeof lk[i] === 'number' && typeof lk[i + 1] === 'number') {
        pts.push([lk[i] as number, lk[i + 1] as number]);
      }
    }
    if (pts.length < 3) continue;
    _weStampLake({ name, pts }, deps);
  }

  // Phase 5: user buildings (tile=17). LAST so footprints overwrite any
  // surface/road tiles inside them — buildings should look solid even if
  // a surface was drawn first.
  const blds = (state.buildings || []) as unknown[];
  for (const brow of blds) {
    if (!Array.isArray(brow) || brow.length < 8) continue;
    const b = brow as Array<number | string>;
    const name = b[0] as string;
    const type = b[1] as string;
    const pts: Array<[number, number]> = [];
    for (let i = 2; i < b.length; i += 2) {
      if (typeof b[i] === 'number' && typeof b[i + 1] === 'number') {
        pts.push([b[i] as number, b[i + 1] as number]);
      }
    }
    if (pts.length < 3) continue;
    // H1006: residences carve a drivable garage notch at the front edge.
    _weStampBuilding({ name, type, pts }, deps, _weGarageLanesForBuilding(String(type ?? '')));
  }

  // Phase 6: bridgePts auto-compute. For each user road with z>=2, find
  // its segment intersections with every lower-z road and store as
  // bridgePts. The bridge renderer reads these to draw the concrete deck
  // section at each crossing — without this, user-marked bridges still
  // get elevated render order but no deck visual at crossings. The boot-
  // time bridge detector only runs once and can't see user roads, so we
  // need our own pass here. Lives inside _weApplyOverlay so it fires
  // both at boot (overlay loaded from localStorage) and on every edit.
  //
  // v8.99.124.25: ALSO catch the snap-endpoint case — bridge polyline
  // point lies on a ground-road segment within the ground road's
  // half-width. segHit's strict (0.01, 0.99) interval rejects t=0/1, so
  // Pass B projects every bridge polyline point onto every ground
  // segment to recover those crossings.
  //
  // v8.99.124.39: comparative z — only consider roads strictly below me.
  // Earlier versions used `(r2.z||0) >= 2 continue` (ground only) which
  // failed when a user marks a road as bridge over an existing baseline
  // highway (z=4) — the highway crossing was rejected because z=4 was
  // "not ground." Comparative version handles every level pairing.
  if (baseline.liveMajorRoads) {
    const baseLen = baseline.liveMajorRoads.length;
    for (let i = baseLen; i < deps.majorRoads.length; i++) {
      const r1 = deps.majorRoads[i];
      if ((r1.z || 0) < 2) {
        r1.bridgePts = undefined;
        continue;
      }
      const bps: Array<{ x: number; y: number }> = [];
      const p1 = r1.pts;
      // Dedupe — bridge concrete deck uses BRIDGE_R=20 tiles for its
      // near-bridge check, so points within ~2 tiles produce the same
      // render result. Cluster aggressively.
      const addBp = (x: number, y: number): void => {
        for (const bp of bps) {
          if (Math.abs(bp.x - x) < 2 && Math.abs(bp.y - y) < 2) return;
        }
        bps.push({ x, y });
      };
      for (let j = 0; j < deps.majorRoads.length; j++) {
        if (i === j) continue;
        const r2 = deps.majorRoads[j];
        if ((r2.z || 0) >= (r1.z || 0)) continue;
        const p2 = r2.pts;
        // Pass A: original mid-segment crossing (segHit excludes endpoints).
        for (let a = 0; a < p1.length - 1; a++) {
          for (let b = 0; b < p2.length - 1; b++) {
            const h = segHit(
              p1[a][0], p1[a][1], p1[a + 1][0], p1[a + 1][1],
              p2[b][0], p2[b][1], p2[b + 1][0], p2[b + 1][1],
            );
            if (h) addBp(h.x, h.y);
          }
        }
        // Pass B: bridge polyline point lies on ground road segment.
        // Catches snap-endpoint cases where t=0 or t=1 in segHit.
        // Half-width margin scales with the target road (totalW = w*0.85
        // tiles per getRoadProfile, so half-width = w*0.425; we use
        // w*0.5 for a small margin).
        const halfW = (r2.w || 4) * 0.5;
        const halfW2 = halfW * halfW;
        for (let a = 0; a < p1.length; a++) {
          const px = p1[a][0];
          const py = p1[a][1];
          for (let b = 0; b < p2.length - 1; b++) {
            const ax = p2[b][0];
            const ay = p2[b][1];
            const bx = p2[b + 1][0];
            const by = p2[b + 1][1];
            const vx = bx - ax;
            const vy = by - ay;
            const len2 = vx * vx + vy * vy;
            if (len2 < 0.0001) continue;
            let t = ((px - ax) * vx + (py - ay) * vy) / len2;
            t = Math.max(0, Math.min(1, t));
            const projX = ax + t * vx;
            const projY = ay + t * vy;
            const dd = (projX - px) * (projX - px) + (projY - py) * (projY - py);
            if (dd < halfW2) addBp(projX, projY);
          }
        }
      }
      r1.bridgePts = bps.length ? bps : undefined;
    }
  }
}

/** Save the overlay to storage, re-apply it on top of the baseline,
 *  then re-build the game-side per-road render caches and mark the
 *  editor for redraw. Called every time an editor mutation should
 *  produce visible output — vertex drag commit, draft commit, road
 *  delete, baseline-vertex move, etc.
 *
 *  Why save BEFORE apply: if `_weApplyOverlay` crashes (a malformed
 *  overlay row, a stamp helper throwing), the on-disk state is
 *  already at the new shape so the user's edit survives the reload.
 *  The monolith uses this ordering for exactly this reason (L10460-
 *  L10462).
 *
 *  Render caches (v8.99.124.22): `preprocessRoadsForRender` builds
 *  per-road _mainPath / _bbox / _prof / _chunks / _dividerPaths
 *  AND the _sortedRoadsByZ array that the actual stroke renderer
 *  iterates. Without this call, user-added roads only render their
 *  jagged Bresenham tile=1 stamps with no smooth asphalt stroke.
 *  Optional in deps because the modular tree may not have the
 *  game-side renderer wired up yet during early porting; the
 *  monolith call site at L10467 also guards on
 *  `typeof preprocessRoadsForRender === 'function'`.
 *
 *  Ported 1:1 from monolith _weRebuildWorld (L10460-10469). */
export function _weRebuildWorld(
  state: WorldEditorState,
  baseline: BaselineSnapshot,
  deps: ApplyDeps,
): void {
  deps.saveOverlayToStorage(state);
  _weApplyOverlay(state, baseline, deps);
  if (deps.preprocessRoadsForRender) deps.preprocessRoadsForRender();
  deps.markNeedsRedraw(state);
}
