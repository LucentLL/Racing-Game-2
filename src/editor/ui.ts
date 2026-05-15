/**
 * World Editor — DOM wiring (button handlers + keyboard binding).
 *
 * `_weBindUI` is the single function that connects every editor DOM
 * element to its handler. Called once at init (after the editor
 * overlay HTML is in the DOM). Three classes of binding:
 *
 *  1. CANVAS EVENT LISTENERS: mousedown/move/up/wheel/contextmenu +
 *     touchstart/move/end on #weCanvas. All eight are passive:false so
 *     the editor can preventDefault for pan/zoom/draft (otherwise the
 *     browser would handle wheel scroll, page-pinch zoom, and
 *     long-press context menu and the editor would feel broken).
 *
 *  2. TOOLBAR BUTTON CLICKS: 13 simple bindings (Place, AddLane,
 *     Surface, River, Lake, Building, Select, Done, Cancel, Delete,
 *     SnapEnds, Smooth, Export, Reload, Exit, EntryBtn) + the three
 *     Select-mode buttons (Whole, Section, Point) with shared handler
 *     reading data-selmode (v8.99.126.47).
 *
 *  3. PROP INPUTS + SPECIAL HANDLERS: every #wePropX input fires
 *     _weReadProps on input/change. Plus six special handlers:
 *       - Lane buttons (4/6/8/12 — drive draftProps.w + maj since
 *         v8.99.124.23 replaced wePropW)
 *       - Bridge checkbox → Z (one-way: Bridge sets Z to current
 *         max-crossed-z + 2)
 *       - Material/age buttons (asphalt/concrete/new/old/auto — v126.50)
 *       - Merge alignment buttons (L/C/R/Auto — v126.05)
 *       - Merge type buttons (Std/Loop/Stop/Yield — v126.36 + .53)
 *       - Angle-ref pick button (v126.41 — sets angleRefMode, next
 *         canvas click consumes)
 *
 * TOOL-SWITCH CONTRACT: every tool button click runs the same reset
 * sequence — clear ALL selection indices (including the v124.28
 * river/lake adds, the v126.46 baseline-road add, the v126.47
 * segment-idx add), clear activeVertex, cancel any draft whose kind
 * doesn't match the new tool. The original v124.x version forgot to
 * clear v126.46/.47 fields on tool-switch and the result was a phantom
 * "PERM ROAD #N" in the status bar with stale active-vertex state.
 *
 * ➕ LANE PRESET (`weBtnAddLane`, v8.99.126.59): one-click preset that
 * puts the editor in tapered-auxiliary-lane mode. Sets tool='place',
 * draftProps.merge=true, mergeAlign=4 (Auto/click-bonded), mergeType=0
 * (Standard) — these three together trigger the existing tapered-
 * merge-polygon rendering pipeline (editor/merge/taper.ts —
 * _weBuildTaperedMergeEdges). Cancels any in-progress draft first so
 * the merge flag toggle doesn't re-bond already-placed points. Syncs
 * UI button visual states (merge checkbox, alignment Auto, type Std).
 *
 * KEYBOARD BINDING (window-level): F9 toggles the editor (dev-gated;
 * see editor/index.ts DevGate). Inside the editor:
 *
 *   Escape         → cancel draft (if any) else exit editor
 *   Enter          → commit draft (if any)
 *   Delete/Backspace → delete selected (if select tool + something
 *                      selected) else pop last draft point (with
 *                      draft cleanup when pts empties)
 *
 * TEXT-INPUT BAIL (v8.99.124.32): all keyboard handling bails entirely
 * if focus is on a text/number input, textarea, or contenteditable
 * element. Before this, Backspace fired the "pop draft point" handler
 * with preventDefault, which made the user unable to delete characters
 * in the Curve/Name/Z fields. Escape/Enter/Delete were also intercepted
 * in the same way. F9 is ALSO gated by this — opening or closing the
 * editor mid-edit would discard whatever the user was typing.
 *
 * DELETE BINDING SCOPE (v8.99.126.47): the keyboard Delete binding's
 * `hasSel` check now includes selectedKind==='baselineRoad'. Permanent
 * roads got deletable via the keyboard at the same time
 * _weDeleteSelected gained its baseline branch — Whole mode pushes idx
 * into baselineDeletes; Point mode shortens pts via baselineEdits;
 * Section mode does a baseline→overlay promotion (split). All three
 * paths persist.
 *
 * WINDOW RESIZE: bound here so the editor canvas tracks window size
 * when the editor is active. _weResizeCanvas is the resize handler;
 * it bails when WORLD_EDITOR.active is false to avoid touching the
 * canvas while the editor is hidden.
 *
 * Ported from monolith L16610-17179.
 *
 * SCAFFOLD status: type contract + entry point stubbed with TODO line refs.
 */

