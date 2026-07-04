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
  /** H1014: auto-start timed run for a test track (undefined on the city). */
  race?: TrackRaceSpec;
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

/** Drag strip: one straight road running +y. ~400 m of timed strip
 *  (WPX_PER_M 6.2746, TILE 18 -> ~139 tiles) plus staging + shutdown. Overlay
 *  road schema: [w, maj, name, z, x1,y1, x2,y2, ...]. */
const DRAG_START_Y = MAP_CENTER - 120;
const DRAG_END_Y = MAP_CENTER + 120; // 240 tiles: ~30 staging + 140 quarter-mile + 70 shutdown
function dragStripRoads(): unknown[] {
  return [
    [12, 1, 'Drag Strip', 0, MAP_CENTER, DRAG_START_Y, MAP_CENTER, DRAG_END_Y],
  ];
}

/** Oval: a closed elliptical loop sampled into a polyline (first point
 *  repeated to close it). */
const OVAL_RX = 78;
const OVAL_RY = 50;
function ovalRoads(): unknown[] {
  const row: (string | number)[] = [10, 1, 'Oval Track', 0];
  const N = 40;
  for (let i = 0; i <= N; i++) {
    const a = (i / N) * Math.PI * 2;
    row.push(Math.round(MAP_CENTER + Math.cos(a) * OVAL_RX));
    row.push(Math.round(MAP_CENTER + Math.sin(a) * OVAL_RY));
  }
  return [row];
}

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
    // Start on the strip a little past the top, nose pointing +y (down it).
    spawnTile: [MAP_CENTER, DRAG_START_Y + 12],
    spawnAngle: Math.PI / 2,
    traffic: false,
    // Quarter mile (402 m) timed run from the staging box at the top.
    race: { kind: 'drag', startTile: [MAP_CENTER, DRAG_START_Y + 12], startRadius: 5, meters: 402 },
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
    // Start on the oval's rightmost point, nose pointing +y (into the turn).
    spawnTile: [MAP_CENTER + OVAL_RX, MAP_CENTER],
    spawnAngle: Math.PI / 2,
    traffic: false,
    // 3-lap timed run; start/finish is the rightmost point (the spawn).
    race: { kind: 'lap', startTile: [MAP_CENTER + OVAL_RX, MAP_CENTER], startRadius: 6, laps: 3 },
    source: () => ({
      baselineRoads: [],
      baselineRivers: [],
      baselineLakes: [],
      overlay: emptyOverlay(ovalRoads()),
      baselineEdits: emptyEdits(),
    }),
  },
];

export function getMapDef(id: string): MapDef {
  return MAPS.find((m) => m.id === id) ?? MAPS[0];
}
export function listMaps(): readonly MapDef[] {
  return MAPS;
}
