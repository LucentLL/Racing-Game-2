/**
 * H1010: multi-map registry (Phase 1 foundation).
 *
 * A "map" is a swappable world that occupies the SAME fixed 2500x2500 tile
 * grid (MAP_W/MAP_H/TILE stay constant everywhere — this deliberately
 * sidesteps a coordinate refactor). Each map supplies a MapSource — the
 * baseline roads/water + editor overlay + baseline edits that
 * buildBaselineMap / rebuildRenderEntries consume — plus a spawn.
 *
 *   - 'city'      = the real Charlotte world: BASELINE_ROADS + water + the
 *                   editor overlay from localStorage (unchanged path).
 *   - 'dragstrip' = blank grass + a single straight programmatic road, for
 *                   testing straight-line racing while the city is built.
 *   - 'circle'    = blank grass + a programmatic oval loop, for lap tests.
 *
 * Test maps are PROGRAMMATIC base overlays so they reuse the entire existing
 * road/render pipeline with zero new stamping code. H1277: each non-city map
 * ALSO merges a per-map user overlay from localStorage at source() time, so
 * every map is editor-editable — the editor draws the programmatic base as a
 * read-only reference layer and persists the user's additions per map (see
 * withUserOverlay / getMapBaseOverlay below).
 */
import { BASELINE_ROADS, type BaselineRoadRow } from '@/config/world/baselineRoads';
import { BASELINE_RIVERS, BASELINE_LAKES } from '@/config/world/baselineWater';
import { TILE, WPX_PER_M } from '@/config/world/tiles';
import { REAL_TRACKS } from '@/config/world/realTracks';
import { TOUGE_ROADS } from '@/config/world/realTouge';
import {
  OSM_CLT_ROWS, OSM_CLT_INTERSECTIONS, OSM_CLT_PROPS,
  OSM_CLT_RAMP_ROWS, OSM_CLT_RAMP_PROPS,
  OSM_CLT_SPAWN_TILE, OSM_CLT_SPAWN_ANGLE,
} from '@/config/world/osmCharlotte';
import {
  _weLoadOverlayFromStorage,
  _weLoadBaselineEdits,
  type OverlayPayload,
  type BaselineEditsPayload,
} from '@/editor/storage';

/** Everything buildBaselineMap + rebuildRenderEntries need to build a map. */
export interface MapSource {
  baselineRoads: readonly BaselineRoadRow[];
  baselineRivers: readonly unknown[];
  baselineLakes: readonly unknown[];
  overlay: OverlayPayload;
  baselineEdits: BaselineEditsPayload;
  /** OSM-C: per-BASELINE-row sidecar props (keyed by baselineRoads index).
   *  Bare rows have no slot for oneway/maxspeed/lanes, and the only baseline
   *  sidecar channel before this was baselineEdits.roadProps — the USER-edit
   *  store, wrong place for shipped map data. Optional: absent everywhere but
   *  imported maps (charlotte-osm). Separate keyspace from overlay.roadProps
   *  (which withUserOverlay re-keys past the base rows — never merge them). */
  baselineRoadProps?: Record<string, {
    oneway?: boolean; maxspeed?: number; lanes?: number; class?: string;
  }>;
}

/** H1014: auto-start timed-run spec for a test track. */
export interface TrackRaceSpec {
  kind: 'drag' | 'lap' | 'sprint';
  /** Staging / start-finish zone center (tile) + radius (tiles). Drive in
   *  slowly to arm the countdown; on 'lap' the player re-crosses it each lap.
   *  On 'sprint' this is the SUMMIT start line — the clock starts when you
   *  leave it. */
  startTile: readonly [number, number];
  startRadius: number;
  /** H1087 (sprint/touge): the FINISH-line zone at the base of the descent —
   *  a point-to-point downhill run stops the clock on reaching it. */
  finishTile?: readonly [number, number];
  finishRadius?: number;
  /** Drag: run distance in metres (finish when the player has travelled this
   *  far from the launch point). Ignored for 'lap'. */
  meters?: number;
  /** Lap: number of laps to complete. Ignored for 'drag'. */
  laps?: number;
  /** Lap: ellipse geometry (tile coords) so the AI opponent can follow the
   *  loop. Center + radii; theta 0 = the rightmost point (the start line). */
  ovalCenter?: readonly [number, number];
  ovalRx?: number;
  ovalRy?: number;
  /** H1034: whether driving slowly into the startTile zone auto-arms a race
   *  against a RANDOM rival (the drag/oval tracks). Defaults true. The car
   *  meet sets false — there you race by CHALLENGING a specific parked car,
   *  so the staging zone must NOT auto-arm a ghost opponent. */
  autoStage?: boolean;
  /** H1086: a pure SOLO best-lap timer (the real circuits). No opponent, no
   *  countdown, no daily cap, never "done" — the clock runs from spawn and
   *  each start-line re-cross records a lap + updates the best. For DRIVING to
   *  test car handling with realistic lap times. */
  solo?: boolean;
}