import type { WorldEditorState } from './index';

/** Host bindings for the UI wiring. Every handler defers to the
 *  module that owns the relevant state — ui.ts is glue, not logic. */
export interface UiBindDeps {
  /** Canvas event handlers (editor/input.ts). */
  canvasMouseDown(e: MouseEvent): void;
  canvasMouseMove(e: MouseEvent): void;
  canvasMouseUp(e: MouseEvent): void;
  canvasWheel(e: WheelEvent): void;
  canvasContextMenu(e: MouseEvent): void;
  touchStart(e: TouchEvent): void;
  touchMove(e: TouchEvent): void;
  touchEnd(e: TouchEvent): void;
  /** Lifecycle (editor/index.ts). */
  toggleEditor(): void;
  exitEditor(): void;
  resizeCanvas(): void;
  /** Draft (editor/draft.ts). */
  commitDraft(): void;
  cancelDraft(): void;
  /** Select / delete / smooth (editor/select.ts + editor/delete.ts). */
  deleteSelected(): void;
  snapSelectedEndpoints(): void;
  smoothSelectedPolygon(): void;
  /** Material + age scope apply (editor/delete.ts). */
  applyMaterialOrAge(
    field: 'material' | 'age',
    value: 'asphalt' | 'concrete' | 'new' | 'old' | 'auto',
  ): void;
  /** Export + reload (editor/export.ts). */
  readProps(): void;
  exportOverlay(): void;
  reloadBaseline(): void;
  /** Dev gate (editor/index.ts). Required for the F9 binding — when
   *  false, F9 is a no-op (matches the in-app entry button hide). */
  isDevToolsEnabled(): boolean;
  /** Default Z for new bridges = max-crossed-z + 2 (v8.99.124.39).
   *  ui.ts asks the world layer; we don't reach into majorRoads from
   *  here directly. */
  computeMaxCrossedZ(road: { pts: number[][] }): number;
}

/** Wire every editor DOM element to its handler. Idempotent only in
 *  the sense that DOM addEventListener tolerates duplicates — the
 *  intent is "call once at init". TODO(E37-followup): port from
 *  L16610-17179. */
export function _weBindUI(_state: WorldEditorState, _deps: UiBindDeps): void {
  // TODO: L16610-17179.
  //   1. Canvas event listeners (8 of them — wheel/touch are
  //      passive:false).
  //   2. Toolbar bindings table (~16 entries). Tool buttons all share
  //      the reset-all-selection sequence — extract a local
  //      _resetSelectionForToolSwitch() helper so the table stays terse.
  //   3. Select-mode buttons via querySelectorAll('.weSelectModeBtn'),
  //      shared handler reading dataset.selmode (Whole/Section/Point).
  //   4. Prop inputs — every PROP_INPUT_IDS entry → input/change →
  //      deps.readProps().
  //   5. Special handlers:
  //        - Lane buttons (drive draftProps.w + maj)
  //        - Bridge → Z one-way sync (compute via deps.computeMaxCrossedZ)
  //        - Material/age buttons → deps.applyMaterialOrAge
  //        - Merge alignment buttons → draftProps.mergeAlign + UI sync
  //        - Merge type buttons → draftProps.mergeType + UI sync +
  //          Loop Diam input visibility (visible only for mergeType=1)
  //        - Angle-ref pick button → angleRefMode = true
  //        - AddLane preset (v126.59 — see module docstring)
  //   6. window.addEventListener('resize', deps.resizeCanvas) gated on
  //      state.active.
  //   7. document.addEventListener('keydown', ...):
  //        - Bail if activeElement is INPUT/TEXTAREA/contentEditable.
  //        - F9 → deps.toggleEditor() (dev-gated via isDevToolsEnabled).
  //        - !state.active → bail (after F9 handling).
  //        - Escape → cancelDraft if draft, else exitEditor.
  //        - Enter → commitDraft if draft.
  //        - Delete/Backspace → deleteSelected if select-tool+hasSel,
  //          else pop last draft point (clear draft when empty).
  //      hasSel check includes all six selectedKind variants
  //      (road/baselineRoad/surface/building/river/lake) per v126.47.
}
