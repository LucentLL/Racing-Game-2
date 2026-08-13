# Real-road findings — Charlotte OSM analysis (OSM-A)

Measured from the raw OpenStreetMap Charlotte extract (`tools/osm/analyze.mjs`,
2026-08-12; data © OpenStreetMap contributors, ODbL). All lengths in **real
meters**, with conversions to **true-scale tiles** (÷2.8687) and **1:6 layout
tiles** (÷17.212) — the city map's compression. These numbers are the reference
for editor presets and the ROADSPEC/merge constants; cite this file when tuning.

Percentiles are p10 / **p50** / p90 over the measured population (n).

## 1. Ramps (1,196 welded `_link` chains)

| metric | real m | true tiles | 1:6 tiles |
|---|---|---|---|
| ramp length (n=1196) | 50 / **135** / 706 | 47 @p50 | **7.9 @p50** |
| loop ramp length (n=64) | 266 / **369** / 776 | 129 | 21.4 |
| loop min radius (n=64) | 28 / **40** / 55 | **13.9** | 2.3 |
| directional-ramp min radius (n=1020) | 17 / **48** / 208 | 16.7 | 2.8 |

- The AASHTO "loop min radius 150 ft (~46 m)" rule shows up almost exactly
  (p50 40 m, p90 55 m). The connector builder's loop band (2.7–4.5 tiles,
  default 3.5 @ 1:6) brackets the real p50 of 2.3 — slightly generous, fine.
- Only **64 of 1,196** ramps are loops (5%). Directional/diamond ramps dominate;
  the editor's default ramp preset should NOT be a loop.
- Ramp lengths are wildly right-skewed (p90 = 5× p50): flyovers at system
  interchanges are ~700 m+. One fixed editor ramp length is wrong; a
  click-to-click length with a **minimum** (~50 m real / 3 tiles @1:6) matches
  the data.

## 2. Acceleration / auxiliary lanes (127 spans on motorways)

| metric | real m | true tiles | 1:6 tiles |
|---|---|---|---|
| aux-lane span length | 104 / **209** / 688 | 72.8 | **12.1** |

The merge builder's compressed run constants (parallel ~10 + taper ~12–16
tiles) were chosen by feel in H911–H921; real Charlotte measures **12.1 tiles
@p50 at 1:6** — the compressed constants are empirically right at city scale.
DOT-true (127 tiles) remains correct only for a future 1:1 map.

## 3. Divided roads — carriageway separation (centerline-to-centerline)

| class | real m p10/p50/p90 | note |
|---|---|---|
| motorway (n=9649) | 0 / **21** / 30 | grass/cable median, I-485 style |
| trunk (n=2636) | 0 / **17** / 28 | |
| primary (n=7107) | 0 / **11** / 19 | mostly raised concrete median |
| secondary (n=8549) | 0 / **8** / 16 | narrow median / TWLTL conversions |

- p10 = 0 means jersey-barrier sections where carriageways nearly touch.
- Game mapping: motorway → w=10/12 (grass/jersey), divided arterial → w=11
  (asphalt median) matches the 8–21 m real medians well at 1:6.

## 4. Traffic signals (1,159 signalized locations after clustering)

| metric | real m | 1:6 tiles |
|---|---|---|
| spacing, downtown grid (n=90) | 141 / **159** / 268 | **9.3** |
| spacing, citywide (n=1158) | 172 / **341** / 811 | 19.8 |

Signal every ~9 tiles downtown, ~20 tiles on arterials (1:6). The importer
emits these as authored `'isect'` rows — 1,113 signals, 1,257 stops, 19 yields.

## 5. Lane counts (the big model gap)

Share of tagged ways by total lane count:

| class | 1 | 2 | 3 | 4 | 5 | 6+ | lanes= coverage |
|---|---|---|---|---|---|---|---|
| motorway (per carriageway) | 5% | 13% | **33%** | 32% | 14% | 3% | 100% |
| primary | 1% | 34% | **32%** | 21% | **9%** | 2% | 95% |
| secondary | 6% | 38% | **32%** | 17% | **7%** | 1% | 84% |
| tertiary | 13% | 43% | 34% | 9% | 1% | — | 66% |

- **3-lane (2+center-turn) and 5-lane (4+center-turn) arterials are ~40% of
  Charlotte's primary/secondary mileage** — the signature Carolina arterial.
  The current w-ladder (2/4/6/8 total, symmetric) cannot represent them; they
  currently quantize to 4-lane. This is the strongest data argument for OSM-F
  (real lane counts + a center-turn-lane render style).
- Motorway carriageways are 3–4 lanes each at p50 → merged duals map to
  w=10/12 correctly.

## 6. Speed limits (maxspeed= coverage 37–96%)

Dominant per class: motorway **70** (then 55–65 near interchanges), trunk
**45–55**, primary **45**, secondary **35–45**, tertiary **35**. The current
name-prefix table (I-* → 65–70, else 35–45) is close for highways but flattens
arterials; imported per-road values (OSM-E) fix ~60% of roads outright and
class-default the rest.

## 7. Turn-lane patterns (`turn:lanes`, top of 12)

`left|none|none` · `left||` · `left` · `none|none|right` · `||right` ·
`left|through|through` · `left|through|through|right` — **left-turn pockets
dominate** (~3:1 over right). Editor turn-bay presets should default to a LEFT
pocket; the intersection `turnMask` renderer (deferred H-D) should draw left
arrows first.

## 8. Bridges

Bridge spans p50 ≈ **53–60 m** (~3.1–3.5 tiles @1:6) uniformly across classes;
p10 ≈ 20–27 m (~1.2–1.6 tiles). Per-section bridge splitting (z-runs from
`bridge=`/`layer=`) is the right model — full-length z=4 highways (current
baseline convention) overstate elevation ~10×. The build's `Z_RUN_MIN_TILES =
1.5` absorbs the shortest p10 spans; lower it if underpass fidelity matters.

## Import pipeline numbers (build.mjs, 2026-08-12 run)

18,558 ways fetched → 20,346 junction-split segments → 11,323 welded chains →
1,527 merged dual-carriageway chains (4,724 one-way halves consumed) → 7,481
final rows / 23,353 verts. Ramp tips snapped onto highways: 1,995 (1,361 tips
end at surface streets/other ramps — expected). Class tiers: motorway 490 +
trunk 257 + primary 977 + secondary 1,931 + tertiary 2,243 + ramps 1,583.
A row budget for OSM-B: motorway+trunk+primary+ramps ≈ **3,307 rows** —
already ~28× today's 120-entry city; the spatial index (OSM-D) is not optional.