export interface MapDef {
  id: string;
  name: string;
  /** Player spawn tile (x, y) + heading (radians) on this map. */
  spawnTile: readonly [number, number];
  spawnAngle: number;
  /** Whether NPC traffic spawns on this map. Defaults to true; the test
   *  tracks set false so racing lines stay clean. */
  traffic?: boolean;
  /** H1031: render this map as permanent NIGHT (the drag strip + oval are
   *  night venues) regardless of the slot-based clock. This is a render-time
   *  override only — consumed by an effective time-of-day at the three
   *  gameLoop light/tint sites; the persistent clock (day counter, bills,
   *  sleep slots) is never mutated, so returning to the city restores the
   *  real time of day automatically. */
  forceNight?: boolean;
  /** H1088: driving off the drivable surface is FATAL — the car falls off a
   *  canyon and the run ends (the touge passes). Off-road on a normal map is
   *  just a speed penalty; this makes the edges cliffs. */
  offTrackFatal?: boolean;
  /** H1014: auto-start timed run for a test track (undefined on the city). */
  race?: TrackRaceSpec;
  /** H1086: race-picker presentation (defaults derive from name if absent). */
  menuLabel?: string;
  menuSub?: string;
  /** H1086: true = a selectable race venue in the Home RACE picker. The city
   *  is excluded; test tracks + real circuits opt in. */
  inRacePicker?: boolean;
  /** H1243: where a track-day arrival is posed — the mouth of pit garage 1.
   *  Only the circuits have a paddock; undefined elsewhere. */
  pitTile?: readonly [number, number];
  pitAngle?: number;
  /** Freshly built each call (the city variant re-reads localStorage). */
  source(): MapSource;
}

function emptyOverlay(roads: unknown[]): OverlayPayload {
  return {
    roads,
    surfaces: [], buildings: [], rivers: [], lakes: [], parkingLots: [],
    roadProps: {}, materialOverrides: {},
  };
}

// ---------------------------------------------------------------------------
// H1277: EDITOR-EDITABLE TRACK MAPS.
//
// Every non-city map used to be purely programmatic ("not editor-editable
// yet", per the header). Now each one is programmatic BASE + the user's own
// per-map overlay from localStorage (see editor/storage overlayKeyForMap),
// merged fresh on every source() call — same live-read contract as the city.
// The base is also exported un-merged (getMapBaseOverlay) because the editor
// renders it as a read-only reference layer: the user draws AGAINST the track,
// never edits it, so persisting a copy of it would double the geometry.
// ---------------------------------------------------------------------------

/** The un-merged programmatic overlay per map id — registered by each MapDef
 *  below, read by the editor's reference layer. */
const EDIT_BASE_OVERLAYS: Record<string, () => OverlayPayload> = {};

export function getMapBaseOverlay(mapId: string): OverlayPayload {
  const build = EDIT_BASE_OVERLAYS[mapId];
  return build ? build() : emptyOverlay([]);
}

/** Register a map's programmatic base and return a source-overlay builder
 *  that merges the user's stored per-map edits on top of it. Road-prop
 *  sidecars are index-keyed, so user keys shift by the base road count. */
function withUserOverlay(mapId: string, base: () => OverlayPayload): () => OverlayPayload {
  EDIT_BASE_OVERLAYS[mapId] = base;
  return () => {
    const b = base();
    const user = _weLoadOverlayFromStorage(mapId);
    const userHasContent =
      user.roads.length > 0 || user.surfaces.length > 0 || user.buildings.length > 0 ||
      user.rivers.length > 0 || user.lakes.length > 0 || user.parkingLots.length > 0 ||
      (user.intersections?.length ?? 0) > 0;
    if (!userHasContent) return b;
    const baseN = b.roads.length;
    const roadProps: OverlayPayload['roadProps'] = { ...b.roadProps };
    for (const [k, v] of Object.entries(user.roadProps ?? {})) {
      roadProps[String(baseN + Number(k))] = v;
    }
    const materialOverrides: OverlayPayload['materialOverrides'] = { ...b.materialOverrides };
    for (const [k, v] of Object.entries(user.materialOverrides ?? {})) {
      materialOverrides[String(baseN + Number(k))] = v;
    }
    return {
      roads: [...b.roads, ...user.roads],
      surfaces: [...b.surfaces, ...user.surfaces],
      buildings: [...b.buildings, ...user.buildings],
      rivers: [...b.rivers, ...user.rivers],
      lakes: [...b.lakes, ...user.lakes],
      parkingLots: [...b.parkingLots, ...user.parkingLots],
      intersections: [...(b.intersections ?? []), ...(user.intersections ?? [])],
      roadProps,
      materialOverrides,
    };
  };
}

/** H1249: mark every overlay road row as a RACE SURFACE. The sidecar is keyed
 *  by row index, exactly like the one-way flag. Suppresses the yellow
 *  opposing-traffic centreline and the dashed lane dividers — a circuit has
 *  neither, and painting public-road markings on one was the tell that these
 *  maps were built out of city road rows. */
