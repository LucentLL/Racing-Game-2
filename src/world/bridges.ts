/**
 * Bridge geometry — z-level transitions, deck masks, ramp climbs, structure
 * registry, deck-exclusion clip for headlight cones.
 *
 * Ported from monolith L28291-29368 (~1080 lines). Includes the helpers
 * that render-side modules already inject as deps:
 *   - _bridgePunchDeckFromMask (used by render/headlightShadows Pass A/B)
 *   - _bridgeApplyDeckExclusionClip (used by traffic cones + rim light)
 *
 * SCAFFOLD status: type contract + key entries; bodies stubbed.
 */

/** A bridge structure (one upper deck spanning a lower road). */
export interface BridgeStructure {
  /** Stable id. */
  id: string;
  /** Center of the deck in world pixels. */
  cx: number;
  cy: number;
  /** Deck half-extent in world pixels. */
  upperHalfW: number;
  deckHalfL: number;
  /** Deck polygon corners (world pixels). */
  deck: ReadonlyArray<readonly [number, number]>;
  /** Names of the upper + lower roads this structure connects. */
  upperRoadName: string;
  lowerRoadName?: string;
  /** Approach ramps — climb fraction maps. */
  rampNorth?: BridgeRamp;
  rampSouth?: BridgeRamp;
}

export interface BridgeRamp {
  /** Start (lower) end in world pixels. */
  startX: number;
  startY: number;
  /** End (upper) end in world pixels. */
  endX: number;
  endY: number;
  /** Ramp climb function — returns [0..1] given a point along the ramp. */
  length: number;
}

/** True if the point is inside any bridge-deck polygon. Used by the
 *  physics layer to decide z-level + collision. */
export function pointInBridgeDeck(
  _x: number,
  _y: number,
  _structures: ReadonlyArray<BridgeStructure>,
): BridgeStructure | null {
  // TODO(C24-followup): port _bridgePointInPoly + structure scan.
  return null;
}

/** Returns the z-level (0 = ground, 2+ = elevated) of a vehicle at
 *  (cx, cy, angle, layer). Used by the camera + render z-order. */
export function bridgeUpdateLayer(
  _oldX: number,
  _oldY: number,
  _newX: number,
  _newY: number,
  _structures: ReadonlyArray<BridgeStructure>,
): number {
  // TODO(C24-followup): port from L28495.
  return 0;
}

/** Punches the bridge deck polygons out of the headlight mask canvas so
 *  cones don't paint upward onto a bridge the player drives under. */
export function bridgePunchDeckFromMask(
  _mctx: CanvasRenderingContext2D,
  _structures: ReadonlyArray<BridgeStructure>,
): void {
  // TODO(C24-followup): port from L28584.
}

/** Clips the active canvas to EXCLUDE bridge decks the player is under. */
export function bridgeApplyDeckExclusionClip(
  _ctx: CanvasRenderingContext2D,
  _structures: ReadonlyArray<BridgeStructure>,
): void {
  // TODO(C24-followup): port from L28620.
}

/** Renders bridge structures (concrete piers, deck top, guardrails) at
 *  the appropriate z-pass — 'before' the player car (under-bridge clip)
 *  or after (post-PASS-2 rail overlay). */
export function bridgeRender(
  _ctx: CanvasRenderingContext2D,
  _phase: 'before' | 'after',
  _structures: ReadonlyArray<BridgeStructure>,
): void {
  // TODO(C24-followup): port from L29279.
}
