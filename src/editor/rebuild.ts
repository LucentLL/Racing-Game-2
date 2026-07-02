/**
 * H973 — REBUILD ROADS: replay every overlay road through the CURRENT
 * commit pipeline, as if the user had just drawn them in order.
 *
 * Why (user, 2026-07-02): "redraw all roads in the game map based on
 * new conventions for making roads." The editor's conventions have
 * evolved across many eras (weld/fuse H962, lane-center drive path
 * H967, tangent pins, easements…) and rows in a saved world carry
 * whichever convention authored them, with NO per-row era record. The
 * H968 geometric migration proved that inference over such rows is
 * unverifiable (reverted in H972). Regeneration is the honest upgrade:
 * take each row's INTENT — its shape knots, width, type, z, merge
 * type/alignment, material/age/one-way — and re-COMMIT it through
 * today's `_weCommitDraft`, so every road gets today's welds, fuses,
 * smoothing, merge bonding and lane-center data. Unfused end-to-end
 * straights fuse; merge lanes regenerate bonded to the current roads
 * with the drive-path (laneCentered) model.
 *
 * Safety:
 *   - one `_weSnapshotForUndo` before anything mutates — the Back
 *     button restores the ENTIRE previous world in one step;
 *   - rows carrying per-segment material overrides are preserved
 *     VERBATIM (segment indices can't survive re-smoothing);
 *   - the caller passes commit deps whose rebuildWorld is a no-op and
 *     runs the real rebuild ONCE at the end (a per-row world rebuild
 *     would be O(rows²) work for nothing).
 *
 * Knot policy:
 *   - MERGE rows: ends + 2 interior samples — the bonder regenerates
 *     the whole curve from clicks anyway; the baked interior WAS
 *     bonder output, so feeding it back verbatim would fight the new
 *     easements.
 *   - PLAIN rows: the user's drawn shape is sacred — keep it, but
 *     downsample dense baked lines to ≤16 arc-uniform knots so the
 *     re-smooth regenerates density instead of ballooning the row
 *     (73 baked pts × 8 samples/knot would explode).
 */

import type { WorldEditorState, EditorDraft } from './index';
import type { TilePoint } from './stamp';
import { _weCommitDraft, _decodeMergeFlag, type DraftDeps } from './draft';
import { _weSnapshotForUndo } from './undo';

/** Arc-length-uniform resample keeping both endpoints. */
function sampleKnots(pts: ReadonlyArray<TilePoint>, n: number): TilePoint[] {
  if (pts.length <= n) return pts.map((p) => [p[0], p[1]]);
  const seg: number[] = new Array(pts.length - 1);
  let total = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    seg[i] = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
    total += seg[i];
  }
  const out: TilePoint[] = [[pts[0][0], pts[0][1]]];
  for (let k = 1; k < n - 1; k++) {
    let want = (total * k) / (n - 1);
    let i = 0;
    while (i + 1 < seg.length && want > seg[i]) { want -= seg[i]; i++; }
    const t = seg[i] > 0 ? want / seg[i] : 0;
    out.push([
      pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t,
      pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t,
    ]);
  }
  out.push([pts[pts.length - 1][0], pts[pts.length - 1][1]]);
  return out;
}

export interface RebuildResult {
  rebuilt: number;
  preserved: number;
  skipped: number;
  /** True when a per-row commit threw and the pre-rebuild world was
   *  restored verbatim. The caller must NOT report success. */
  failed?: boolean;
}

/** Replay all overlay roads through the current commit pipeline. The
 *  caller MUST pass DraftDeps whose rebuildWorld is a NO-OP and run the
 *  real world rebuild + save once afterwards. */