function racewayProps(rows: unknown[]): OverlayPayload['roadProps'] {
  const props: OverlayPayload['roadProps'] = {};
  for (let i = 0; i < rows.length; i++) {
    (props as Record<string, { raceway?: boolean }>)[String(i)] = { raceway: true };
  }
  return props;
}
function emptyEdits(): BaselineEditsPayload {
  return { edits: {}, deletes: [], roadProps: {}, materialOverrides: {} };
}

// ---------------------------------------------------------------------------
// Track geometry (tile coords). Centred on the map so a blank-baseline test
// map has the track near the middle of the grid.
// ---------------------------------------------------------------------------
const MAP_CENTER = 1250;

/** Drag strip: one straight TWO-LANE road running +y (H1015: w=6 renders 2
 *  lanes with a dashed centre divider; w=12 was a 4-lane highway). Layout is a
 *  short run-up, the staging line, a true quarter mile (402 m = ~140 tiles via
 *  WPX_PER_M), then a shutdown area. Overlay schema: [w, maj, name, z, x1,y1,...]. */
const DRAG_STAGE_Y = MAP_CENTER - 100;          // staging / start line
const DRAG_QUARTER_TILES = Math.round(402 * WPX_PER_M / TILE); // ~140 tiles
const DRAG_ROAD_TOP = DRAG_STAGE_Y - 16;        // short run-up behind staging
const DRAG_ROAD_BOT = DRAG_STAGE_Y + DRAG_QUARTER_TILES + 55; // shutdown past finish
/** Half a lane in tiles — racers stage one in each of the two lanes. */
const LANE_HALF = 0.64;
function dragStripRoads(): unknown[] {
  // H1017: w=4 = TWO lanes total (getLaneGeom laneCount = lps*2; w=4 -> lps=1
  // -> 2 lanes). w=6 was 4 lanes. maj=0 keeps it a plain strip (no
  // major-road wear/oil detailing). A real single two-lane drag strip.
  return [
    [4, 0, 'Drag Strip', 0, MAP_CENTER, DRAG_ROAD_TOP, MAP_CENTER, DRAG_ROAD_BOT],
  ];
}

/** Oval: a closed elliptical loop (first point repeated to close it). Densely
 *  sampled + closed-loop smoothed at render time (smoothFlatPolyline detects
 *  the first==last ring) so it reads as a smooth, seamless track. */
const OVAL_RX = 78;
const OVAL_RY = 50;
function ovalRoads(): unknown[] {
  // H1017: w=6 (4 lanes, NOT divided) + maj=0. w=10 was a DIVIDED highway
  // with a grass median (getLaneGeom w===10 preset) — the "split highway"
  // the player was stuck on the wrong side of. A single wide track surface.
  const row: (string | number)[] = [6, 0, 'Oval Track', 0];
  const N = 64;
  for (let i = 0; i <= N; i++) {
    const a = (i / N) * Math.PI * 2;
    row.push(Math.round(MAP_CENTER + Math.cos(a) * OVAL_RX));
    row.push(Math.round(MAP_CENTER + Math.sin(a) * OVAL_RY));
  }
  return [row];
}

// ---------------------------------------------------------------------------
// Car meet (H1032): a night parking lot full of cars at the head of a drag
// strip. The player spawns in the lot, drives up to a parked car (H1033), and
// challenges it to a race (H1034). The lot polygon is stamped drivable by
// buildBaselineMap; the strip is where the challenge drag race runs.
// ---------------------------------------------------------------------------
const MEET_LOT_X0 = 1242, MEET_LOT_Y0 = 1245;   // lot rectangle (tile coords)
const MEET_LOT_X1 = 1258, MEET_LOT_Y1 = 1256;   // 16 wide × 11 tall (3 stall rows)
// Strip drops out of the bottom-centre of the lot, running +y (like dragstrip).
const MEET_STRIP_TOP = MEET_LOT_Y1 - 2;         // tucks into the lot edge so it bonds
const MEET_STRIP_BOT = MEET_STRIP_TOP + DRAG_QUARTER_TILES + 55;

// ---------------------------------------------------------------------------
// H1243: PIT PADDOCK for the real circuits.
//
// Derived from each circuit's own centerline rather than hand-placed per track,
// so all four get a paddock from one implementation and it stays correct if the
// OSM geometry is ever regenerated.
//
// Shape: an apron (parking-lot polygon, stamped drivable tile 18/19 — which is
// also what makes the PARK / ENGINE OFF prompt fire there) running alongside
// the start/finish straight, with a row of garage bays backing onto it. The
// bays are authored as RESIDENCE-type building rows on purpose: residences are
// the type buildBaselineMap carves a drive-in garage notch for, and the type
// placedBuildings marks enterable — so driving into a bay opens the same
// GARAGE / SPECS / PARTS / REPAIRS / UPGRADE screens as the home garage, which
// is exactly the ask ("working on car at the track can be just like working on
// car at home garage"). No new overlay schema, no new entry code.
// ---------------------------------------------------------------------------

/** Tiles from the track centerline to the near edge of the pit apron. The race
 *  surface is w=6 (~5 tiles wide), so this clears it with room to spare. */
