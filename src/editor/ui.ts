/**
 * World Editor — DOM wiring (button handlers + keyboard binding).
 *
 * `_weBindUI` is the single function that connects every editor DOM
 * element to its handler. Called once at init (after the editor
 * overlay HTML is in the DOM). Two classes of binding:
 *
 *  1. TOOLBAR BUTTON CLICKS: 13 simple bindings (Place, AddLane,
 *     Surface, River, Lake, Building, Select, Done, Cancel, Delete,
 *     SnapEnds, Smooth, Export, Reload, Exit, EntryBtn) + the three
 *     Select-mode buttons (Whole, Section, Point) with shared handler
 *     reading data-selmode (v8.99.126.47).
 *
 *  2. PROP INPUTS + SPECIAL HANDLERS: every #wePropX input fires
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
 * KEYBOARD / WINDOW RESIZE: bound window-wide by the host
 * (src/gameLoop.ts installEditorBindings), not here. The monolith's
 * _weBindUI body ALSO wired document keydown + window resize; the
 * modular tree's H117 wiring takes care of both with the same focus-
 * bail + F9 dev-gate + Escape/Enter/Delete semantics described in the
 * monolith equivalent. Duplicating either binding inside _weBindUI
 * would double-fire F9 (toggle on → off in the same key event), and
 * run Escape/Delete/Backspace twice per press.
 *
 * Ported from monolith L16610-17179 (canvas + resize + keydown
 * sections intentionally omitted; see UiBindDeps docstring).
 *
 */

import type { WorldEditorState } from './index';
import { _encodeMergeFlag, _decodeMergeFlag } from './draft';

/** Host bindings for the UI wiring. Every handler defers to the
 *  module that owns the relevant state — ui.ts is glue, not logic.
 *
 *  Canvas pointer events (mousedown/move/up/wheel/contextmenu/touch*)
 *  are intentionally NOT in this deps shape. The modular host
 *  (src/gameLoop.ts installEditorBindings) binds them window-wide so a
 *  draft drag survives the cursor drifting off the canvas; adding a
 *  parallel canvas-level binding here would fire those handlers twice
 *  on every canvas click and push two road points per tap. The
 *  monolith binds them on #weCanvas because it has no separate
 *  window-level wiring — the modular tree picked the window path
 *  during H117 and ui.ts defers to it. */
export interface UiBindDeps {
  /** Lifecycle (editor/index.ts). */
  toggleEditor(): void;
  exitEditor(): void;
  /** Draft (editor/draft.ts). */
  commitDraft(): void;
  cancelDraft(): void;
  /** Select / delete / smooth (editor/select.ts + editor/delete.ts). */
  deleteSelected(): void;
  /** H892: undo the last structural action (commit/delete) via the
   *  snapshot stack (editor/undo.ts). No-op when nothing to undo. */
  undo(): void;
  snapSelectedEndpoints(): void;
  smoothSelectedPolygon(): void;
  /** Material + age scope apply (editor/delete.ts). */
  applyMaterialOrAge(
    field: 'material' | 'age',
    value: 'asphalt' | 'concrete' | 'new' | 'old' | 'auto',
  ): void;
  /** H886: one-way (directional) flag apply (editor/delete.ts). Writes to
   *  draftProps when nothing is selected, else to the selected road +
   *  sidecar. */
  applyOneway(value: boolean): void;
  /** H970: reverse the selected MERGE row's travel direction (polyline
   *  order = flow). No-ops unless a merge road is selected. */
  flipMergeFlow(): void;
  /** H973: replay every overlay road through the current commit
   *  pipeline (editor/rebuild.ts) — re-welds, re-fuses, re-bonds to
   *  today's conventions. One undo step restores the previous world. */
  rebuildAllRoads(): void;
  /** Export + reload (editor/export.ts). */
  readProps(): void;
  exportOverlay(): void;
  reloadBaseline(): void;
  /** Default Z for new bridges = max-crossed-z + 2 (v8.99.124.39).
   *  ui.ts asks the world layer; we don't reach into majorRoads from
   *  here directly. */
  computeMaxCrossedZ(road: { pts: number[][] }): number;
  /** Rebuild the world after a property edit mutates a selected row.
   *  Same hook as editor/draft.ts / editor/select.ts pass — ui.ts
   *  doesn't reach into the world layer directly. */
  rebuildWorld(): void;
  /** Apply a snapped (5°-stepped) user angle to the currently selected
   *  road by rotating its chord around the centroid (v8.99.126.41).
   *  Ported in a follow-up H commit; for now the host wires a no-op
   *  passthrough so this binding compiles. */
  applyAngleToSelectedRoad(snappedDeg: number): void;
  /** H904: re-run the hover snap at the last hover tile so the magenta
   *  lane ring + preview update after a lane/side override change (no
   *  mousemove). */
  refreshHoverSnap(): void;
  /** H991: span ops (editor/span.ts). Split the selected road at the two
   *  armed span cut points; spanSetZ/spanBridge apply z to the middle
   *  piece and return the applied z (null = refused/no-op). */
  spanSplit(): void;
  spanSetZ(z: number): number | null;
  spanBridge(checked: boolean): number | null;
  /** H1000: rotate the selected building by `deltaDeg` about its centroid
   *  and re-emit its concrete driveway from the new front. No-op unless a
   *  building is selected. */
  rotateSelectedBuilding(deltaDeg: number): void;
}

