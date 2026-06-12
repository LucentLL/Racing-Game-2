/**
 * H43 — road surface textures (asphalt + concrete, new + old variants).
 *
 * Pre-bakes a 128×128 noise canvas per (material, age) combo and wraps
 * each in a CanvasPattern that the road renderer tiles across the
 * stroke. Replaces H11's flat-color asphalt strokes with the textured
 * grain the monolith ships.
 *
 * Port of monolith L2586-2836 in simplified form:
 *   - 2-layer noise (grain + speckle) per pattern (Layer 2 oil spots
 *     dropped — see H778 below)
 *   - 4 cached patterns: asphalt-new / asphalt-old / concrete-new /
 *     concrete-old, lazy-built on first request
 *   - Per-road deterministic age + material picker matching the
 *     monolith's _roadAge / _roadMaterial heuristics
 *
 * H267: 8-slot cache split by isMajor was added because Layer 2 wrote
 * oil features only on minors. H778 removed Layer 2 entirely so majors
 * and minors now produce identical patterns; the 8-slot cache is kept
 * for now since collapsing it is a no-op visually and the redundant
 * slots cost ~64 KB total (4 × 128² × RGBA).
 *
 * H778: Layer 2 (oil spots + drip trails) DELETED across both classes.
 * The 12 dark ellipses per pattern tile produced the user-reported
 * "off-color circles scattered across the asphalt" visible most
 * obviously on surface streets (Current Roads.PNG). The monolith
 * still carries this code at L2657-L2696, but the user wants the
 * modular port to ship without it. Lane-aware wear/oil features for
 * majors continue to render via drawRoadOverlay's prof.wearOffsets /
 * prof.oilOffsets path strokes — those are 1:1 ported and remain.
 */

import type { BaselineRoadRow } from '@/config/world/baselineRoads';

export type RoadMaterial = 'asphalt' | 'concrete';
export type RoadAge = 'new' | 'old';

const ASPHALT_NEW  = '#1e1e22';
const ASPHALT_OLD  = '#43403e';
const CONCRETE_NEW = '#c0b8a8';
const CONCRETE_OLD = '#988772';

/** 8-slot cache: 4 (material × age) × 2 (major/minor). Majors get a
 *  clean grain-only pattern; minors get grain + oil spots + drip trails
 *  (the v8.99.122.97 "cars don't park on highways" branch). */
interface PatternCache {
  asphaltNewMaj:  CanvasPattern | null;
  asphaltNewMin:  CanvasPattern | null;
  asphaltOldMaj:  CanvasPattern | null;
  asphaltOldMin:  CanvasPattern | null;
  concreteNewMaj: CanvasPattern | null;
  concreteNewMin: CanvasPattern | null;
  concreteOldMaj: CanvasPattern | null;
  concreteOldMin: CanvasPattern | null;
}

const cache: PatternCache = {
  asphaltNewMaj:  null,
  asphaltNewMin:  null,
  asphaltOldMaj:  null,
  asphaltOldMin:  null,
  concreteNewMaj: null,
  concreteNewMin: null,
  concreteOldMaj: null,
  concreteOldMin: null,
};

/** Mulberry-style deterministic LCG so the pattern is identical every
 *  build. Matches the monolith's seeded rng (L2605). */
function makeRng(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) | 0;
    return (s >>> 0) / 4294967296;
  };
}

/** Build a 128×128 noise canvas for the given base color. Caller wraps
 *  it in createPattern. */
function makePatternCanvas(baseHex: string, isMajor: boolean): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const cx = c.getContext('2d');
  if (!cx) return c;
  cx.fillStyle = baseHex;
  cx.fillRect(0, 0, 128, 128);
  const rnd = makeRng(0x13371337);

  // Layer 1 — medium grain (~400 dots @ r=0.2-0.5).
  for (let i = 0; i < 400; i++) {
    const x = rnd() * 128;
    const y = rnd() * 128;
    const r = 0.2 + rnd() * 0.3;
    const dark = rnd() < 0.5;
    const a = 0.25 + rnd() * 0.30;
    cx.fillStyle = dark ? `rgba(0,0,0,${a})` : `rgba(255,250,240,${a})`;
    cx.beginPath();
    cx.arc(x, y, r, 0, Math.PI * 2);
    cx.fill();
  }

  // Layer 2 — REMOVED (H778). Was 12 dark ellipses (2-5 px wide) +
  // 5 short drip trails on every non-major asphalt tile. The 128×128
  // pattern tiles across the road, so these "12 oil spots" appeared
  // every 7 tiles — reading as the user-reported "off-color circles
  // scattered across the asphalt." The monolith carried the same
  // feature (driver_city_charlotte_v8_99_126_89.html L2657-L2696)
  // but on review the user wanted them gone in the modular port.
  // isMajor branch was already empty after v8.99.122.97 dropped the
  // major wheel-path bands, so this leaves a single shared pattern
  // pipeline (grain + speckle) for both classes.
  void isMajor;

  // Layer 3 — super-fine speckle (~1200 dots @ r=0.1-0.3).
  for (let i = 0; i < 1200; i++) {
    const x = rnd() * 128;
    const y = rnd() * 128;
    const r = 0.1 + rnd() * 0.2;
    const dark = rnd() < 0.55;
    const a = 0.20 + rnd() * 0.30;
    cx.fillStyle = dark ? `rgba(0,0,0,${a})` : `rgba(245,235,220,${a})`;
    cx.beginPath();
    cx.arc(x, y, r, 0, Math.PI * 2);
    cx.fill();
  }
  return c;
}

