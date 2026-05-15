/**
 * World Editor — canvas pointer input (mouse + wheel + touch).
 *
 * The editor canvas owns its own input loop, separate from the game's
 * touch surface. PC handlers (`_weCanvasMouseDown/Move/Up/Wheel/ContextMenu`)
 * and mobile handlers (`_weTouchStart/Move/End`) are wired by
 * editor/ui.ts. The touch-end handler synthesizes a fake mouse-down
 * event and re-invokes _weCanvasMouseDown so the place/draft logic
 * lives in exactly one path — PC pointer flow IS the canonical pointer
 * flow.
 *
 * MOUSE BUTTON SEMANTICS:
 *
 *   button 0 (left)   — place / select / vertex-grab (depends on tool)
 *   button 1 (middle) — pan (drag-to-scroll)
 *   button 2 (right)  — commit active draft (right-click finalizes,
 *                       matching the standard CAD/GIS convention)
 *
 * ANGLE-REF PICK MODE (v8.99.126.41): when angleRefMode is on, the
 * first canvas tap consumes the click, detects the nearest road's
 * signed direction at that point, stores it as the reference vector,
 * resets the mode, and populates the wePropAngle input with the
 * SELECTED road's CURRENT angle relative to this reference (snapped to
 * 5°). This way, picking a reference doesn't visually rotate the
 * selected road on its own — the user can adjust the input afterward
 * to rotate.
 *
 * TOOL-AWARE SNAP DISPATCH: snap only applies to road and river
 * placement (where polylines may need to connect end-to-end). Surfaces,
 * lakes, and buildings just place at the raw click position.
 *
 *  - tool === 'place'  → _weFindSnap (roads)
 *  - tool === 'river'  → _weFindRiverSnap (rivers only)  [v8.99.124.28]
 *
 * RIVER-SNAP IS SEPARATE FROM ROAD-SNAP so river polylines naturally
 * connect to each other while staying logically distinct from the
 * road network. River drafts use the SNAPPED (px,py) when pushing
 * points so consecutive river polylines connect cleanly.
 *
 * HOVER-TILE MOBILE FIX (v8.99.124.26): on mobile, mousemove never
 * fires (touchstart preventDefault suppresses synthetic mouse events)
 * so hoverTile stays at its initial {tx:0, ty:0} default forever. The
 * draft preview renderer uses hoverTile as the live cursor anchor —
 * for surface/building drafts the preview polygon balloons into a
 * giant triangle reaching world (0,0). MouseDown now anchors hoverTile
 * to the just-placed point so all preview-edge cases collapse to zero
 * length (invisible) until the next tap. Harmless on PC where
 * mousemove already keeps it in sync.
 *
 * ZOOM-AROUND-CURSOR (`_weCanvasWheel`, pinch): keeps the tile under
 * the cursor stationary while zooming. Algorithm: read tile under
 * cursor before zoom change → apply zoom → read tile under cursor
 * after → add the delta to view.cx/cy so the difference is zero.
 * Factor 1.18 per wheel notch; zoom clamped to [0.02, 50].
 *
 * TOUCH TAP-VS-PAN DISCRIMINATOR: single-touch tap if total
 * displacement < 10 px AND duration < 600 ms; otherwise pan. Two-touch
 * always triggers pinch (zoom around midpoint) + drag (translate by
 * midpoint motion).
 *
 * Ported from monolith L15850-16378.
 *
 * SCAFFOLD status: type contract + entry points stubbed with TODO line refs.
 */

import type { WorldEditorState } from './index';
import type { TilePoint } from './stamp';
import type { SnapResult } from './snap';

/** Host bindings for input handlers. */
export interface InputDeps {
  getCanvas(): HTMLCanvasElement | null;
  /** Screen-pixel → tile coord via the current view. */
  screenToTile(sx: number, sy: number): { tx: number; ty: number };
  /** Snap dispatch — input doesn't know about the snap algorithm. */
  findSnap(tx: number, ty: number): SnapResult | null;
  findRiverSnap(tx: number, ty: number): SnapResult | null;
  /** Begin/commit/cancel — input calls into draft.ts to manage state. */
  beginDraft(kind: 'road' | 'surface' | 'building' | 'river' | 'lake'): void;
  commitDraft(): void;
  /** Angle-ref pick (v8.99.126.41). Returns the reference direction or null. */
  detectAngleRefDirection(tx: number, ty: number): { direction: [number, number] } | null;
  /** Computes the current relative angle for the wePropAngle input. */
  currentRelativeAngleDeg(): number;
  /** DOM lookup for the angle input (so input.ts doesn't directly
   *  manipulate ui.ts state). */
  getAngleInputEl(): HTMLInputElement | null;
}

/** Pan-in-progress snapshot. Captures the start screen position +
 *  start camera position so the move handler can compute camera deltas
 *  from absolute screen positions (more numerically stable than
 *  accumulating relative deltas). */
export interface PanState {
  sx: number;
  sy: number;
  scx: number;
  scy: number;
}

/** Pinch-in-progress snapshot. */
export interface PinchState {
  d0: number;
  zoom0: number;
  lastMx: number;
  lastMy: number;
}

/** Single-touch tap-or-pan snapshot. */
export interface TouchTapState {
  sx: number;
  sy: number;
  /** Initial screen pos — the moved-threshold is measured against this,
   *  not against the rolling sx/sy. */
  ssx: number;
  ssy: number;
  t0: number;
  moved: boolean;
}