const PIT_APRON_OFFSET = 7;
/** Pit-lane depth (tiles) — the lane you drive down plus room to swing into a
 *  bay. ~17 m. */
const PIT_APRON_DEPTH = 6;
/** How close the pit-exit lane gets to the track centerline. The race surface
 *  is w=6 → 4 lanes ≈ 5.1 tiles wide, so its tiles reach ~2.6 out; 3.0 sits
 *  just clear of them, which matters because the surface stamp is a hard
 *  write that would otherwise punch a hole in the racing surface. */
const PIT_EXIT_INNER = 3.0;
/** H1246: eight single-car boxes in a row, NASCAR-style (user reference). */
const PIT_BAYS = 8;
const PIT_BAY_W = 4;        // single car + door clearance
const PIT_BAY_DEPTH = 5;    // ~14 m
const PIT_BAY_GAP = 0.5;

/** Half-width of the w=6 race surface in tiles (4 lanes × LANE_W_STD / 2). */
const TRACK_HALF_TILES = 2.6;

export interface PitPaddock {
  /** H1249: pit lane + pit exit as ROAD rows — track asphalt, one continuous
   *  lane. Were driveway SURFACES in H1246, which stamped pale concrete slabs
   *  and read as jumbled rectangles. */
  roads: unknown[];
  /** H1249: the starting-grid boxes ("… grid" name keeps them empty of NPC
   *  cars — see rebuildParkedCars). */
  lots: unknown[];
  surfaces: unknown[];
  buildings: unknown[];
  /** Tile the player is posed at when arriving for a track day (the mouth of
   *  the first bay). */
  pitTile: readonly [number, number];
  pitAngle: number;
}

/** Index of the baked centerline point nearest a tile. */
function nearestPointIdx(points: readonly number[], tx: number, ty: number): number {
  let best = 0, bestD = Infinity;
  for (let i = 0; i + 1 < points.length; i += 2) {
    const d = (points[i] - tx) ** 2 + (points[i + 1] - ty) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/** Distance from a point to a segment, in tiles. */
function distToSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}

/** Smallest distance from any centerline point to any edge of any polygon in
 *  `polys` (flat [x,y,...] rings), in tiles.
 *
 *  Checking POLYGON CORNERS against the track is not enough — that was the
 *  first attempt and it put Watkins Glen's apron straight through the circuit,
 *  because the track crossed the middle of the rectangle without coming near a
 *  corner. This walks the track instead, which is the side that can pass
 *  through. Track points outside the padded bbox are rejected first so this
 *  stays cheap enough to run at module load. */
function trackClearance(points: readonly number[], polys: number[][]): number {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of polys) {
    for (let i = 0; i + 1 < p.length; i += 2) {
      if (p[i] < minX) minX = p[i];
      if (p[i] > maxX) maxX = p[i];
      if (p[i + 1] < minY) minY = p[i + 1];
      if (p[i + 1] > maxY) maxY = p[i + 1];
    }
  }
  const MARGIN = 30;
  let best = Infinity;
  for (let i = 0; i + 1 < points.length; i += 2) {
    const x = points[i], y = points[i + 1];
    if (x < minX - MARGIN || x > maxX + MARGIN || y < minY - MARGIN || y > maxY + MARGIN) continue;
    for (const p of polys) {
      for (let k = 0; k + 1 < p.length; k += 2) {
        const k2 = (k + 2) % p.length;
        const d = distToSeg(x, y, p[k], p[k + 1], p[k2], p[k2 + 1]);
        if (d < best) best = d;
      }
    }
  }
  return best;
}

