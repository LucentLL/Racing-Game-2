/**
 * H1037: authored-intersection row schema + codec.
 *
 * An intersection is a single POINT element the World Editor places over an
 * existing auto-detected road crossing, carrying the AUTHORED intent that the
 * engine has no way to express today: a control type, per-approach through-lane
 * counts, and per-approach turn-lane pockets. It is stored as one positional
 * row in state.intersections[] (its own collection, mirroring the parkingLots
 * vertical H693/H695/H699), persisted forward-additively in the v4 overlay.
 *
 *   row = ['isect', control, la0, la1, la2, la3, turnMask, x, y]
 *
 * This module is PURE (no DOM, no state) so the editor, the render decals, and
 * the apply-time crossing merge can all share one encode/decode. Later commits
 * consume ParsedIntersection; this commit only defines + round-trips it.
 *
 * IMPORTANT: `control` is a SEPARATE concept from the editor's merge-bond
 * `mergeType` (whose values happen to include 'Stop'/'Yield' as RAMP geometry).
 * They must never be conflated — hence the distinct INTERSECTION_CONTROL name.
 */

/** Leading tag so an intersection row is self-identifying + never confused
 *  with another collection's rows. */
export const INTERSECTION_TAG = 'isect';

/** Control type, least→most restrictive (MUTCD ladder). */
export type IntersectionControl = 0 | 1 | 2 | 3 | 4;
export const CONTROL_UNCONTROLLED = 0 as const;
export const CONTROL_YIELD = 1 as const;
export const CONTROL_TWO_WAY_STOP = 2 as const;
export const CONTROL_ALL_WAY_STOP = 3 as const;
export const CONTROL_SIGNAL = 4 as const;

/** Display names, indexed by control value. */
export const INTERSECTION_CONTROL_NAMES = [
  'Uncontrolled', 'Yield', 'Two-Way Stop', 'All-Way Stop', 'Signal',
] as const;

/** Max through-lanes per approach the editor exposes. */
export const MAX_APPROACH_LANES = 8;

/** Decoded intersection. Leg order is canonical: [+ang1, -ang1, +ang2, -ang2],
 *  the two approach axes of the resolved crossing (see roadCrossings). */
export interface ParsedIntersection {
  control: IntersectionControl;
  /** Through-lane count 1..8 per leg; 0 = leg absent (tee / 3-way). */
  laneCounts: [number, number, number, number];
  /** Turn-lane bitfield — 2 bits per leg: bit0 = left pocket, bit1 = right. */
  turnMask: number;
  /** Placed marker position, tile coords (snapped to the crossing centre). */
  x: number;
  y: number;
}

function clampLane(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : 0;
  if (n <= 0) return 0;               // 0 = leg absent
  return n > MAX_APPROACH_LANES ? MAX_APPROACH_LANES : n;
}
function clampControl(v: unknown): IntersectionControl {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : CONTROL_SIGNAL;
  return (n < 0 ? 0 : n > 4 ? 4 : n) as IntersectionControl;
}
function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** Encode → positional row for state.intersections[]. */
export function buildIntersectionRow(p: ParsedIntersection): (string | number)[] {
  const la = p.laneCounts;
  return [INTERSECTION_TAG, p.control, la[0], la[1], la[2], la[3], p.turnMask & 0xff, p.x, p.y];
}

/** Decode a stored row. Returns null if the row isn't a well-formed
 *  intersection (wrong tag / too short) so callers can skip it defensively. */
export function parseIntersectionRow(row: unknown): ParsedIntersection | null {
  if (!Array.isArray(row) || row.length < 9) return null;
  if (row[0] !== INTERSECTION_TAG) return null;
  return {
    control: clampControl(row[1]),
    laneCounts: [clampLane(row[2]), clampLane(row[3]), clampLane(row[4]), clampLane(row[5])],
    turnMask: num(row[6]) & 0xff,
    x: num(row[7]),
    y: num(row[8]),
  };
}

// --- turn-lane bitfield helpers (2 bits/leg: bit0 left, bit1 right) ---
export function legHasLeftTurn(turnMask: number, leg: number): boolean {
  return ((turnMask >> (leg * 2)) & 1) === 1;
}
export function legHasRightTurn(turnMask: number, leg: number): boolean {
  return ((turnMask >> (leg * 2 + 1)) & 1) === 1;
}
export function setLegTurn(turnMask: number, leg: number, left: boolean, right: boolean): number {
  let m = turnMask & ~(0b11 << (leg * 2));
  if (left) m |= 1 << (leg * 2);
  if (right) m |= 1 << (leg * 2 + 1);
  return m & 0xff;
}