/** Reset every selection key + activeVertex + selectedKind. Called by
 *  every tool-switch handler. v124.28 added river/lake, v126.46 added
 *  baseline road, v126.47 added segment-idx. Forgetting any of these
 *  in a tool switch produces phantom "PERM ROAD #N" status entries
 *  with stale active-vertex state. */
function resetSelectionForToolSwitch(state: WorldEditorState): void {
  state.selected = -1;
  state.selectedSurface = -1;
  state.selectedBuilding = -1;
  state.selectedRiver = -1;
  state.selectedLake = -1;
  state.selectedParkingLot = -1;
  state.selectedBaselineRoad = -1;
  state.selectedSegmentIdx = -1;
  state.selectedKind = null;
  state.activeVertex = -1;
  // H991: drop any armed span cut points with the selection.
  state.spanA = null;
  state.spanB = null;
  // H955: also clear the merge lane-snap latch (H907). mergeLaneAnchorTile is
  // the field that keeps the magenta lane ring (hoverSnap, kind='lane') alive
  // via the input.ts keeper branch; if it's never nulled the ring survives a
  // tool-switch AND Confirm (which calls this). Null the latch + the rendered
  // hoverSnap + the lane/side overrides.
  state.hoverSnap = null;
  state.mergeLaneAnchorTile = null;
  state.mergeLaneOverride = null;
  state.mergeSideOverride = null;
}

/** Wire every editor DOM element to its handler. Idempotent only in
 *  the sense that DOM addEventListener tolerates duplicates — the
 *  intent is "call once at init". Ported 1:1 from monolith L16610-17179. */