/** Build the paddock for one circuit from its centerline. */
export function buildPitPaddock(
  startTile: readonly [number, number],
  points: readonly number[],
): PitPaddock {
  const n = points.length / 2;
  const i0 = nearestPointIdx(points, startTile[0], startTile[1]);
  // Tangent over a few samples so a single noisy vertex can't skew it.
  const span = 6;
  const ia = ((i0 / 2 - span + n) % n) * 2;
  const ib = ((i0 / 2 + span) % n) * 2;
  let tx = points[ib] - points[ia];
  let ty = points[ib + 1] - points[ia + 1];
  const tl = Math.hypot(tx, ty) || 1;
  tx /= tl; ty /= tl;
  // Left-hand normal; flip to whichever side sits further from the rest of the
  // lap so the paddock never lands on another part of the track.
  const nx0 = -ty, ny0 = tx;

  const totalLen = PIT_BAYS * PIT_BAY_W + (PIT_BAYS - 1) * PIT_BAY_GAP;
  const back = PIT_APRON_OFFSET + PIT_APRON_DEPTH + PIT_BAY_DEPTH;
  const front = PIT_APRON_OFFSET + PIT_APRON_DEPTH;

  /** Lay the paddock out on one side (`sign`), slid `slide` tiles along the
   *  straight. Returns the geometry plus how close the track gets to it. */
  function layout(sign: number, slide: number): PitPaddock & { clearance: number } {
    const nx = nx0 * sign, ny = ny0 * sign;
    const s0 = -totalLen / 2 + slide;
    const P = (s: number, d: number): [number, number] => [
      +(startTile[0] + tx * s + nx * d).toFixed(2),
      +(startTile[1] + ty * s + ny * d).toFixed(2),
    ];
    // Apron: a rectangle spanning the bay row, a little longer at each end so
    // there's room to swing in and out.
    const aprL = s0 - 5, aprR = s0 + totalLen + 5;
    const apron = [
      ...P(aprL, PIT_APRON_OFFSET), ...P(aprR, PIT_APRON_OFFSET),
      ...P(aprR, PIT_APRON_OFFSET + PIT_APRON_DEPTH), ...P(aprL, PIT_APRON_OFFSET + PIT_APRON_DEPTH),
    ];
    // Bays sit BEHIND the apron, openings facing back toward it (and the
    // track). Corner order matters: _weGarageRect treats corners[2]->corners[3]
    // as the FRONT edge and carves the drive-in notch there, with the centroid
    // behind it — so emit [backA, backB, frontB, frontA].
    const bays: number[][] = [];
    for (let i = 0; i < PIT_BAYS; i++) {
      const sA = s0 + i * (PIT_BAY_W + PIT_BAY_GAP);
      const sB = sA + PIT_BAY_W;
      bays.push([...P(sA, back), ...P(sB, back), ...P(sB, front), ...P(sA, front)]);
    }
    // PIT EXIT: a short paved lane joining the apron to the edge of the race
    // surface. Without it the player has to cross seven tiles of grass.
    //
    // It AIMS AT THE NEAREST CENTERLINE POINT rather than running perpendicular
    // to the start/finish straight. Perpendicular was the first attempt and it
    // missed completely at Laguna Seca, whose paddock slides a long way down
    // the straight to find clearance — by which point the track has curved away
    // and a perpendicular lane ends in a field 9.7 tiles short.
    //
    // It stops PIT_EXIT_INNER short of the centerline: the surface stamp is a
    // HARD tile write that overwrites road tiles, so running it to the middle
    // of the track would punch a lane-shaped hole in the racing surface.
    const anchor = P(s0 + totalLen + 1, PIT_APRON_OFFSET + 0.2);
    let tgx = anchor[0], tgy = anchor[1], tgD = Infinity;
    for (let i = 0; i + 1 < points.length; i += 2) {
      const d = (points[i] - anchor[0]) ** 2 + (points[i + 1] - anchor[1]) ** 2;
      if (d < tgD) { tgD = d; tgx = points[i]; tgy = points[i + 1]; }
    }
    let ex = tgx - anchor[0], ey = tgy - anchor[1];
    const eLen = Math.hypot(ex, ey) || 1;
    ex /= eLen; ey /= eLen;
    const EXIT_HALF = 2.2;
    const px = -ey * EXIT_HALF, py = ex * EXIT_HALF;
    // Start a little back inside the apron so the two lots bond.
    const bx = anchor[0] - ex * 2, by = anchor[1] - ey * 2;
    const fx = tgx - ex * PIT_EXIT_INNER, fy = tgy - ey * PIT_EXIT_INNER;
    const R = (x: number, y: number): [number, number] => [+x.toFixed(2), +y.toFixed(2)];
    // Footprint of the exit lane, kept for the clearance check only — the lane
    // itself is emitted as a road below (H1249).
    const exitFootprint = [
      ...R(bx + px, by + py), ...R(fx + px, fy + py),
      ...R(fx - px, fy - py), ...R(bx - px, by - py),
    ];
    void exitFootprint;
    // H1249: the pit lane and its exit are ROAD rows, not surfaces.
    //
    // Driveway-named surfaces (H1246) stamped CONCRETE and drew as flat pale
    // slabs, which is what the user saw as "concrete driveway path... jumbled
    // rectangles". A road row is the right primitive: it renders as track
    // asphalt with proper edge lines, curves and joins as one continuous lane
    // rather than a chain of quads, and — flagged raceway — carries no public
    // lane markings. Schema: [w, maj, name, z, x1,y1, ...]; w=4 is a single
    // two-lane-wide ribbon, which is about right for a pit lane.
    const laneD = PIT_APRON_OFFSET + PIT_APRON_DEPTH / 2;
    const pitLaneRoad = [
      4, 0, 'Pit Lane', 0,
      ...P(s0 - 6, laneD), ...P(s0 + totalLen * 0.5, laneD), ...P(s0 + totalLen + 6, laneD),
    ];
    // Exit joins the lane end to the track edge (aimed, see below).
    const pitExitRoad = [
      4, 0, 'Pit Exit', 0,
      ...R(bx, by), ...R((bx + fx) / 2, (by + fy) / 2), ...R(fx, fy),
    ];
    return {
      roads: [pitLaneRoad, pitExitRoad],
      // H1267: NO starting-grid lot. H1249 emitted one here as a parking-lot
      // polygon whose placement search required `trackClearance >=
      // TRACK_HALF_TILES + 0.3` — 2.9 tiles from the centerline, while the w=6
      // race surface is only 2.55 tiles half-width. By construction it could
      // only ever land on the GRASS VERGE beside the track, where it rendered
      // as a pale slab with perpendicular parking stripes and two tree
      // planters. That is why the user reported, twice, that the tracks have
      // no indicator lines for starting positions: the grid was never on the
      // track. The real thing is now PAINTED on the racing surface by
      // render/startGrid, from world/startLine geometry.
      lots: [],
      surfaces: [],
      // 'pitgarage' (H1246) is enterable like a residence so the drive-in notch
      // is carved, but is NOT a shingle roof type — a flat concrete box, not a
      // house. The NAME is what the player sees.
      buildings: bays.map((b, i) => [`Pit Garage ${i + 1}`, 'pitgarage', ...b]),
      // Pose in the middle of bay 1's mouth, nose out toward the apron.
      pitTile: P(s0 + PIT_BAY_W / 2, front - 0.6),
      pitAngle: Math.atan2(-ny, -nx),
      clearance: trackClearance(points, [apron, ...bays]),
    };
  }

  // Search both sides and a few slides along the straight, taking the first
  // placement that clears the race surface with margin.
  //
  // A single centre probe is NOT enough: at Watkins Glen the circuit doubles
  // back close to the start/finish, and the "further" side still put one end
  // of the 37-tile apron 0.36 tiles from the centerline — i.e. on the track.
  // Scoring the whole footprint and sliding along the straight fixes it.
  const WANT = 3.5;
  let best = layout(1, 0);
  for (const sign of [1, -1]) {
    for (const slide of [0, 12, -12, 24, -24, 36, -36, 48, -48]) {
      const cand = layout(sign, slide);
      if (cand.clearance > best.clearance) best = cand;
      if (best.clearance >= WANT) break;
    }
    if (best.clearance >= WANT) break;
  }
  return best;
}

