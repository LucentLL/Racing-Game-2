/**
 * World Editor — bootstrap, lifecycle, and WORLD_EDITOR state container.
 *
 * The editor is a 7,500-line F9-toggled overlay that lets the user draw
 * roads, surfaces, buildings, rivers, and lakes on top of the source-
 * defined map. Output persists to localStorage (`driverCity_worldEditor_v4`)
 * and to a separate baseline-edits key (`driverCity_baselineEdits_v1`) so
 * a corrupted overlay save cannot take baseline vertex edits down with it.
 *
 * DEV-GATED IN PRODUCTION (per migration-decisions memo, locked-in
 * 2026-05-13): the entire editor surface — entry button, F9 key binding,
 * touch tap-to-enter — is gated behind LIFE.devToolsEnabled (default
 * false; exposed via Options → Advanced). Store-cert reviewers and
 * screenshot capture do not see the editor unless the user opts in. The
 * gate is part of THIS extraction, not a follow-up — building the gate
 * later would have re-litigated a decision the user already locked.
 *
 * Ported from monolith L9754 (WORLD_EDITOR ctor object) + L13158-13193
 * (lifecycle: _weTick, _weToggle, _weExit, _weResizeCanvas).
 *
 * SCAFFOLD status: type contract + entry points stubbed with TODO line refs.
 */

/** Editor tool mode. Drives what a tap on the canvas does. */
export type EditorTool =
  | 'place'      // road draft
  | 'surface'    // surface polygon draft
  | 'building'   // building polygon draft
  | 'river'      // river polyline draft
  | 'lake'       // lake polygon draft
  | 'select';    // select existing item

/** Select sub-mode (v8.99.126.47). Determines pick granularity. */
export type SelectMode = 'whole' | 'section' | 'point';

/** Selectable item kind. */
export type SelectedKind =
  | 'road'          // overlay road
  | 'baselineRoad'  // permanent (source-defined) road — v8.99.126.46
  | 'surface'
  | 'building'
  | 'river'
  | 'lake'
  | null;

/** Draft kind in flight. */
export type DraftKind = 'road' | 'surface' | 'building' | 'river' | 'lake';

/** Draft-in-progress shape (kind discriminator + per-kind fields). */
export interface EditorDraft {
  kind: DraftKind;
  pts: number[][];
  // Road-only fields (carry copies of draftProps so user can change
  // settings mid-draft without retroactively mutating the in-flight road).
  w?: number;
  maj?: number;
  name?: string;
  z?: number;
  arc?: boolean;
  curve?: number;
  merge?: boolean;
  mergeAlign?: number;
  mergeType?: number;
  material?: 'asphalt' | 'concrete';
  age?: 'new' | 'old' | 'auto';
}

/** Draft road default props (v8.99.126.50: material+age decoupled from class). */
export interface DraftRoadProps {
  w: number;
  maj: number;
  name: string;
  z: number;
  arc: boolean;
  curve: number;
  merge: boolean;
  mergeAlign: number;
  mergeType: number;
  /** v8.99.126.50: orthogonal surface color, NOT tied to class. */
  material: 'asphalt' | 'concrete';
  /** v8.99.126.50: 'auto' = hash-per-road (the v8.99.126.49 behavior). */
  age: 'new' | 'old' | 'auto';
}

/** Camera/view state for the editor canvas. */
export interface EditorView {
  cx: number;
  cy: number;
  zoom: number;
}

/** The big WORLD_EDITOR state object. Mirrors monolith L9754-9853 verbatim.
 *  Every field below carries a localStorage-roundtrip or pick-loop contract
 *  that game code outside the editor relies on (see field comments). */
export interface WorldEditorState {
  active: boolean;

  // Drawn content (row arrays — flat number[][] for backward-compat with
  // pre-v126 readers that expected a positional layout).
  overlay: unknown[];     // road rows (Phase 1 _rp format)
  surfaces: unknown[];    // surface polygon rows: [name, z, x1, y1, ...]
  buildings: unknown[];   // building polygon rows: [name, type, x1, y1, ...]
  rivers: unknown[];      // v8.99.124.28: river polyline rows: [w, name, x1, y1, ...]
  lakes: unknown[];       // v8.99.124.28: lake polygon rows: [name, x1, y1, ...]

  view: EditorView;
  draft: EditorDraft | null;

  draftProps: DraftRoadProps;
  surfaceProps: { name: string; z: number };
  buildingProps: { name: string; type: string; autoDriveway: boolean };
  riverProps: { w: number; name: string };
  lakeProps: { name: string };

  hoverSnap: unknown | null;
  hoverTile: { tx: number; ty: number };

  // Selection state — indices into the respective row arrays.
  selected: number;            // overlay road idx when selectedKind==='road'
  selectedSurface: number;
  selectedBuilding: number;
  selectedRiver: number;
  selectedLake: number;
  /** v8.99.126.46: baseline (permanent) road vertex editing. */
  selectedBaselineRoad: number;
  /** v8.99.126.47: which segment between v[i] and v[i+1] is picked when
   *  selectMode==='section'. -1 when none. */
  selectedSegmentIdx: number;
  selectMode: SelectMode;
  selectedKind: SelectedKind;

  /** v8.99.126.46: per-baseline-road vertex overrides. Map of {[roadIdx]:
   *  full edited pts array}. Persisted to WE_BASELINE_EDITS_KEY. */
  baselineEdits: Record<string, number[][]>;
  /** v8.99.126.47: indices of baseline roads marked deleted. Their slot
   *  is preserved with empty pts so pick-loop indexing stays stable. */
  baselineDeletes: number[];