export function _weRebuildAllRoads(
  state: WorldEditorState,
  deps: DraftDeps,
): RebuildResult {
  const overlay = state.overlay as unknown[];
  const oldRows = overlay.slice() as Array<(string | number)[]>;
  const oldProps: Record<string, Record<string, unknown>> =
    JSON.parse(JSON.stringify(state.overlayRoadProps ?? {}));
  const oldMatOv: Record<string, unknown[]> =
    JSON.parse(JSON.stringify(state.overlayMaterialOverrides ?? {}));
  const result: RebuildResult = { rebuilt: 0, preserved: 0, skipped: 0 };
  if (!oldRows.length) return result;

  _weSnapshotForUndo(state);
  // Each per-row _weCommitDraft would push its OWN undo snapshot — 25
  // rows would flood the stack and make Back undo one re-commit at a
  // time. Swap in a throwaway bin during the replay so the single
  // full-world snapshot above is what Back restores.
  const realUndoStack = state.undoStack;
  state.undoStack = [];
  overlay.length = 0;
  state.overlayRoadProps = {};
  state.overlayMaterialOverrides = {};
  const savedDraft = state.draft;
  const savedDraftProps = JSON.parse(JSON.stringify(state.draftProps));

  // The replay mutates the LIVE overlay row by row, so a throw from any
  // per-row commit would otherwise leave a partially rebuilt (or empty)
  // world — and the swapped-out undo stack would make Back useless. The
  // 2026-07-02 phone wipe (empty export after a full world) is exactly
  // this failure shape. Restore the pre-rebuild world verbatim on ANY
  // throw; restore draft/undo state on every path.
  try {
    for (let i = 0; i < oldRows.length; i++) {
      const raw = oldRows[i];
      if (!Array.isArray(raw) || raw.length < 8) { result.skipped++; continue; }
      const isMerge = raw.length % 2 === 1;
      const xs = isMerge ? 5 : 4;
      const pts: TilePoint[] = [];
      for (let k = xs; k + 1 < raw.length; k += 2) {
        pts.push([raw[k] as number, raw[k + 1] as number]);
      }
      if (pts.length < 2) { result.skipped++; continue; }
      const props = oldProps[String(i)] ?? {};
      const matOv = oldMatOv[String(i)];

      // Per-segment material overrides can't survive re-smoothing —
      // preserve the row byte-verbatim with its sidecars re-keyed.
      if (Array.isArray(matOv) && matOv.length) {
        const newIdx = overlay.length;
        overlay.push(raw);
        if (Object.keys(props).length) {
          (state.overlayRoadProps as Record<string, unknown>)[String(newIdx)] = props;
        }
        (state.overlayMaterialOverrides as Record<string, unknown>)[String(newIdx)]
          = matOv;
        result.preserved++;
        continue;
      }

      const flag = isMerge ? _decodeMergeFlag((raw[4] as number) | 0)
        : { mergeType: 0, mergeAlign: 1 };
      const knots = isMerge ? sampleKnots(pts, 4)
        : (pts.length > 16 ? sampleKnots(pts, 16) : pts);

      // The commit inherits material/age/oneway from draftProps — feed it
      // the OLD row's sidecar values so the rebuilt row keeps its look.
      state.draftProps.material =
        props.material === 'concrete' ? 'concrete' : 'asphalt';
      state.draftProps.age =
        props.age === 'new' || props.age === 'old' ? (props.age as 'new' | 'old') : 'auto';
      state.draftProps.oneway = props.oneway === true;

      state.draft = {
        kind: 'road',
        pts: knots,
        ptSnaps: [],
        w: raw[0] as number,
        maj: raw[1] as number,
        name: String(raw[2] ?? 'Road'),
        z: (raw[3] as number) | 0,
        merge: isMerge,
        mergeAlign: flag.mergeAlign,
        mergeType: flag.mergeType,
        arc: false,
        curve: 0,
      } as unknown as EditorDraft;
      _weCommitDraft(state, deps);
      result.rebuilt++;
    }
  } catch {
    overlay.length = 0;
    for (const r of oldRows) overlay.push(r);
    state.overlayRoadProps = oldProps as typeof state.overlayRoadProps;
    state.overlayMaterialOverrides = oldMatOv as typeof state.overlayMaterialOverrides;
    result.rebuilt = 0;
    result.preserved = 0;
    result.skipped = 0;
    result.failed = true;
  } finally {
    state.draft = savedDraft;
    state.draftProps = savedDraftProps;
    state.undoStack = realUndoStack;
    state.needsRedraw = true;
  }
  return result;
}