/** H1086: build a real-circuit overlay road row from a baked flat point list.
 *  w=6 = a single 4-lane-wide (~14.6 m) undivided race surface where the render
 *  and collision widths agree; maj=0 (no highway wear detailing); z=0; a neutral
 *  name (never 'I-485', which the pipeline treats as a divided road). The points
 *  already repeat the first vertex as the last so the closed-ring smoother fires. */
function realTrackRoads(name: string, points: readonly number[]): unknown[] {
  return [[6, 0, name, 0, ...points]];
}

/** H1087: build a touge overlay road row from a baked OPEN point list. Same
 *  w=6 race surface as the circuits, but the point list is NOT closed (first
 *  vertex not repeated) so it renders as a point-to-point mountain road. */
function tougeRoads(name: string, points: readonly number[]): unknown[] {
  return [[6, 0, name, 0, ...points]];
}

/** Two-lane strip running +y out of the lot (w=4 = 2 lanes, maj=0 plain). */
function carMeetRoads(): unknown[] {
  return [
    [4, 0, 'Drag Strip', 0, MAP_CENTER, MEET_STRIP_TOP, MAP_CENTER, MEET_STRIP_BOT],
  ];
}
/** Parking-lot polygon in the H699 schema
 *  `[name, material, stallW, stallL, aisleW, x1,y1, ...]`. H1035: stalls sized
 *  to the actual car footprint (~1.6 tiles long × ~0.63 wide) with door margin
 *  — 1.1 wide × 2.3 deep — so cars fill their spots instead of floating in an
 *  oversized bay. aisle 2.6 tiles for a believable drive lane. */
function carMeetLots(): unknown[] {
  return [
    ['Car Meet', 'asphalt', 1.1, 2.3, 2.6,
      MEET_LOT_X0, MEET_LOT_Y0,
      MEET_LOT_X1, MEET_LOT_Y0,
      MEET_LOT_X1, MEET_LOT_Y1,
      MEET_LOT_X0, MEET_LOT_Y1],
  ];
}

/** H1086: real circuits (Monza / Spa / Watkins Glen / Laguna Seca) built from
 *  baked true-scale OSM centerlines. Each is a blank grass world + one closed
 *  race-surface road, traffic off, with a SOLO best-lap timer (no opponent). */