  /** v8.99.124.34: vertex-edit mode. >=0 means that vertex of the
   *  currently selected item is "active" — next empty-space tap relocates
   *  it. Cleared on tool switch / selection change. */
  activeVertex: number;

  pan: unknown | null;
  pinch: unknown | null;
  tool: EditorTool;
  needsRedraw: boolean;

  /** v8.99.126.02: game-render parity toggle. When true, road render pass
   *  uses the full game pipeline (asphalt color, edge stripes, lane
   *  dividers, bridge concrete, chevrons) instead of the simple
   *  width-band + centerline view. Default true. */
  gameRender: boolean;

  /** v8.99.126.41: angle-relative-to-reference. When user clicks 📐 Ref
   *  with a road selected, the next canvas tap runs bond detection; if
   *  it hits a lane, that lane's signed direction-of-travel becomes the
   *  reference, and the Angle input rotates the selected road's chord
   *  (v0→v_last) by (ref_angle + user_angle) around its centroid. */
  angleRefMode: boolean;
  angleRefDirection: [number, number] | null;

  _touchTap: unknown | null;

  // v8.99.126.50 sidecars — per-row {material, age} for overlay roads and
  // per-segment overrides. Keyed by row index. Survives reload via the
  // additive fields in WE_STORAGE_KEY's payload (see editor/storage.ts).
  overlayRoadProps?: Record<string, { material?: string; age?: string }>;
  overlayMaterialOverrides?: Record<string, Array<{ seg: number; material?: string; age?: string }>>;
  baselineRoadProps?: Record<string, { material?: string; age?: string }>;
  baselineMaterialOverrides?: Record<string, Array<{ seg: number; material?: string; age?: string }>>;
}

/** Dev-gate contract — read from LIFE on every editor entry point.
 *  When false, the editor entry button is hidden, F9 binding is a no-op,
 *  and tap-to-enter on the entry button is ignored. Exposed via Options →
 *  Advanced. Defaults to false in production.
 *
 *  This shape is intentionally minimal — the gate has no fields beyond the
 *  enable flag. Anything richer (per-tool gates, etc.) is over-scoped for
 *  the cert-review use case the gate exists to solve. */
export interface DevGate {
  /** Master flag. Default false. Persisted to the save (LIFE) so users
   *  who enable it once stay opted-in across sessions. */
  devToolsEnabled: boolean;
}

/** Dependencies the lifecycle entry points need from the host. */
export interface EditorLifecycleDeps {
  /** Read the dev gate. Called on every public entry to the editor.
   *  Return false to short-circuit (button hidden, F9 no-op). */
  isDevToolsEnabled(): boolean;
  /** The editor's own canvas element (DOM-side; #weCanvas). */
  getCanvas(): HTMLCanvasElement | null;
  /** The editor's overlay element (DOM-side; #weOverlay). */
  getOverlay(): HTMLElement | null;
  /** Native confirm shim. Exit shows a discard prompt if a draft is in
   *  flight; tests + headless contexts override to a stub. */
  confirm(msg: string): boolean;
  /** Schedules the next _weRender pass. Called whenever state changes
   *  that affect rendering. */
  scheduleRedraw(state: WorldEditorState): void;
}

/** Per-frame tick: re-renders the editor if anything dirtied state.
 *  TODO(E33-followup): port from L13158-13164. Body is 4 lines —
 *  scaffold exists so the module exports the entry surface now. */
export function _weTick(_state: WorldEditorState, _deps: EditorLifecycleDeps): void {
  // TODO: L13158-13164. if needsRedraw: _weRender(); _weUpdateStatus(); clear flag.
}

/** Toggle the editor on/off. F9 binding entry. Dev-gated — when the gate
 *  is off this is a no-op (and the F9 listener should not be installed in
 *  the first place; this guard is defense-in-depth).
 *  TODO(E33-followup): port from L13165-13173. */
export function _weToggle(_state: WorldEditorState, _deps: EditorLifecycleDeps): void {
  // TODO: L13165-13173. if (!deps.isDevToolsEnabled()) return;
  // flip active, toggle overlay display, on entry _weResizeCanvas + needsRedraw=true.
}

/** Exit the editor cleanly. Prompts to discard if a draft is in flight.
 *  TODO(E33-followup): port from L13174-13187. */
export function _weExit(_state: WorldEditorState, _deps: EditorLifecycleDeps): void {
  // TODO: L13174-13187. confirm-discard wording: 'Discard unfinished
  // '+(draft.kind === 'surface' ? 'surface polygon' : draft.kind === 'building'
  // ? 'building' : 'road')+'?'. Also hide #weExportArea on exit.
}

/** Resize the editor canvas to fill the window. Called on toggle-in and
 *  on window resize. TODO(E33-followup): port from L13188-13193. */
export function _weResizeCanvas(_state: WorldEditorState, _deps: EditorLifecycleDeps): void {
  // TODO: L13188-13193. c.width = innerWidth; c.height = innerHeight; needsRedraw=true.
}

/** Factory for the default WORLD_EDITOR state. Mirrors L9754-9853.
 *  TODO(E33-followup): port the full default-value body. */
export function createWorldEditorState(): WorldEditorState {
  // TODO: L9754-9853. Defaults: tool='place', selectMode='whole',
  // gameRender=true, view={cx:1200,cy:1200,zoom:0.4}, draftProps as
  // documented in DraftRoadProps. All selection indices -1, selectedKind null.
  throw new Error('createWorldEditorState scaffold — body TODO E33-followup');
}