export function _weBindUI(state: WorldEditorState, deps: UiBindDeps): void {
  // Canvas pointer events (mousedown/move/up/wheel/contextmenu/touch*) are
  // bound window-wide by the host (src/gameLoop.ts installEditorBindings),
  // not here — see the UiBindDeps docstring for the rationale.

  // 1. TOOLBAR BUTTONS. Tool buttons share resetSelectionForToolSwitch;
  //    every "set tool" button cancels any draft whose kind doesn't match
  //    the new tool (per v124.28).
  const bindings: Array<[string, (e?: MouseEvent) => void]> = [
    ['weBtnPlace', () => {
      state.tool = 'place';
      resetSelectionForToolSwitch(state);
      if (state.draft && state.draft.kind !== 'road') deps.cancelDraft();
      state.needsRedraw = true;
    }],
    // v8.99.126.59: ➕ Lane preset — tapered auxiliary-lane mode. Sets
    // road tool + merge=true + mergeAlign=4 (Auto) + mergeType=0 (Std)
    // so the tapered-merge-polygon pipeline (editor/merge/taper.ts) fires
    // on commit. Cancels any in-flight draft first so the toggle doesn't
    // re-bond already-placed points.
    ['weBtnAddLane', () => {
      state.tool = 'place';
      resetSelectionForToolSwitch(state);
      if (state.draft) deps.cancelDraft();
      state.draftProps.merge = true;
      state.draftProps.mergeAlign = 4;
      state.draftProps.mergeType = 0;
      // H977: lanes are ground-attached by default. A stale Bridge ✓
      // left over from bridge drawing forced z>=2 onto every lane,
      // silently routing it through the cross-z ramp bond + bridge
      // underlay — the user's 2026-07-02 "floating needle" merge lanes
      // (fixtures/road-lab-v1.json rows 5/7 vs the z=0 controls).
      // Clear the flag and Z; re-check Bridge deliberately when a lane
      // really is an elevated ramp.
      state.draftProps.z = 0;
      const brEl = document.getElementById('wePropBridge') as HTMLInputElement | null;
      if (brEl) brEl.checked = false;
      const zEl977 = document.getElementById('wePropZ') as HTMLInputElement | null;
      if (zEl977) zEl977.value = '0';
      const mgEl = document.getElementById('wePropMerge') as HTMLInputElement | null;
      if (mgEl) mgEl.checked = true;
      document.querySelectorAll<HTMLElement>('.weMergeAlignBtn').forEach((b) => {
        b.classList.toggle('weMergeAlignActive', parseInt(b.dataset.align || '0') === 4);
      });
      document.querySelectorAll<HTMLElement>('.weMergeTypeBtn').forEach((b) => {
        b.classList.toggle('weMergeTypeActive', parseInt(b.dataset.mtype || '0') === 0);
      });
      const ldLabel = document.getElementById('weLoopDiamLabel');
      if (ldLabel) ldLabel.style.display = 'none';
      state.needsRedraw = true;
    }],
    ['weBtnSurface', () => {
      state.tool = 'surface';
      resetSelectionForToolSwitch(state);
      if (state.draft && state.draft.kind !== 'surface') deps.cancelDraft();
      state.needsRedraw = true;
    }],
    ['weBtnRiver', () => {
      state.tool = 'river';
      resetSelectionForToolSwitch(state);
      if (state.draft && state.draft.kind !== 'river') deps.cancelDraft();
      state.needsRedraw = true;
    }],
    ['weBtnLake', () => {
      state.tool = 'lake';
      resetSelectionForToolSwitch(state);
      if (state.draft && state.draft.kind !== 'lake') deps.cancelDraft();
      state.needsRedraw = true;
    }],
    ['weBtnBuilding', () => {
      state.tool = 'building';
      resetSelectionForToolSwitch(state);
      if (state.draft && state.draft.kind !== 'building') deps.cancelDraft();
      state.needsRedraw = true;
    }],
    // H693: parking-lot tool. Mirrors surface/building shape — sets the
    // tool mode, clears selection, drops any in-flight draft of a
    // different kind. Tile=18 stripe rendering lives in ground.ts.
    ['weBtnParkingLot', () => {
      state.tool = 'parkingLot';
      resetSelectionForToolSwitch(state);
      if (state.draft && state.draft.kind !== 'parkingLot') deps.cancelDraft();
      state.needsRedraw = true;
    }],
    ['weBtnSelect', () => {
      state.tool = 'select';
      if (state.draft) deps.cancelDraft();
      state.needsRedraw = true;
    }],
    // H966: Done now mirrors Confirm's full selection reset — commitDraft
    // clears the merge snap latch itself (draft.ts), and the tool-switch
    // reset covers the selection indices so the next action starts clean.
    ['weBtnDone', () => {
      deps.commitDraft();
      resetSelectionForToolSwitch(state);
      state.needsRedraw = true;
    }],
    ['weBtnCancel', () => deps.cancelDraft()],
    // H892: Back — while drawing, drop the last placed point; with a
    // single point left, cancel the draft; otherwise undo the last
    // structural action (commit/delete) via the snapshot stack.
    ['weBtnBack', () => {
      const d = state.draft as { pts?: Array<[number, number]>; ptSnaps?: unknown[] } | null;
      if (d && Array.isArray(d.pts) && d.pts.length > 1) {
        d.pts.pop();
        // H902: keep the merge bond-target array aligned with pts.
        if (Array.isArray(d.ptSnaps)) d.ptSnaps.pop();
        // H966: a popped endpoint's lane/side picks shouldn't bleed into
        // the re-placed point — reset the overrides to auto (the anchor
        // stays; the draft is still active and the ring should hold).
        state.mergeLaneOverride = null;
        state.mergeSideOverride = null;
        state.needsRedraw = true;
      } else if (d) {
        deps.cancelDraft();
      } else {
        deps.undo();
      }
    }],
    // H892: Confirm — finish any in-flight draft, then deselect everything.
    ['weBtnConfirm', () => {
      if (state.draft) deps.commitDraft();
      resetSelectionForToolSwitch(state);
      state.needsRedraw = true;
    }],
    ['weBtnDelete', () => deps.deleteSelected()],
    // H991: split the selected road at the two armed span cut points
    // without changing anything else (middle piece stays selected).
    ['weBtnSpanSplit', () => deps.spanSplit()],
    ['weBtnSnapEnds', () => deps.snapSelectedEndpoints()],
    ['weBtnSmooth', () => deps.smoothSelectedPolygon()],
    ['weBtnRebuildRoads', () => deps.rebuildAllRoads()],
    ['weBtnExport', () => deps.exportOverlay()],
    ['weBtnReload', () => deps.reloadBaseline()],
    ['weBtnExit', () => deps.exitEditor()],
    ['weEntryBtn', () => deps.toggleEditor()],
  ];
  for (const [id, fn] of bindings) {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', fn as EventListener);
  }

  // 2. SELECT-MODE BUTTONS (v8.99.126.47) — Whole / Section / Point /
  //    Span (H991). All share one handler reading dataset.selmode.
  //    Auto-switches tool=select so the user can pick a mode without
  //    first clicking the Select button. Clears segmentIdx +
  //    activeVertex + span since the meaning of "selection" differs
  //    between modes.
  document.querySelectorAll<HTMLElement>('.weSelectModeBtn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.selmode;
      if (mode !== 'whole' && mode !== 'section' && mode !== 'point' && mode !== 'span') return;
      state.tool = 'select';
      if (state.draft) deps.cancelDraft();
      state.selectMode = mode;
      state.selectedSegmentIdx = -1;
      state.activeVertex = -1;
      state.spanA = null;
      state.spanB = null;
      document.querySelectorAll<HTMLElement>('.weSelectModeBtn').forEach((b) => {
        b.classList.toggle('weSelectModeActive', b.dataset.selmode === mode);
      });
      state.needsRedraw = true;
    });
  });

  // 3. MATERIAL / AGE BUTTONS (v8.99.126.50) — dual scope: a selected
  //    Section overrides just that segment via materialOverrides; otherwise
  //    sets on the whole road (or on draftProps if no road selected).
  document.querySelectorAll<HTMLElement>('.weMaterialBtn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mat = btn.dataset.material;
      if (mat !== 'asphalt' && mat !== 'concrete') return;
      deps.applyMaterialOrAge('material', mat);
      document.querySelectorAll<HTMLElement>('.weMaterialBtn').forEach((b) => {
        b.classList.toggle('weMaterialActive', b.dataset.material === mat);
      });
      state.needsRedraw = true;
    });
  });
  document.querySelectorAll<HTMLElement>('.weAgeBtn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const age = btn.dataset.age;
      if (age !== 'auto' && age !== 'new' && age !== 'old') return;
      deps.applyMaterialOrAge('age', age);
      document.querySelectorAll<HTMLElement>('.weAgeBtn').forEach((b) => {
        b.classList.toggle('weAgeActive', b.dataset.age === age);
      });
      state.needsRedraw = true;
    });
  });

  // 4. PROP INPUT CHANGE LOOP. wePropBridge is NOT in this list — it has
  //    a custom handler below. The generic readProps would otherwise fire
  //    on Bridge's input event before the custom handler runs, syncing
  //    brEl.checked back from Z (which is still 0 at that point) and
  //    silently un-toggling the click.
  ['wePropName','wePropZ','wePropMaj','wePropMerge','wePropDriveway','wePropArc','wePropCurve','wePropLoopDiam','wePropStallW','wePropStallL','wePropAisleW','wePropAdaCount'].forEach((id) => {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (el) {
      el.addEventListener('input', () => deps.readProps());
      if (el.type === 'checkbox') el.addEventListener('change', () => deps.readProps());
    }
  });

  // 5. MERGE CHECKBOX SPECIAL (v8.99.126.00) — also mutates the SELECTED
  //    road's row when toggled. Row-schema flip: turning Merge on inserts
  //    `1` (encoded via _encodeMergeFlag with current align+type) at
  //    index 4 (promoting 4-meta → 5-meta); turning off removes index 4.
  //    Coords always live AFTER the meta block, so splice(4,*) only ever
  //    touches the meta region.
  const mergeEl = document.getElementById('wePropMerge') as HTMLInputElement | null;
  if (mergeEl) {
    mergeEl.addEventListener('change', () => {
      if (state.selectedKind !== 'road' || state.selected < 0) return;
      const r = state.overlay[state.selected] as unknown[];
      if (!r || !Array.isArray(r)) return;
      const isOdd = (r.length & 1) === 1;
      // H887: Auto (4) default — matches the highlighted toolbar button
      // and the draftProps init; the old `|| 1` silently applied Center
      // (centerline straddle) when the user just ticked Merge.
      const curAlign = state.draftProps.mergeAlign || 4;
      const curType = state.draftProps.mergeType || 0;
      const curFlag = _encodeMergeFlag(curType, curAlign);
      if (mergeEl.checked) {
        if (!isOdd) r.splice(4, 0, curFlag);
        else r[4] = curFlag;
      } else {
        if (isOdd) r.splice(4, 1);
      }
      deps.rebuildWorld();
    });
  }

  // 5b. ONE-WAY CHECKBOX (H886) — directional road-model Phase 1. Unlike
  //     Merge (which lives in the numeric row), one-way rides the
  //     overlayRoadProps/baselineRoadProps sidecar, so the apply helper
  //     owns both the draftProps-inherit path (nothing selected) and the
  //     selected-road write + serialize. No row mutation here.
  const onewayEl = document.getElementById('wePropOneway') as HTMLInputElement | null;
  if (onewayEl) {
    onewayEl.addEventListener('change', () => {
      deps.applyOneway(!!onewayEl.checked);
    });
  }

  // 6. CURVE REVERSE BUTTON (v8.99.126.01) — negates Curve so mobile
  //    users (numeric keyboards may hide "-") can flip arc bulge sides.
  const curveRevBtn = document.getElementById('wePropCurveRev');
  if (curveRevBtn) {
    curveRevBtn.addEventListener('click', () => {
      const cEl = document.getElementById('wePropCurve') as HTMLInputElement | null;
      if (!cEl) return;
      const cur = parseFloat(cEl.value);
      const flipped = isFinite(cur) ? -cur : 0;
      cEl.value = String(flipped);
      state.draftProps.curve = flipped;
      state.needsRedraw = true;
    });
  }

  // 7. ANGLE-REF PICK BUTTON (v8.99.126.41) — toggles reference-pick
  //    mode. Pick mode consumes the next canvas tap to set
  //    angleRefDirection. Only valid with a road selected.
  const angleRefBtn = document.getElementById('weBtnAngleRef');
  if (angleRefBtn) {
    angleRefBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (state.selectedKind !== 'road' || state.selected < 0) return;
      state.angleRefMode = !state.angleRefMode;
      state.needsRedraw = true;
    });
  }

  // 8. ANGLE INPUT (v8.99.126.41). Rotates the selected road so its
  //    chord lies at (refAngle + userAngle). Snap to 5° (input has
  //    step=5 but mobile browsers may accept arbitrary values).
  const angleEl = document.getElementById('wePropAngle') as HTMLInputElement | null;
  if (angleEl) {
    angleEl.addEventListener('input', () => {
      const v = parseFloat(angleEl.value);
      if (!isFinite(v)) return;
      const snapped = Math.round(v / 5) * 5;
      deps.applyAngleToSelectedRoad(snapped);
    });
  }

  // 9. ROAD CATEGORY BUTTONS (v8.99.126.42) — Minor / Major / Driveway
  //     presets. Sets maj + w + name (only when name is still at one of
  //     the auto-defaults) + material. Syncs hidden Major checkbox + Lane
  //     button active class. Mutates selected road's row when one's
  //     selected. v126.50: Driveway defaults material to concrete.
  const applyRoadCategory = (cat: string): void => {
    let maj = 0, w = 6, defaultName = 'New Road';
    let defaultMat: 'asphalt' | 'concrete' = 'asphalt';
    if (cat === 'major') { maj = 1; w = 6; defaultName = 'New Road'; defaultMat = 'asphalt'; }
    else if (cat === 'driveway') { maj = 0; w = 2; defaultName = 'Driveway'; defaultMat = 'concrete'; }
    else { maj = 0; w = 4; defaultName = 'New Road'; defaultMat = 'asphalt'; }
    state.draftProps.maj = maj;
    state.draftProps.w = w;
    state.draftProps.material = defaultMat;
    document.querySelectorAll<HTMLElement>('.weMaterialBtn').forEach((b) => {
      b.classList.toggle('weMaterialActive', b.dataset.material === defaultMat);
    });
    const nEl = document.getElementById('wePropName') as HTMLInputElement | null;
    const cur = nEl ? (nEl.value || '') : '';
    if (cur === '' || cur === 'New Road' || cur === 'Driveway') {
      state.draftProps.name = defaultName;
      if (nEl) nEl.value = defaultName;
    }
    const mEl = document.getElementById('wePropMaj') as HTMLInputElement | null;
    if (mEl) mEl.checked = (maj === 1);
    document.querySelectorAll<HTMLElement>('.weLaneBtn').forEach((b) => {
      const bw = parseInt(b.dataset.w || '6') || 6;
      b.classList.toggle('weLaneBtnActive', bw === w);
    });
    if (state.draft && state.draft.kind === 'road') {
      state.draft.maj = maj;
      state.draft.w = w;
      if (cur === '' || cur === 'New Road' || cur === 'Driveway') state.draft.name = defaultName;
    }
    if (state.selectedKind === 'road' && state.selected >= 0) {
      const r = state.overlay[state.selected] as unknown[];
      if (r && Array.isArray(r) && r.length >= 4) {
        (r as (string | number)[])[0] = w;
        (r as (string | number)[])[1] = maj;
        if (cur === '' || cur === 'New Road' || cur === 'Driveway') {
          (r as (string | number)[])[2] = defaultName;
        }
        deps.rebuildWorld();
      }
    }
    state.needsRedraw = true;
  };
  document.querySelectorAll<HTMLElement>('.weRoadCatBtn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const cat = btn.dataset.cat || 'minor';
      document.querySelectorAll<HTMLElement>('.weRoadCatBtn').forEach((b) => b.classList.remove('weRoadCatActive'));
      btn.classList.add('weRoadCatActive');
      applyRoadCategory(cat);
    });
  });

  // 10. MERGE ALIGNMENT BUTTONS (v8.99.126.05) — L / C / R. Sets
  //     draftProps.mergeAlign + active class, lives draft, and mutates
  //     the selected merge-form row's row[4] (preserving mergeType in
  //     tens digit per v126.36). Only acts on rows already in merge
  //     form (odd length).
  document.querySelectorAll<HTMLElement>('.weMergeAlignBtn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const align = parseInt(btn.dataset.align || '1') || 1;
      state.draftProps.mergeAlign = align;
      document.querySelectorAll<HTMLElement>('.weMergeAlignBtn').forEach((b) => b.classList.remove('weMergeAlignActive'));
      btn.classList.add('weMergeAlignActive');
      if (state.draft && state.draft.kind === 'road') state.draft.mergeAlign = align;
      if (state.selectedKind === 'road' && state.selected >= 0) {
        const r = state.overlay[state.selected] as unknown[];
        if (r && (r.length & 1) === 1) {
          const dec = _decodeMergeFlag(((r as number[])[4] | 0));
          (r as number[])[4] = _encodeMergeFlag(dec.mergeType || 0, align);
          deps.rebuildWorld();
        }
      }
      state.needsRedraw = true;
    });
  });

  // 11. MERGE TYPE BUTTONS (v8.99.126.36) — Standard / Cloverleaf Loop.
  //     Sets draftProps.mergeType + active class, lives draft, mutates
  //     selected row's mergeType. v126.39: Loop Diam input visibility
  //     tracks mergeType (only visible for mergeType=1).
  document.querySelectorAll<HTMLElement>('.weMergeTypeBtn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mtype = parseInt(btn.dataset.mtype || '0') || 0;
      state.draftProps.mergeType = mtype;
      document.querySelectorAll<HTMLElement>('.weMergeTypeBtn').forEach((b) => b.classList.remove('weMergeTypeActive'));
      btn.classList.add('weMergeTypeActive');
      if (state.draft && state.draft.kind === 'road') state.draft.mergeType = mtype;
      const ldLabel = document.getElementById('weLoopDiamLabel');
      if (ldLabel) ldLabel.style.display = mtype === 1 ? '' : 'none';
      if (state.selectedKind === 'road' && state.selected >= 0) {
        const r = state.overlay[state.selected] as unknown[];
        if (r && (r.length & 1) === 1) {
          const dec = _decodeMergeFlag(((r as number[])[4] | 0));
          (r as number[])[4] = _encodeMergeFlag(mtype, dec.mergeAlign || 1);
          deps.rebuildWorld();
        }
      }
      state.needsRedraw = true;
    });
  });

  // 11b. H904: MERGE LANE / SIDE CYCLE — explicit per-endpoint selection.
  //      The snap honors state.mergeLaneOverride / mergeSideOverride; a
  //      refreshHoverSnap re-runs the snap so the magenta ring + gore preview
  //      update immediately (the mouse isn't moving). Reset to auto when the
  //      endpoint is placed (input.ts).
  const _cycleLane = (dir: number): void => {
    const hs = state.hoverSnap as { laneIdx?: number; lps?: number } | null;
    const lps = hs && typeof hs.lps === 'number' && hs.lps > 0 ? hs.lps : 8;
    const cur = state.mergeLaneOverride ?? (hs && hs.laneIdx) ?? 1;
    state.mergeLaneOverride = Math.max(1, Math.min(lps, cur + dir));
    deps.refreshHoverSnap();
    state.needsRedraw = true;
  };
  document.getElementById('weMergeLanePrev')?.addEventListener('click', () => _cycleLane(-1));
  document.getElementById('weMergeLaneNext')?.addEventListener('click', () => _cycleLane(+1));
  document.getElementById('weMergeSideFlip')?.addEventListener('click', () => {
    const hs = state.hoverSnap as { side?: 1 | -1 } | null;
    const cur = state.mergeSideOverride ?? (hs && hs.side) ?? 1;
    state.mergeSideOverride = cur === 1 ? -1 : 1;
    deps.refreshHoverSnap();
    state.needsRedraw = true;
  });
  // H970: reverse the SELECTED merge row's travel direction. The flow
  // chevrons (render.ts) show the current direction; delete.ts owns the
  // row mutation + sidecar swap + rebuild.
  document.getElementById('weMergeFlowFlip')?.addEventListener('click', () => {
    deps.flipMergeFlow();
  });

  // H996: BUILDING PRESET BUTTONS — pick a one-click sized footprint (or
  //       'custom' for freeform polygon drawing). Switches to the building
  //       tool so a preset can be chosen without first clicking Building.
  document.querySelectorAll<HTMLElement>('.weBldgPresetBtn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const preset = btn.dataset.preset;
      if (!preset) return;
      state.buildingProps.preset = preset;
      state.tool = 'building';
      if (state.draft && state.draft.kind !== 'building') deps.cancelDraft();
      document.querySelectorAll<HTMLElement>('.weBldgPresetBtn').forEach((b) => {
        b.classList.toggle('weBldgPresetActive', b.dataset.preset === preset);
      });
      state.needsRedraw = true;
    });
  });

  // H1000: BUILDING ROTATE BUTTONS (↺/↻). If a building is selected,
  //        rotate it 45° (and re-emit its driveway); otherwise nudge the
  //        facing used for the NEXT placed preset.
  document.querySelectorAll<HTMLElement>('.weBldgRotBtn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const dir = btn.dataset.rot === 'ccw' ? -45 : 45;
      if (state.selectedKind === 'building' && state.selectedBuilding >= 0) {
        deps.rotateSelectedBuilding(dir);
      } else {
        state.buildingProps.facingDeg = ((state.buildingProps.facingDeg || 0) + dir) % 360;
        state.statusFlash = { msg: `🏠 next placement facing ${state.buildingProps.facingDeg}° from road`, until: Date.now() + 3000 };
      }
      state.needsRedraw = true;
    });
  });

  // 12. LANE COUNT BUTTONS (v8.99.124.23) — drives draftProps.w + live
  //     draft + mutates selected road's w (row[0]).
  document.querySelectorAll<HTMLElement>('.weLaneBtn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const w = parseInt(btn.dataset.w || '6') || 6;
      state.draftProps.w = w;
      document.querySelectorAll<HTMLElement>('.weLaneBtn').forEach((b) => b.classList.remove('weLaneBtnActive'));
      btn.classList.add('weLaneBtnActive');
      if (state.draft && state.draft.kind === 'road') state.draft.w = w;
      if (state.selectedKind === 'road' && state.selected >= 0) {
        const r = state.overlay[state.selected] as unknown[];
        if (r && Array.isArray(r)) {
          (r as (string | number)[])[0] = w;
          deps.rebuildWorld();
        }
      }
      state.needsRedraw = true;
    });
  });

  // 13. Z 'change' → SELECTED ROAD (v8.99.124.41). Commit-on-blur
  //     propagates Z to the selected overlay row + syncs the Bridge
  //     checkbox (>=2 = bridge). The 'input' handler in step 5 still
  //     drives draft preview via readProps.
  const zElForSelected = document.getElementById('wePropZ') as HTMLInputElement | null;
  if (zElForSelected) {
    zElForSelected.addEventListener('change', () => {
      const zv = Math.max(0, Math.min(10, parseInt(zElForSelected.value) || 0));
      // H991: with a complete SPAN armed, Z applies to just the span —
      // the road splits and the middle piece takes the new z. Works for
      // baseline roads too (promote-to-overlay inside the op).
      const roadSel =
        (state.selectedKind === 'road' && state.selected >= 0) ||
        (state.selectedKind === 'baselineRoad' && state.selectedBaselineRoad >= 0);
      if (state.selectMode === 'span' && roadSel && state.spanA && state.spanB) {
        const applied = deps.spanSetZ(zv);
        if (applied !== null) {
          const brEl = document.getElementById('wePropBridge') as HTMLInputElement | null;
          if (brEl) brEl.checked = applied >= 2;
        }
        return;
      }
      if (state.selectedKind === 'road' && state.selected >= 0) {
        const sr = state.overlay[state.selected] as (string | number)[];
        if (sr && sr[3] !== zv) {
          sr[3] = zv;
          const brEl = document.getElementById('wePropBridge') as HTMLInputElement | null;
          if (brEl) brEl.checked = zv >= 2;
          deps.rebuildWorld();
        }
      }
    });
  }

  // 14. BRIDGE CHECKBOX → Z ONE-WAY (v8.99.124.39). Computes max z of
  //     roads the selected polyline crosses via deps.computeMaxCrossedZ;
  //     sets bridge z = max + 2. Unchecked = z=0; checked-with-no-
  //     crossings = z=2.
  const bridgeEl = document.getElementById('wePropBridge') as HTMLInputElement | null;
  if (bridgeEl) {
    bridgeEl.addEventListener('change', () => {
      const zEl = document.getElementById('wePropZ') as HTMLInputElement | null;
      // H991: with a complete SPAN armed, Bridge applies to just the span
      // (split; middle piece gets maxCrossedZ+2 computed over the SPAN,
      // not the whole road). Baseline roads promote inside the op.
      const spanRoadSel =
        (state.selectedKind === 'road' && state.selected >= 0) ||
        (state.selectedKind === 'baselineRoad' && state.selectedBaselineRoad >= 0);
      if (state.selectMode === 'span' && spanRoadSel && state.spanA && state.spanB) {
        const applied = deps.spanBridge(bridgeEl.checked);
        if (applied !== null && zEl) zEl.value = String(applied);
        if (applied === null) bridgeEl.checked = !bridgeEl.checked; // refused → revert
        return;
      }
      let zv = 0;
      if (bridgeEl.checked) {
        let maxCrossedZ = 0;
        if (state.selectedKind === 'road' && state.selected >= 0) {
          const r = state.overlay[state.selected] as unknown[];
          if (r && Array.isArray(r) && r.length >= 6) {
            const myPts: number[][] = [];
            const ptStart126 = (r.length & 1) === 1 ? 5 : 4;
            for (let i = ptStart126; i < r.length; i += 2) {
              if (typeof r[i] === 'number' && typeof r[i + 1] === 'number') {
                myPts.push([r[i] as number, r[i + 1] as number]);
              }
            }
            if (myPts.length >= 2) {
              maxCrossedZ = deps.computeMaxCrossedZ({ pts: myPts });
            }
          }
        }
        zv = maxCrossedZ + 2;
      }
      if (zEl) zEl.value = String(zv);
      deps.readProps();
      if (state.selectedKind === 'road' && state.selected >= 0) {
        const r = state.overlay[state.selected] as (string | number)[];
        if (r) { r[3] = zv; deps.rebuildWorld(); }
      }
    });
  }

  // Window resize + document keydown are bound window-wide by the
  // host (src/gameLoop.ts installEditorBindings) — not here. Binding
  // both layers would double-fire F9 toggle (on → off in the same key
  // event) and run Escape / Delete / Backspace twice per press.
}
