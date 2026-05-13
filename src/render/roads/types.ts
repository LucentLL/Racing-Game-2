/**
 * Types shared across the road-rendering subsystem.
 *
 * The Road object has a large surface — most fields are precomputed Path2D
 * caches built once at world-preprocess time (see world/roadPreproc.ts
 * landing in C24). The renderer just consumes them; if a cache is absent,
 * fallback paths in roads/overlay.ts handle the case at lower performance.
 */

export interface BBox {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** Output of getRoadProfile(road) — pre-computed lane geometry. */
export interface RoadProfile {
  /** Total carriageway width including shoulders, in tiles. Same as road.w
   *  on minor roads; for major roads, it's lanes + 0.5 lane shoulder on
   *  each side. */
  asphaltW: number;
  /** Drive surface width (lanes only), in tiles. */
  totalW: number;
  /** Width of one lane, in tiles. */
  laneW: number;
  /** Lanes per side (1, 2, 3 …). 0 = no markings. */
  lps: number;
  /** Half of totalW, in tiles. */
  halfW: number;
  /** Effective median half-width, in tiles. Median minus shoulder for
   *  divided highways. */
  effectiveMedHalf: number;
  /** Lane divider offsets in tiles (signed: negative = left of center). */
  dividers: readonly number[];
  /** White outer edge stripe offsets in tiles. Empty if road too narrow. */
  edgeOffsets: readonly number[];
  /** Yellow inner edge stripe offsets (divided highways only). */
  innerEdgeOffsets?: readonly number[];
}

/** Pre-built per-chunk path bundle. Long roads are chunked at preprocess
 *  time so per-frame stroke calls touch only the visible chunks. */
export interface RoadChunk {
  bbox: BBox;
  mainPath: Path2D;
  /** Lane divider Path2Ds, one per offset. */
  dividerPaths?: Path2D[];
  /** Tire-wear offset paths (~2 per lane, both sides). */
  wearPaths?: Path2D[];
  /** Oil-drip offset paths (1 per lane center, both sides). */
  oilPaths?: Path2D[];
  /** White outer edge stripe paths (1 per side). */
  edgePaths?: Path2D[];
  /** Yellow inner edge stripe paths (divided highways only). */
  innerEdgePaths?: Path2D[];
  /** Phase offset (px) carried from previous chunk's last dash gap — keeps
   *  dashed strokes continuous across chunk boundaries. */
  dashLen?: number;
}

export type RoadPts = ReadonlyArray<readonly [number, number]>;

/** Per-segment material/age override for the materialOverrides path. */
export interface SegmentMaterialAge {
  material: string;
  age: number;
}

/** Bridge crossing point in tile coords. */
export interface BridgePoint {
  x: number;
  y: number;
}

/** The runtime Road object. */
export interface Road {
  pts: RoadPts;
  w: number;
  name: string;
  z?: number;
  /** Major road flag (asphalt color, edge-band tint, oil-feature density). */
  maj?: boolean;
  /** Pre-built world bbox. */
  _bbox?: BBox;
  /** Cached profile (avoids per-frame getRoadProfile()). */
  _prof?: RoadProfile;
  /** Pre-built main asphalt Path2D. */
  _mainPath?: Path2D;
  /** Chunk list for long roads (e.g. full I-485 ring). */
  _chunks?: RoadChunk[];
  /** Lane divider paths (when not chunked). */
  _dividerPaths?: Path2D[];
  _wearPaths?: Path2D[];
  _oilPaths?: Path2D[];
  _edgePaths?: Path2D[];
  _innerEdgePaths?: Path2D[];
  /** T-junction erase paths (gap the edge stripe at a cross-street). */
  _teeEdgeErasePaths?: Path2D[];

  /** Bridge crossing points (only present on z >= 2 roads with bridges). */
  bridgePts?: BridgePoint[];

  // ---- Merge polygon (an editor-built merge ramp) ----
  merge?: boolean;
  _mergePolyPath?: Path2D;
  _mergeOuterEdgePath?: Path2D;
  _mergeInnerEdgePath?: Path2D;
  _mergeAsymmetric?: boolean;
  /** True if the merge's destination is a major road — promotes asphalt
   *  pattern to match. */
  _bondedToMajor?: boolean;

  // ---- Auto-taper (width-mismatched endpoint joins) ----
  _autoTaperStartPolyPath?: Path2D;
  _autoTaperEndPolyPath?: Path2D;
  _autoTaperStartOuterPath?: Path2D;
  _autoTaperStartInnerPath?: Path2D;
  _autoTaperEndOuterPath?: Path2D;
  _autoTaperEndInnerPath?: Path2D;
  _autoTaperStartOuterStripePath?: Path2D;
  _autoTaperStartInnerStripePath?: Path2D;
  _autoTaperEndOuterStripePath?: Path2D;
  _autoTaperEndInnerStripePath?: Path2D;
  _autoTaperStartLaneAddPathPlus?: Path2D;
  _autoTaperStartLaneAddPathMinus?: Path2D;
  _autoTaperEndLaneAddPathPlus?: Path2D;
  _autoTaperEndLaneAddPathMinus?: Path2D;

  /** Per-segment material/age overrides (world editor). */
  materialOverrides?: ReadonlyArray<unknown>;
  /** Road material id ("asphalt-new" | "asphalt-old" | "concrete-new" …). */
  material?: string;
}

/** Roadside dependencies — pattern lookup, road metadata, perf hooks. */
export interface RoadOverlayDeps {
  TILE: number;
  /** Smoothed camera focus (FrameView.smoothFocusX/Y). */
  smoothFocusX: number;
  smoothFocusY: number;
  /** FrameView.viewR. */
  viewR: number;
  /** Player position (fallback per-point cull). */
  px: number;
  py: number;
  /** Returns the cached CanvasPattern for a given material/age/class combo. */
  getAsphaltPattern(
    ctx: CanvasRenderingContext2D,
    isMajor: boolean,
    isDriveway: boolean,
    age: number,
    material: string,
  ): CanvasPattern | string;
  /** Returns the road's age slot (0..1). */
  roadAge(road: Road): number;
  /** Returns the road's resolved material id. */
  roadMaterial(road: Road): string;
  /** Returns the cached or freshly-built RoadProfile. */
  getRoadProfile(road: Road): RoadProfile;
  /** Returns {material, age} effective at a given segment index for
   *  per-segment material overrides. */
  effectiveMaterialAge(road: Road, segmentIdx: number): SegmentMaterialAge;
  /** Diag gate from the F-key perf overlay. */
  diagOffRoads?: boolean;
  /** Perf instrumentation hooks. */
  perfOn?: boolean;
  perfStrokeCount?: (n: number) => void;
  perfStrokeFullPath?: (n: number) => void;
}