const CIRCUIT_MAPS: readonly MapDef[] = REAL_TRACKS.map((t) => {
  // H1243: paddock derived from this circuit's own centerline (see
  // buildPitPaddock). Computed once at module load, not per source() call.
  const pit = buildPitPaddock(t.startTile, t.points);
  // H1277: circuit base = ribbon + pit lane/exit + garages, all raceway-
  // flagged; the user's per-map edits merge on top at source() time.
  const overlay = withUserOverlay(t.id, () => {
    const roads = [...realTrackRoads(t.name, t.points), ...pit.roads];
    return {
      ...emptyOverlay(roads),
      roadProps: racewayProps(roads),
      parkingLots: pit.lots,
      buildings: pit.buildings,
    };
  });
  return {
  id: t.id,
  name: t.name,
  inRacePicker: true,
  menuLabel: t.name.toUpperCase(),
  menuSub: `${(t.lengthM / 1000).toFixed(1)} km · ${t.country}`,
  spawnTile: t.spawnTile,
  spawnAngle: t.spawnAngle,
  pitTile: pit.pitTile,
  pitAngle: pit.pitAngle,
  traffic: false,
  // Solo best-lap timer: the start/finish straight is the timing zone; no
  // opponent, no daily cap — just drive it and read the lap times.
  race: {
    kind: 'lap' as const,
    startTile: t.startTile,
    startRadius: 5,
    solo: true,
    // H1269: a GRID RACE needs a lap count to finish on. There was none, so
    // `spec.laps ?? 3` silently gave Spa (7.0 km) the same three laps as
    // Laguna (3.6 km) — 21 km vs 11 km — and the HUD had nothing to show, so
    // the readout was a bare "LAP 4" with no target. Scaled to ~16 km of
    // racing instead, clamped 2..6, which lands at monza 3 / spa 2 /
    // watkins 3 / laguna 4. Only a RACE reads this; test lap and practice
    // stay open-ended.
    laps: Math.max(2, Math.min(6, Math.round(16000 / t.lengthM))),
  },
  source: () => ({
    baselineRoads: [],
    baselineRivers: [],
    baselineLakes: [],
    // H1249: the circuit ribbon plus the pit lane + exit, ALL flagged as race
    // surfaces so none of them get public-road lane markings. H1277: plus the
    // user's own per-map editor overlay, merged live.
    overlay: overlay(),
    baselineEdits: emptyEdits(),
  }),
  };
});

/** H1087: touge (mountain pass) maps — a blank grass world + one OPEN winding
 *  road, traffic off, forced daytime? (no — inherit clock), with a SPRINT
 *  point-to-point timer (summit start zone -> base finish zone). No opponent
 *  in P1 (1v1 lands with the polyline-follow AI). */
const TOUGE_MAPS: readonly MapDef[] = TOUGE_ROADS.map((t) => {
  const overlay = withUserOverlay(t.id, () => emptyOverlay(tougeRoads(t.name, t.points)));
  return {
  id: t.id,
  name: t.name,
  inRacePicker: true,
  menuLabel: t.name.toUpperCase(),
  menuSub: `${(t.lengthM / 1000).toFixed(1)} km · ${t.blurb}`,
  spawnTile: t.spawnTile,
  spawnAngle: t.spawnAngle,
  traffic: false,
  offTrackFatal: true,   // H1088: the edges are canyon cliffs.
  race: {
    kind: 'sprint' as const,
    startTile: t.startTile,
    startRadius: 5,
    finishTile: t.finishTile,
    finishRadius: 6,
  },
  source: () => ({
    baselineRoads: [],
    baselineRivers: [],
    baselineLakes: [],
    overlay: overlay(),
    baselineEdits: emptyEdits(),
  }),
  };
});

// H1277: per-map user-overlay builders for the fixed test maps (the circuits
// and touges register theirs inside their .map() constructors above).
const dragstripOverlay = withUserOverlay('dragstrip', () => emptyOverlay(dragStripRoads()));
const circleOverlay = withUserOverlay('circle', () => emptyOverlay(ovalRoads()));
const carmeetOverlay = withUserOverlay('carmeet', () => ({
  ...emptyOverlay(carMeetRoads()),
  parkingLots: carMeetLots(),
}));

// H1317: Charlotte OSM — the real road network imported from OpenStreetMap
// via tools/osm/ (highways tier: motorway/trunk + ramps, 1:6 layout scale).
// Roads ship as baselineRoads (read directly by both consumers, no per-call
// copying); the base overlay carries only the authored intersections so
// applyAuthoredIntersections picks up the real signal/stop locations.
// Data © OpenStreetMap contributors, ODbL.
// H1322: ramps ship as connector-builder MERGE rows in the base overlay
// (bond sidecars keyed by base index — withUserOverlay re-keys user rows
// after them), so every interchange renders gore-tapered merge lanes with
// dashed channelizing through the SAME pipeline as hand-drawn ➕ Lane rows.
const charlotteOsmOverlay = withUserOverlay('charlotte-osm', () => ({
  ...emptyOverlay(OSM_CLT_RAMP_ROWS as unknown[]),
  roadProps: OSM_CLT_RAMP_PROPS as OverlayPayload['roadProps'],
  intersections: OSM_CLT_INTERSECTIONS,
}));

