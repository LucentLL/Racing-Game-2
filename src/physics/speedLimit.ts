/**
 * v8.24 current-road speed limit lookup. Reads the nearest cached
 * road from the per-frame `_neRoad` slot and returns the mph posted
 * limit for that road. Used by:
 *
 *   - Cruise control cap (see applyCruiseSpeedCap).
 *   - HUD speed-warning indicator (10+ over → red).
 *   - Cop-pursuit trigger (10+ over → fires pursuit when in range).
 *
 * Defaults to 45 mph (city) when no road is in range, matching the
 * monolith's `let _csl = 45` initializer.
 *
 * Pure function — takes the road snapshot + the squared distance
 * from the cache as parameters, returns the mph limit. No state
 * mutation; caller assigns the result to its `currentSpeedLimit`
 * global.
 *
 * Monolith source: inside update() at L23962-L23983.
 */

/** Minimum subset of a baseline road's fields the limit lookup
 *  reads. Other code-paths carry more fields; the limit lookup
 *  needs only width, name, and major-flag. */
export interface SpeedLimitRoad {
  /** Width in tiles. The proximity gate multiplies w by 2.5 to
   *  decide whether the player is "on" this road — wider roads
   *  have larger proximity zones. */
  w?: number;
  /** Road name. Branch keys: 'I-85', 'I-77', 'I-485', 'I-277',
   *  'I-*' prefix, 'US-*' prefix, 'Brookshire*' / 'Independence*'
   *  prefix, 'Ramp*' / 'Exit*' prefix. Other names fall through
   *  to the maj/minor split. */
  name?: string;
  /** Major-road flag (1 = highway-class arterial). Falls through
   *  here when the named branches don't match. */
  maj?: number | boolean;
}

/** Default speed limit when no road is in range. Matches monolith
 *  `let _csl = 45` at L23965 — city-default 45 mph. */
export const DEFAULT_SPEED_LIMIT_MPH = 45;

/** Per-frame nearest-road cache shape. The full update() loop also
 *  maintains `_neMajRoad` (highways + ramps) and `_neRoad` (any road
 *  including arterials) separately so onRoad detection can fall
 *  through. The speed limit lookup specifically reads `_neRoad`
 *  (any road) because arterials are interesting for posted limits
 *  too. */
export interface NearestRoadCache {
  /** The road object, or null when none cached. */
  road: SpeedLimitRoad | null;
  /** Squared perpendicular distance (tile²) from the player to
   *  the road's nearest segment. */
  dist2: number;
}

/** Lookup the posted mph speed limit for the player's current
 *  position. Returns DEFAULT_SPEED_LIMIT_MPH (45 mph) when no road
 *  is cached or the player is outside the per-road proximity zone.
 *
 *  PROXIMITY GATE: the player must be within `(road.w * 2.5)` tiles
 *  of the cached road's polyline for the lookup to fire (the cache
 *  may carry the nearest road even when the player is far from it).
 *  Comparison is done in squared-distance to avoid the sqrt; the
 *  bound is `(road.w * 2.5)²`. Roads default w=1 when missing,
 *  giving a 2.5-tile bubble.
 *
 *  NAME BRANCH (longest-prefix first, then fallthrough):
 *
 *    I-85             → 70  (interstate, posted faster)
 *    I-77             → 65
 *    I-485            → 70  (Charlotte outer loop, posted 70 in most segments)
 *    I-277            → 55  (Charlotte inner loop, 55-mph zone)
 *    I-* (other)      → 65  (default interstate)
 *    US-*             → 55  (US highways — 1-tier slower than interstates)
 *    Brookshire*      → 45  (Charlotte arterial)
 *    Independence*    → 45  (Charlotte arterial)
 *    Ramp* / Exit*    → 35  (ramps posted slowest)
 *    else major       → 45
 *    else minor       → 35  (residential/local)
 *
 *  Branch order matters — `startsWith('I-')` fires for I-* names
 *  that didn't hit a specific case earlier; `startsWith('Ramp')`
 *  catches arterial-named ramps before the major/minor fallthrough.
 *
 *  Ported 1:1 from monolith L23962-L23983.
 */
export function lookupCurrentSpeedLimit(cache: NearestRoadCache): number {
  let csl = DEFAULT_SPEED_LIMIT_MPH;
  const road = cache.road;
  if (!road) return csl;
  const w = road.w || 1;
  const cmw = w * 2.5;
  if (cache.dist2 > cmw * cmw) return csl;
  const name = road.name || '';
  if (name === 'I-85') csl = 70;
  else if (name === 'I-77') csl = 65;
  else if (name === 'I-485') csl = 70;
  else if (name === 'I-277') csl = 55;
  else if (name.startsWith('I-')) csl = 65;
  else if (name.startsWith('US-')) csl = 55;
  else if (name.startsWith('Brookshire') || name.startsWith('Independence')) csl = 45;
  else if (name.startsWith('Ramp') || name.startsWith('Exit')) csl = 35;
  else if (road.maj) csl = 45;
  else csl = 35;
  return csl;
}
