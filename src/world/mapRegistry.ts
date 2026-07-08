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
 * Test maps are PROGRAMMATIC overlays (no localStorage, not editor-editable
 * yet) so they reuse the entire existing road/render pipeline with zero new
 * stamping code. Switching is wired in H1011 (switchMap + the editor-globe
 * picker); this file is pure data + defaults, so importing it changes
 * nothing until a switch is requested.
 */
import { BASELINE_ROADS, type BaselineRoadRow } from '@/config/world/baselineRoads';
import { BASELINE_RIVERS, BASELINE_LAKES } from '@/config/world/baselineWater';
import { TILE, WPX_PER_M } from '@/config/world/tiles';
import { REAL_TRACKS } from '@/config/world/realTracks';
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
}

/** H1014: auto-start timed-run spec for a test track. */
export interface TrackRaceSpec {
  kind: 'drag' | 'lap';
  /** Staging / start-finish zone center (tile) + radius (tiles). Drive in
   *  slowly to arm the countdown; on 'lap' the player re-crosses it each lap. */
  startTile: readonly [number, number];
  startRadius: number;
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
  /** H1014: auto-start timed run for a test track (undefined on the city). */
  race?: TrackRaceSpec;
  /** H1086: race-picker presentation (defaults derive from name if absent). */
  menuLabel?: string;
  menuSub?: string;
  /** H1086: true = a selectable race venue in the Home RACE picker. The city
   *  is excluded; test tracks + real circuits opt in. */
  inRacePicker?: boolean;
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

/** H1086: build a real-circuit overlay road row from a baked flat point list.
 *  w=6 = a single 4-lane-wide (~14.6 m) undivided race surface where the render
 *  and collision widths agree; maj=0 (no highway wear detailing); z=0; a neutral
 *  name (never 'I-485', which the pipeline treats as a divided road). The points
 *  already repeat the first vertex as the last so the closed-ring smoother fires. */
function realTrackRoads(name: string, points: readonly number[]): unknown[] {
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
const CIRCUIT_MAPS: readonly MapDef[] = REAL_TRACKS.map((t) => ({
  id: t.id,
  name: t.name,
  inRacePicker: true,
  menuLabel: t.name.toUpperCase(),
  menuSub: `${(t.lengthM / 1000).toFixed(1)} km · ${t.country}`,
  spawnTile: t.spawnTile,
  spawnAngle: t.spawnAngle,
  traffic: false,
  // Solo best-lap timer: the start/finish straight is the timing zone; no
  // opponent, no daily cap — just drive it and read the lap times.
  race: {
    kind: 'lap' as const,
    startTile: t.startTile,
    startRadius: 5,
    solo: true,
  },
  source: () => ({
    baselineRoads: [],
    baselineRivers: [],
    baselineLakes: [],
    overlay: emptyOverlay(realTrackRoads(t.name, t.points)),
    baselineEdits: emptyEdits(),
  }),
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
    id: 'dragstrip',
    name: 'Drag Strip',
    inRacePicker: true,
    menuLabel: '🏁 DRAG STRIP',
    menuSub: 'Quarter mile · vs rival',
    // Stage in the LEFT lane on the start line, nose pointing +y (the rival
    // stages in the right lane — see trackRace). Both same direction.
    spawnTile: [MAP_CENTER - LANE_HALF, DRAG_STAGE_Y],
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
      overlay: emptyOverlay(dragStripRoads()),
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
    spawnTile: [MAP_CENTER + OVAL_RX, MAP_CENTER],
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
      overlay: emptyOverlay(ovalRoads()),
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
      startTile: [MAP_CENTER, MEET_STRIP_TOP + 2],
      startRadius: 6,
      meters: 402,
      autoStage: false,
    },
    source: () => ({
      baselineRoads: [],
      baselineRivers: [],
      baselineLakes: [],
      overlay: { ...emptyOverlay(carMeetRoads()), parkingLots: carMeetLots() },
      baselineEdits: emptyEdits(),
    }),
  },
  ...CIRCUIT_MAPS,
];

export function getMapDef(id: string): MapDef {
  return MAPS.find((m) => m.id === id) ?? MAPS[0];
}
export function listMaps(): readonly MapDef[] {
  return MAPS;
}