const MAPS: readonly MapDef[] = [
  {
    id: 'city',
    name: 'Charlotte',
    spawnTile: [1000, 1100],
    spawnAngle: 0,
    source: () => ({
      baselineRoads: BASELINE_ROADS,
      baselineRivers: BASELINE_RIVERS,
      baselineLakes: BASELINE_LAKES,
      overlay: _weLoadOverlayFromStorage(),
      baselineEdits: _weLoadBaselineEdits(),
    }),
  },
  {
    id: 'charlotte-osm',
    name: 'Charlotte OSM',
    inRacePicker: true,
    menuLabel: '🌆 CHARLOTTE OSM',
    menuSub: 'Real beltway · free drive',
    spawnTile: OSM_CLT_SPAWN_TILE,
    spawnAngle: OSM_CLT_SPAWN_ANGLE,
    source: () => ({
      baselineRoads: OSM_CLT_ROWS,
      baselineRivers: [],
      baselineLakes: [],
      overlay: charlotteOsmOverlay(),
      baselineEdits: emptyEdits(),
      // OSM-C: oneway sidecar for the baseline rows (177 unpaired one-way
      // carriageways + one-way ramp deck spans).
      baselineRoadProps: OSM_CLT_PROPS,
    }),
  },
  {
    id: 'dragstrip',
    name: 'Drag Strip',
    inRacePicker: true,
    menuLabel: '🏁 DRAG STRIP',
    menuSub: 'Quarter mile · vs rival',
    // Stage in the LEFT lane on the start line, nose pointing +y (the rival
    // stages in the right lane — see trackRace). Both same direction.
    //
    // H1245: the extra -0.5 is a UNIT FIX, not a nudge. switchMap poses the
    // player at (spawnTile + 0.5) * TILE — the tile-CENTRE convention — while
    // road polylines (and the rival's lane maths in trackRace) use RAW tile
    // coords. Without it the +0.5 all but cancelled the -0.64 lane offset and
    // the player staged 2.5 px off centre, i.e. straddling the yellow line
    // while the rival sat correctly in the right lane. w=4 -> 2 lanes of
    // LANE_W_STD (1.275t), so a lane centre is 0.64t off the centreline.
    spawnTile: [MAP_CENTER - LANE_HALF - 0.5, DRAG_STAGE_Y],
    spawnAngle: Math.PI / 2,
    traffic: false,
    forceNight: true,   // H1031: night drag strip
    // Quarter mile (402 m) timed run from the staging line (zone centred on
    // the strip, wide enough to cover both lanes).
    race: { kind: 'drag', startTile: [MAP_CENTER, DRAG_STAGE_Y], startRadius: 5, meters: 402 },
    source: () => ({
      baselineRoads: [],
      baselineRivers: [],
      baselineLakes: [],
      overlay: dragstripOverlay(),
      baselineEdits: emptyEdits(),
    }),
  },
  {
    id: 'circle',
    name: 'Oval Track',
    inRacePicker: true,
    menuLabel: '⭕ OVAL TRACK',
    menuSub: '3 laps · vs rival',
    // Start on the oval's rightmost point, nose pointing +y (into the turn).
    // H1245: same raw-vs-centre unit fix as the drag strip, plus a lane offset
    // so the player runs the OUTER line and the rival's inner line (see
    // OVAL_LANE_TILES) is genuinely a separate lane rather than the same one.
    spawnTile: [MAP_CENTER + OVAL_RX + LANE_HALF - 0.5, MAP_CENTER - 0.5],
    spawnAngle: Math.PI / 2,
    traffic: false,
    forceNight: true,   // H1031: night oval
    // 3-lap timed run; start/finish is the rightmost point (the spawn).
    race: {
      kind: 'lap', startTile: [MAP_CENTER + OVAL_RX, MAP_CENTER], startRadius: 6, laps: 3,
      ovalCenter: [MAP_CENTER, MAP_CENTER], ovalRx: OVAL_RX, ovalRy: OVAL_RY,
    },
    source: () => ({
      baselineRoads: [],
      baselineRivers: [],
      baselineLakes: [],
      overlay: circleOverlay(),
      baselineEdits: emptyEdits(),
    }),
  },
  {
    id: 'carmeet',
    name: 'Car Meet',
    inRacePicker: true,
    menuLabel: '🚗 CAR MEET',
    menuSub: 'Roll up · challenge a car',
    // Spawn at the front apron of the lot, nose pointing −y (north) so the
    // player looks out across the parked-car rows on arrival.
    spawnTile: [MAP_CENTER, MEET_LOT_Y1 - 1],
    spawnAngle: -Math.PI / 2,
    traffic: false,
    forceNight: true,   // H1031: late-night car meet
    // H1034: a drag strip down the middle. autoStage:false — you race by
    // driving up to a parked car and CHALLENGING it (a specific opponent),
    // not by rolling into a staging zone. startTile = top of the strip.
    race: {
      kind: 'drag',
      // H1267: the staging line moved 3 tiles down the strip (was
      // MEET_STRIP_TOP + 2). At +2 it sat 2.5 tiles from the top of the strip,
      // which is less than one car length of run-up — there was nowhere to put
      // the staging boxes, and the paint ran off the end of the pavement. +5
      // leaves 5.5 tiles behind the line and still finishes at tile 1399.6,
      // well inside MEET_STRIP_BOT (1449).
      startTile: [MAP_CENTER, MEET_STRIP_TOP + 5],
      startRadius: 6,
      meters: 402,
      autoStage: false,
    },
    source: () => ({
      baselineRoads: [],
      baselineRivers: [],
      baselineLakes: [],
      overlay: carmeetOverlay(),
      baselineEdits: emptyEdits(),
    }),
  },
  ...CIRCUIT_MAPS,
  ...TOUGE_MAPS,
];

export function getMapDef(id: string): MapDef {
  return MAPS.find((m) => m.id === id) ?? MAPS[0];
}
export function listMaps(): readonly MapDef[] {
  return MAPS;
}