/** Concrete for "Driveway"-named roads, asphalt otherwise. Matches
 *  monolith _roadMaterial L2758. H268: explicit override (from editor)
 *  takes precedence over the name fallback. */
function roadMaterialForRow(row: BaselineRoadRow, override?: RoadMaterial): RoadMaterial {
  if (override === 'asphalt' || override === 'concrete') return override;
  return row[2] === 'Driveway' ? 'concrete' : 'asphalt';
}

/** Deterministic per-road age — Murmur3-style avalanche mix of the
 *  first vertex. Returns 'new' for ~40% of roads, 'old' for ~60%.
 *  Matches monolith _roadAge L2738. H268: explicit override (from
 *  editor) takes precedence over the hash. */
function roadAgeForRow(row: BaselineRoadRow, override?: RoadAge): RoadAge {
  if (override === 'new' || override === 'old') return override;
  // Row format: [w, maj, name, z, x1, y1, ...]. x1 at index 4, y1 at 5.
  const x = ((row[4] as number) * 100) | 0;
  const y = ((row[5] as number) * 100) | 0;
  let h = Math.imul(x, 0x9e3779b1) ^ Math.imul(y, 0x6a09e667);
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return ((h >>> 0) % 100) < 40 ? 'new' : 'old';
}

/** Returns the cached CanvasPattern for the given road, lazy-building
 *  on first request. The pattern is bound to the supplied ctx — pass
 *  the same ctx every frame (the main game ctx is fine since
 *  drawBaselineRoads is the only caller). */
export function getAsphaltPattern(
  ctx: CanvasRenderingContext2D,
  row: BaselineRoadRow,
  /** H268: optional editor-set per-road overrides. Falls through to the
   *  row-name / first-vertex-hash defaults when undefined. */
  overrides?: { material?: RoadMaterial; age?: RoadAge },
): CanvasPattern | null {
  const material = roadMaterialForRow(row, overrides?.material);
  const age = roadAgeForRow(row, overrides?.age);
  const isMajor = row[1] === 1;

  // Resolve the 8-slot cache key. Each slot lazy-builds its pattern
  // with the correct isMajor flag so makePatternCanvas's oil-spot +
  // drip-trail branch fires for minors but not majors.
  if (material === 'concrete') {
    if (age === 'new') {
      const k = isMajor ? 'concreteNewMaj' : 'concreteNewMin';
      if (!cache[k]) cache[k] = ctx.createPattern(makePatternCanvas(CONCRETE_NEW, isMajor), 'repeat');
      return cache[k];
    }
    const k = isMajor ? 'concreteOldMaj' : 'concreteOldMin';
    if (!cache[k]) cache[k] = ctx.createPattern(makePatternCanvas(CONCRETE_OLD, isMajor), 'repeat');
    return cache[k];
  }
  if (age === 'new') {
    const k = isMajor ? 'asphaltNewMaj' : 'asphaltNewMin';
    if (!cache[k]) cache[k] = ctx.createPattern(makePatternCanvas(ASPHALT_NEW, isMajor), 'repeat');
    return cache[k];
  }
  const k = isMajor ? 'asphaltOldMaj' : 'asphaltOldMin';
  if (!cache[k]) cache[k] = ctx.createPattern(makePatternCanvas(ASPHALT_OLD, isMajor), 'repeat');
  return cache[k];
}

/** Flat base color for a road — used as a fallback when createPattern
 *  fails (it can't on real browsers, but type-narrowing returns null).
 *  Also used by the editor preview at flat-color zoom. H268: same
 *  override semantics as getAsphaltPattern. */
export function getRoadBaseColor(
  row: BaselineRoadRow,
  overrides?: { material?: RoadMaterial; age?: RoadAge },
): string {
  const material = roadMaterialForRow(row, overrides?.material);
  const age = roadAgeForRow(row, overrides?.age);
  if (material === 'concrete') return age === 'new' ? CONCRETE_NEW : CONCRETE_OLD;
  return age === 'new' ? ASPHALT_NEW : ASPHALT_OLD;
}