/** Tap-vs-pan thresholds. */
export const TOUCH_TAP_MAX_MOVE_PX = 10;
export const TOUCH_TAP_MAX_DURATION_MS = 600;

/** Wheel-zoom factor per notch. e.deltaY<0 → multiply, >0 → divide. */
export const WHEEL_ZOOM_FACTOR = 1.18;

/** Zoom clamp range. */
export const ZOOM_MIN = 0.02;
export const ZOOM_MAX = 50;

/** Mouse-down handler. Branches on button + tool + draft state.
 *  TODO(E36-followup): port from L15850-16261. */
export function _weCanvasMouseDown(
  _e: MouseEvent,
  _state: WorldEditorState,
  _deps: InputDeps,
): void {
  // TODO: L15850-16261.
  //   1. button===1 → start pan; return.
  //   2. button===2 → commitDraft if draft; return.
  //   3. screenToTile click.
  //   4. angleRefMode → detectAngleRefDirection, populate angle input,
  //      reset mode; return.
  //   5. snap = tool==='place' ? findSnap : tool==='river' ? findRiverSnap : null.
  //   6. Set hoverTile to (snap?.tx ?? tx, snap?.ty ?? ty)  // v8.99.124.26
  //   7. Tool branch:
  //        place    → beginDraft('road') if not road, push (px,py)
  //        surface  → beginDraft('surface') if not surface, push (tx,ty)
  //        building → beginDraft('building') if not building, push (tx,ty)
  //        river    → beginDraft('river') if not river, push (px,py)  // snapped
  //        lake     → beginDraft('lake') if not lake, push (tx,ty)
  //        select   → run global pick per selectMode (Whole / Section / Point),
  //                   update selectedKind + selected* + activeVertex.
  //   8. needsRedraw = true.
}

/** Mouse-move handler. Pan tick if pan-in-progress, else update
 *  hoverTile + hoverSnap. v8.99.124.28: hoverSnap routes by tool.
 *  TODO(E36-followup): port from L16262-16283. */
export function _weCanvasMouseMove(
  _e: MouseEvent,
  _state: WorldEditorState,
  _deps: InputDeps,
): void {
  // TODO: L16262-16283.
  //   if (state.pan): view.cx = pan.scx - dx/zoom; cy = scy - dy/zoom.
  //   else: hoverTile = screenToTile(sx, sy); hoverSnap = tool==='place'
  //         ? findSnap : tool==='river' ? findRiverSnap : null.
}

/** Mouse-up handler. Clears pan state. TODO(E36-followup): port from
 *  L16284-16286. */
export function _weCanvasMouseUp(
  _e: MouseEvent,
  _state: WorldEditorState,
): void {
  // TODO: L16284-16286. if(state.pan) state.pan = null.
}

/** Wheel handler. Zoom-around-cursor with WHEEL_ZOOM_FACTOR.
 *  TODO(E36-followup): port from L16287-16300. */
export function _weCanvasWheel(
  _e: WheelEvent,
  _state: WorldEditorState,
  _deps: InputDeps,
): void {
  // TODO: L16287-16300.
  //   Capture tile under cursor, multiply zoom by factor, clamp,
  //   capture tile under cursor again, add delta to cx/cy so the tile
  //   stays under the cursor.
}

/** Context-menu suppressor — keeps right-click from showing the
 *  browser menu so it can be used for commit. */
export function _weCanvasContextMenu(e: MouseEvent): void {
  e.preventDefault();
}

/** Touch-start handler. Single-touch starts a tap-or-pan tracker;
 *  two-touch starts a pinch. TODO(E36-followup): port from L16302-16320. */
export function _weTouchStart(
  _e: TouchEvent,
  _state: WorldEditorState,
  _deps: InputDeps,
): void {
  // TODO: L16302-16320. Single-touch: stash {sx, sy, ssx, ssy, t0, moved:false}.
  // Two-touch: stash {d0, zoom0, lastMx, lastMy}.
}

/** Touch-move handler. Pan via single-touch displacement once moved
 *  threshold is crossed; pinch-zoom-around-midpoint + midpoint drag
 *  on two-touch. TODO(E36-followup): port from L16321-16361. */
export function _weTouchMove(
  _e: TouchEvent,
  _state: WorldEditorState,
  _deps: InputDeps,
): void {
  // TODO: L16321-16361.
  //   Single-touch: if hypot(totalDx, totalDy) > TOUCH_TAP_MAX_MOVE_PX
  //   set moved=true. When moved, view.cx -= dx/zoom; cy -= dy/zoom.
  //   Two-touch: zoom = zoom0 * (d/d0), clamped. Keep tile under
  //   midpoint stationary, then add midpoint motion as a pan.
}

/** Touch-end handler. If single-touch was a tap (not moved, < 600ms),
 *  synthesize a mouse-down event and re-invoke _weCanvasMouseDown so
 *  the place/select logic lives in one path. TODO(E36-followup): port
 *  from L16362-16377. */
export function _weTouchEnd(
  _e: TouchEvent,
  _state: WorldEditorState,
  _deps: InputDeps,
): void {
  // TODO: L16362-16377.
  //   if (touchTap && !touchTap.moved && (Date.now()-t0) < TOUCH_TAP_MAX_DURATION_MS):
  //     build fakeEv {button:0, clientX:ssx+rect.left, clientY:ssy+rect.top,
  //     preventDefault:()=>{}}; _weCanvasMouseDown(fakeEv, ...).
  //   Clear touchTap / pinch based on remaining touches.
}

/** Re-export so callers can import the click projection type from
 *  one place. */
export type { TilePoint };
