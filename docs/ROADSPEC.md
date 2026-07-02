# ROADSPEC — Constructive Lane-Connector Builder

**Product goal (verbatim requirement):** "selecting two lanes, even if 270 degrees apart, it
should recognize the travel direction of the lanes, taper an additional lane, connect them with
a smooth arc. I could draw them in a second."

Two lane-anchor clicks in, DOT-correct connector out: departure taper → parallel run alongside
source → biarc connector honoring BOTH tangents → parallel run alongside destination → closing
gore taper. Loops (90/180/270°+) fall out of the identical code path — **no loop mode, no type
buttons**. Stop/yield are junction-control *flags*, never geometry.

All paths relative to `C:/Users/mcgee/code/Racing-Game-2`. All lengths in tiles.
`LANE_W = 1.275`. Hard rule (memory): every connection is a smooth curve — no gaps, no kinks,
any pass, any z.

---

## 1. INPUT CONTRACT

### 1.1 What a lane click already produces (snap.ts:94-141, 267-372)

The merge-draft snap branch resolves, per click:

| Field | Meaning | Source |
|---|---|---|
| `tx, ty` | snapped point = **chosen lane center** | snap.ts:327-329 (`proj + effSgn·perp·(effLane−0.5)·laneW`) |
| `roadIdx, segIdx` | indices into `getLiveRoadsLight()` (gameLoop.ts:922-939) | H928 shared-enumeration invariant |
| `laneIdx` | 1 = innermost lane | snap.ts `bestLane` + H904 overrides |
| `side` | ±1 vs polyline tangent | snap.ts |
| `travelDir` | `[ux,uy]` unit direction of travel (polyline order if oneway or side ≥ 0, else reversed) | snap.ts:330-334 |
| `lps, oneway` | destination profile hints | snap.ts |

### 1.2 What persists — and the one widening we make

Today `input.ts:771-793` persists only `BondTarget {roadIdx, segIdx, side, laneIdx}`
(editor/index.ts:59-64) into `draft.ptSnaps`; commit passes `ptSnaps[0]`/`ptSnaps[last]` as
`startTarget`/`endTarget` (draft.ts:642-644). `travelDir` is dropped.

**Decision: do NOT widen the persisted BondTarget.** The builder re-derives everything from
`{roadIdx, segIdx, side, laneIdx}` + the live road list (3 lines, same math as snap). This keeps
`ptSnaps`, save rows, and every parity-aware reader untouched — zero migration — and guarantees
the builder and any future rebond pass produce identical anchors from identical targets.

### 1.3 Resolved anchor (builder-internal struct)

```ts
interface LaneAnchor {
  P: [number, number];   // lane-center point at the projection foot (== click snap tx,ty)
  T: [number, number];   // unit TRAVEL direction (re-derived: seg tangent, flipped if !oneway && side<0)
  s: number;             // arc-length station of the foot along the road polyline
  road: RoadLight;       // { pts, w, name, z } from getLiveRoadsLight()
  prof: RoadProfile;     // getRoadProfile(road): { lps, laneW, totalW, centers, laneCount }
  laneIdx: number;       // 1 = innermost (clicked lane)
  side: 1 | -1;          // vs polyline tangent
  segTan: [number,number]; // raw segment tangent (NOT flipped) — needed for _bondInwardDir
  z: number;
}
resolveAnchor(target: BondTarget, roads, getRoadProfile): LaneAnchor | null
```

`resolveAnchor` returns null if the road row is gone/empty (deleted baseline) → builder falls
back to legacy path (§3.2).

### 1.4 Direction & merge-vs-diverge inference — no UI

- **First click = source, second click = destination.** Travel is always source → destination.
  (TM:PE / netedit pattern; RCT rule: the anchors already carry direction, so NOTHING
  directional is ever asked.)
- The two `travelDir`s ARE the Hermite tangents `T0`, `T1` of the connector. Handedness of the
  arc = sign of the wrapped angle from `T0` toward the chord/`T1` — a 270° case is just a reflex
  sweep, same equation (OpenDRIVE has no loop mode either; a cloverleaf loop is an ordinary
  connecting road accumulating 270° of heading).
- **Per-end semantics are fixed, not inferred as a global mode:** the source end is always a
  *diverge* (deceleration context — traffic leaves the source road), the destination end is
  always a *merge* (acceleration context — traffic joins the destination road). This replaces
  the `mergeType`/`mergeAlign` UI meaning entirely; the flag is still *emitted* for format
  compatibility (§3.1) but new rows always encode `mergeType=0, mergeAlign=4`.
- **Stop/yield (`stop.ts`, mergeType 2)**: unchanged, separate feature. Long-term these become
  a `junctionControl: 'stop'|'yield'` sidecar flag on the connector, orthogonal to geometry.
  Out of scope for this builder.
- **Same-z requirement:** both anchors must satisfy `anchor.z === draft z`. Cross-z connections
  remain the bridge-bonding feature (project_bridge_connection_fix) — builder rejects with the
  existing red snap-ring, does not guess.

### 1.5 Validity gates at click time (netedit candidate coloring, staged later)

Reject (red ring): same anchor twice; `|P1−P0| < 3` tiles; z mismatch; destination lane travel
opposing an unavoidable arrival (never actually happens — T1 is *defined* by the clicked lane,
so any pair is geometrically buildable; the only hard geometric reject is the radius floor after
run-shrink, §2.7).

---

## 2. ALGORITHM — constructive build

Entry: `buildConnector(startTarget, endTarget, dW, rampZ, sideOut, deps) → TilePoint[]`
slotted behind the existing dispatcher `_weMergeBondEndpoints(opts, deps)`
(src/editor/merge/index.ts:89-143); commit call site draft.ts:645-662 unchanged.

### 2.1 Constants (AASHTO Green Book, scaled `tiles = ft × 0.017708`)

| Constant | Real basis | Default (tiles) | Clamp | Notes |
|---|---|---|---|---|
| `T_OPEN` departure taper | parallel-entrance min taper 300 ft (50:1 for 12 ft ≈ 600–840 ft) | **5.3** | [3, 8] | ~4:1 in tile space is CORRECT at this scale — do not "fix" to 50:1 (→64-tile taper) |
| `RUN_SRC` decel/parallel run alongside source | TxDOT Table 15-5 decel 140–705 ft | **7.0** | [2.5, 12.5] | diverge side is shorter than accel side |
| `RUN_DST` accel/parallel run alongside destination | Table 10-3 ≈ 1,000–1,170 ft; 600 ft combined floor | **10.6** | [6, 16] | 10.6 = existing `MERGE_ACCEL_TILES` = AASHTO 600 ft floor exactly |
| `T_CLOSE` closing/gore taper | gap-acceptance 300 ft | **5.3** | [2, 6] | render tip-pinch: `min(6, 0.4·total)` — existing GORE_TILES already right |
| `R_MIN` connector radius floor | 25 mph ramp 150 ft | **2.66** hard floor (use 2.7) | prefer ≥ 4.0 non-loop | below floor → re-plan, NEVER kink |
| `R_LOOP` loop radius band | loop ramps 150–250 ft | **3.5** | [2.7, 4.5] | 270° at R=3.5 → arc ≈ 16.5 tiles, fits in-world |
| `SAMPLE_STEP` | — | **0.5** | — | arc sampling; parallel runs follow road polyline joints exactly |
| `MIN_CHORD` | — | **3.0** | — | `|P1−P0| ≥ 3` ⇒ even a full U-turn biarc gives R ≈ |v|/4 ≈ 0.75 > LANE_W/2, so inner-edge offsets can't cusp before the R_MIN check fires |

Aux-lane lateral placement: the added lane sits **outboard of the existing carriageway** —
lane-center offset from road centerline `AUX(prof) = stripe(prof) + LANE_W/2` where
`stripe = prof.laneCount·prof.laneW/2` (probe.mjs `stripeOf`). Its inner edge then lies exactly
ON the outer stripe, which is precisely invariant I2's band.

### 2.2 Step 0 — normalize

1. `A = resolveAnchor(startTarget)`, `B = resolveAnchor(endTarget)`; null → legacy fallback.
2. Same-road check: if `A.road === B.road` and `A.side === B.side`, this is a lane-change /
   offset merge along one road — handled by the same pipeline (runs shrink, connector becomes
   the biarc linear case A3; see §2.5 fallback ladder). No special mode.
3. Compute per-road **offset polylines** `offA(e)`, `offB(e)`: the road polyline offset by
   signed lateral `e` on the anchor's side (`e` measured outboard-positive on `side`). Offsetting
   a polyline = per-segment translate by `e·n̂` + miter joints (clamp miter length ≤ 2·e to kill
   spikes at sharp road joints). This is why arcs/polylines beat beziers here: offsets are exact.

### 2.3 Step 1 — departure ramp along the source road (diverge end)

Laid **downstream** of anchor A by station:

- **Ease-out taper** over `s ∈ [A.s, A.s + T_OPEN]`: drive path follows the source road with
  lateral offset blending from `(A.laneIdx−0.5)·laneW` (the clicked lane center — the H967 tip
  convention, standard.ts:998-1028) to `AUX(A.prof)`, using the cubic smoothstep
  `e(u) = e0 + (e1−e0)·(3u²−2u³)` — the same smooth-wedge shape OpenDRIVE uses for lane-width
  ramps (`width = a+b·ds+c·ds²+d·ds³`). The taper is a WIDTH/OFFSET ramp along the road, not
  bent free geometry.
- **Parallel run** over `s ∈ [A.s + T_OPEN, A.s + T_OPEN + RUN_SRC]` at constant offset
  `AUX(A.prof)`, following the source polyline (curved sources stay parallel — offset curve,
  not a straight extrusion).
- If the source road **ends** before the run completes, clamp the run to available length
  (min `RUN_SRC` clamp low end 2.5; below that, drop the run entirely and keep only the taper —
  "when applicable" in the product goal).
- **Exit pose** `E_A = { point: offA(AUX)(s_exitA), tangent: source travel tangent at s_exitA }`.

### 2.4 Step 2 — arrival ramp along the destination road (merge end), laid backward

Mirror image, laid **upstream** of anchor B by station:

- **Ease-in gore taper** over `s ∈ [B.s − T_CLOSE, B.s]`: offset blends `AUX(B.prof)` →
  `(B.laneIdx−0.5)·laneW`, ending exactly at `B.P` (drive-path tip ON the clicked destination
  lane center — this is what invariant I2′ measures).
- **Parallel run** over `s ∈ [B.s − T_CLOSE − RUN_DST, B.s − T_CLOSE]` at `AUX(B.prof)`.
- Clamp/drop as in §2.3 if the destination road starts too late.
- **Entry pose** `E_B = { point: offB(AUX)(s_entryB), tangent: dest travel tangent at s_entryB }`.

### 2.5 Step 3 — connector: biarc between poses (the "smooth arc")

Primitive choice: **biarc, equal tangent-length construction** (Ryan Juckett derivation).
G1 exact, closed form, exact constant-offset lane edges, exact arc-length sampling, and one
unique positive root for ANY tangent pair — which is exactly why 270° "falls out of the same
math." Clothoids are rejected: Fresnel integrals + Newton iteration in the editor hot path buy
AI-steering smoothness invisible at top-down game zoom. Cubic Hermite/Bezier is rejected: cusps
and self-loops precisely in the reflex/near-antiparallel configs this feature exists for.

Given `P0,T0 = E_A`, `P1,T1 = E_B` (unit tangents):

```
v = P1 − P0;  den = 2(1 − T0·T1);  vt = v·(T0+T1)
d = (√(vt² + den·|v|²) − vt) / den          // unique positive root
Tm = (v − d(T0+T1)) / (2d);  J = P0 + d(T0 + Tm)
segments = [ arcThrough(P0,T0,J), arcThrough(J,Tm,P1) ]
```

`arcThrough(A,Ta,B)`: signed radius `r = |w|²/(2·(n̂·w))` with `w=B−A`, `n̂=perp(Ta)`; center
`O = A + r·n̂`; sweep folded into `(0, 2π)` **in the arc's own turn direction** (`wrapDir`) —
this fold is the entire "reflex support"; no angle special-casing anywhere.

**Fallback ladder (complete, ordered):**

| # | Condition | Action |
|---|---|---|
| F0 | `|v| < ε` | no-op (anchors coincide) — reject at click time anyway (MIN_CHORD) |
| F1 | `den ≈ 0` (parallel same-direction tangents) and chord ⊥ tangents | two semicircles joined at midpoint (S of half-circles) |
| F2 | `den ≈ 0`, target *ahead* (`vt > 0`) | linear case `d = |v|²/(2·vt)` — the classic lane-change S, the single most common merge |
| F3 | `den ≈ 0`, target *behind* (`vt < 0`) | insert side waypoint `W = mid + ½|v|·perp(T0)`, recurse into two biarcs (rare behind-U-turn) |
| F4 | inside `arcThrough`: chord collinear with tangent | straight segment ("anchors already lined up" — near-collinear 0° case; also covers the trivial extension) |
| F5 | any arc radius `< R_MIN (2.7)` | **re-plan, never kink**: lengthen `RUN_SRC`/`RUN_DST` toward clamp max in 25% steps (moves poses apart → grows radius); if still under floor at max runs, shrink runs to min and retry direct; if still failing → reject with red ring + status text ("too tight — move anchors apart") |
| F6 | inner lane-edge offset would cusp (`min R ≤ LANE_W/2 + 0.1`) | subsumed by F5 (R_MIN 2.7 ≫ 0.74); assert only |

Sampling: each arc emitted at `max(6, ceil(len/SAMPLE_STEP))` points; straight segments at their
2 endpoints. G1 at the seams by construction — satisfies the "no kinks" hard rule.

**Angle walkthrough (all the same code):** 0° near-collinear → F4 straight or F2 lane-change S;
90° → two arcs summing 90°; 180° (U-turn) → sweeps sum to π, unique root still positive;
270° (loop ramp) → reflex fold in `wrapDir`, radii land in/above `R_LOOP` band or F5 re-plans.

### 2.6 Step 4 — drive-path emission (what the row stores)

Concatenate: ease-out samples + run-A samples + biarc samples + run-B samples + ease-in samples,
de-duplicating joints (`< 0.05` tile). The result IS the drive path — the lane center a car
actually drives, tips ON the clicked lane centers per H967. This polyline is the builder's
return value through `_weMergeBondEndpoints`; commit rounds coords `toFixed(2)` (draft.ts).

Point budget: ~0.5-tile sampling on a 270° loop (arc ≈ 16.5) + runs + tapers ≈ 80–110 points.
Acceptable row size; Rebuild resampling (§3.3) keeps saves compact.

**Width ramp is NOT emitted** — the laneCentered render branch (taper.ts:448-455, 712) draws a
symmetric ±width/2 band around the polyline with the tip pinch computed from arc length
(`LANE_W/2 · min(1, arc/gore, …)`, standard.ts:1020-1024). Builder guarantees compatibility by
keeping `T_OPEN, T_CLOSE ≥` the render gore length so the visual wedge lands inside the ease
regions.

Sidecar out-params (`sideOut`, MergeSideOut merge/index.ts:75-85 → overlayRoadProps,
draft.ts:705-716):

- `bondInnerStart = _bondInwardDir(A.segTan, A.side)` (keep the existing convention,
  standard.ts:1060-1065 — unit vector from tip toward the road body).
- `bondInnerEnd = _bondInwardDir(B.segTan, B.side)`.
- `laneCentered: true` — **MUST be set**; selects the symmetric-band render.
- additive, ignored-by-all-readers diagnostics: `builderV: 2` (lets Rebuild/QA distinguish
  constructive rows without any parity/format change).

### 2.7 Step 5 — polygon & striping (render-side, contract only)

The builder emits no polygons; `_weBuildTaperedMergeEdges` derives inner/outer edges as exact
±LANE_W/2 offsets of the drive path (offset arc = same center, radius ± e — the biarc payoff).
Contract the builder must honor for the render to be correct:

- Inner edge along run A lies ON the source outer stripe; along run B ON the destination outer
  stripe (this is invariant I2's band `[stripe−0.25, stripe+0.35]`).
- **Dashed channelizing rule: the dashed (crossable) stripe is always drawn on the
  destination-road side of the connector** — i.e. the side `bondInnerEnd` points toward at the
  arrival end and, along run B, the side facing the destination carriageway. The opposite
  (outboard) edge is solid. At the diverge end the gore side facing the source carriageway is
  also dashed over the taper (`bondInnerStart` side), solid past the physical nose. Renderer
  resolves "which side" purely from the two bondInner sidecars — no re-scan.
- Tip pinch to zero width over the render gore length at both tips (existing formula).

---

## 3. COMPATIBILITY — zero migration

### 3.1 Exact output format (unchanged)

- **Row** (draft.ts:666-687): `[w, maj, name, z, mergeFlag, x1,y1, …]` — ODD length is the merge
  discriminator everywhere; `mergeFlag = mergeType·10 + mergeAlign` (`_encodeMergeFlag`
  draft.ts:888-899). New builder always emits `mergeType=0, mergeAlign=4` → flag `4`. Coords
  `toFixed(2)`.
- **Sidecar** `state.overlayRoadProps[String(rowIdx)]`: `{bondInnerStart, bondInnerEnd,
  laneCentered: true, builderV: 2}` — first three exactly as today; `builderV` additive.
- Every downstream consumer keeps working untouched: worldMap.ts:1820-1846 flag decode +
  sidecar copy; worldMap.ts:2568-2687 buildMergePolygons (laneCentered branch); crossings
  exclusion (1920); buildBaselineMap.ts:174-185 tile stamping (polyline IS the drivable line —
  §2.6 guarantees it); traffic.ts:296,498 merge-skip (fields still defined); gameLoop.ts:599-639
  RenderDeps decode; editor render.ts:307; all parity-aware readers (select/delete/draft/snap/
  ui/apply/export/rebuild/storage) — they only need odd length + coords at [5..].

### 3.2 Entry point & dispatch

`_weMergeBondEndpoints(opts, deps)` (merge/index.ts:89-143) keeps its signature. Internal
dispatch:

```
if (opts.startTarget && opts.endTarget && bothResolve && sameZ) → buildConnector (NEW)
else                                                            → legacy path (unchanged)
```

New clicks always carry both targets (input.ts fills ptSnaps from lane snaps), so the builder
takes over all new commits on day one while legacy rows/saves keep their old render fallbacks.

### 3.3 Rebuild Roads regenerates old rows through the new builder (the rebond migration)

Per the planned storage.ts:318-320 migration and probe.mjs `rebuildOnce`:

1. For each odd-parity overlay row lacking `builderV`, take tip points `pts[0]`, `pts[last]`.
2. Re-derive BondTargets by running the same lane-snap math against `getLiveRoadsLight()`
   (nearest road within `totalW/2 + 1`, z-preferring — the worldMap bondedRoadAt radius),
   choosing the lane whose center is nearest each tip; side/travel from projection.
3. Remove the old row FIRST (so the scan can't bond to its own stale copy), re-key later
   sidecars, re-commit through the builder with 4-knot semantic intent discarded — geometry is
   fully reconstructed from the two anchors.
4. Rows whose tips fail to snap (orphaned merges) are left as-is on the legacy render path and
   flagged in the editor status bar count.
5. `laneCenterReverted` (H972, storage.ts:297-360) marker semantics preserved: fresh
   builder commits are authoritative and never re-migrated.

### 3.4 Replaced vs kept

| Fate | Code |
|---|---|
| **Replaced (dead after parity + rebond)** | standard.ts `_detectBondStandard`, `_smoothOneEndBondedStandard`, `_smoothBothEndsBondedStandard`, `_shiftToLaneCenter`, `_pushOutboard`, `STANDARD_SEARCH_R`, `MERGE_ACCEL_TILES` (value survives as `RUN_DST` default); cloverleaf.ts + all loopDiameter plumbing (index.ts:94-105, draft.ts:654, editor/index.ts:87-89,120); taper.ts asymmetric branch (`_buildStandardGoreEdges`, `_computeMergeInnerDir`, bondedRoad*Pts machinery, taper.ts:751 fallback) — **only after** rebond migration; worldMap.ts:2599-2658 bond re-scan — post-rebond; draft.ts null-ptSnaps re-scan fallback |
| **Kept** | types MergeBondTarget/MergeDeps/DestProfile (standard.ts:47-90); `_bondInwardDir` convention; stop.ts (mergeType 2 — separate feature); taper.ts symmetric laneCentered branch (448-455, 712); curves.ts `_hermiteSplineThroughKnots` (used by non-merge fuse, draft.ts:65); H928 enumeration invariant; H967 tip convention; row/sidecar format verbatim |
| **Audit before delete** | curves.ts `_sampleCubic`, `_catmullRomThroughKnots` — grep imports first |

---

## 4. ACCEPTANCE

Harness: `scratchpad/mergelab/probe.mjs` (headless replica of commit + render pipeline on
esbuild bundles of repo HEAD; `checkInvariants` + `rebuildOnce` already implemented).
Per feedback_verify_editor_geometry_by_rendering: every fixture ALSO renders drive path +
inner/outer polygon to SVG for eyeball review; the user's built-exe test is the final gate —
pause for it before stacking commits.

### 4.1 Invariants (numeric, from the merge-matrix audit / probe.mjs)

| Inv | Statement | Tolerance |
|---|---|---|
| **I1** | tip-on-bond (legacy-scan mode): each bonded tip's distance to the destination centerline equals the align-implied offset | dev ≤ 0.35 |
| **I2′** | explicit-target mode: tip distance to the TARGET road centerline = `(laneIdx−0.5)·laneW` (the clicked lane center) | dev ≤ 0.35 |
| **I2** | parallel-run attachment: every inner-edge vertex whose tangent is within 7° of the destination road and within 5 tiles of it sits in the stripe band `[stripe−0.25, stripe+0.35]` from the centerline (`stripe = laneCount·laneW/2`); ends within `i2ExemptArc = 16` (MERGE_TAPER_TILES) of an explicit-target tip are exempt (lane legitimately runs inside the carriageway while easing) | band excess = 0 |
| **I3** | no self-intersection: the closed band loop (outer fwd + inner reversed) has zero proper interior crossings (shared-coordinate tip pinches legal) | 0 hits |
| **I4** | sanity: zero NaN vertices; every polygon vertex ≤ 2.5 tiles from the stored polyline | 0 / ≤ 2.5 |
| **I5** | band width in the middle 40% of arc length ∈ [1.0, 1.45] (LANE_W ± slack) | in range |
| **I6** | rebuild round-trip: `rebuildOnce` (remove row → re-key sidecars → re-commit) yields a row that passes I1–I5 again AND whose tips drift ≤ 0.35 from the previous generation (idempotence) | pass + ≤ 0.35 |

Builder-specific additions (assert in probe, not new invariants):
- **G1 seams**: adjacent sample tangents never turn more than `2·asin(SAMPLE_STEP/(2·R_MIN))`
  ≈ 10.6° per step — catches kinks the polygon tests can miss.
- **Radius floor**: reconstructed discrete curvature along the connector ≥ 1/2.7 nowhere
  exceeded (except inside taper ease regions, which follow the road).

### 4.2 Configuration matrix (every cell must pass I1–I6)

Cross product, pruned to ~120 runnable cells:

- **Angle between anchor tangents**: 0° (collinear extension), 15° (near-collinear), 45°, 90°,
  135°, 180° (U-turn), 225°, **270° (loop)**, 315°. Loops at **90/180/270 must pass the same
  invariants — no loop-specific assertions, no loop mode.**
- **Road widths** (profile classes, probe `profileFor`): w=2 oneway (lps 1), w=6 (lps 2),
  w=8 (lps 3), w=12 (lps 4 + median), name='I-485' (lps 3, median).
- **Side/lane**: near-side vs far-side anchors; laneIdx 1 (inner) and outermost lane; oneway vs
  two-way travel-flip cases (side < 0).
- **Topology**: distinct roads; same road same side (lane-change S, fallback F2); same road far
  ends (loop back onto self); curved source (multi-joint polyline) vs straight; road ends
  mid-run (clamped run); chord lengths 3 (MIN_CHORD), 10, 40 tiles.
- **Fallback exercises**: parallel-same-dir perpendicular chord (F1), target-behind (F3),
  collinear (F4), forced radius-floor re-plan (F5: anchors 3.2 tiles apart at 270°).

### 4.3 Fixture bank renders

Each matrix cell dumps `mergelab/fixtures/<cell>.svg` (drive path, inner/outer edges, dest road
stripes, bondInner arrows, radius annotations). Regression: SVGs are diffed run-over-run on
BOTH pipelines (editor render + game worldMap) per project_road_recovery_plan's
visual-regression gate. A curated 12-fixture "golden" sheet (one per angle bucket + the three
nastiest fallbacks) goes in the PR description for eyeball sign-off before the built-exe test.

---

## 5. RISKS & STAGED ROLLOUT

One commit per turn (feedback_migration_commit_cadence); each stage sized for one engineer,
one sitting; builder ships dark behind the existing entry point; old path deletable only after
parity. Save format stays H (no version bump — service/repair audit ruling applies generally).

| Stage | Commit | Content | Gate |
|---|---|---|---|
| 1 | H9xx | `src/editor/merge/builder.ts`: LaneAnchor resolve + biarc module + fallback ladder, pure functions, NO wiring. probe.mjs matrix + SVG fixtures green headless. | probe pass + golden SVGs eyeballed |
| 2 | H9xx+1 | Dispatch in `_weMergeBondEndpoints`: both-targets → builder, else legacy. Emit row/sidecar per §3.1. | probe both paths; **PAUSE for user built-exe test** (feedback: check build SHA first) |
| 3 | +2 | Editor ghost preview after click 1: full built geometry (taper→run→arc→run→taper) hovers each candidate anchor before click 2 (the #1 UX lesson — never commit-to-see-curvature). Red-ring rejects (§1.5). | user in-game feel test |
| 4 | +3 | Post-confirm micro-overrides on the committed connector only: run-length slider + "flip arc side" toggle for the ambiguous near-180 case (Node Controller lesson: auto-generate first, tiny knobs after, never front-load parameters). | user |
| 5 | +4 | Rebond migration wired into Rebuild Roads + storage load (§3.3); orphan count surfaced. | I6 across user's exported world (permanent fixture per road-recovery plan) |
| 6 | +5 | Deletion sweep of §3.4 replaced code + cloverleaf UI removal. | full probe matrix + visual-regression diff on both pipelines |

**Risks**

1. **Near-180° side ambiguity** — biarc picks a side; the user may want the other bow. Mitigant:
   flip toggle (stage 4), never "click differently" (TpF2 horseshoe complaint).
2. **Curvature step at the biarc joint** (G1 not G2) — invisible at game zoom per research; if AI
   traffic steering ever stutters there, swap the connector stage for spiral–arc–spiral later;
   the stage boundary poses are already clothoid-ready (this is exactly OpenDRIVE's recipe).
3. **Offset-polyline miter spikes** on sharp source/dest joints — miter clamp ≤ 2·e + I3/I4
   catch escapes; fixtures include a zig-zag source road.
4. **Run placement past road ends** — clamp/drop rules (§2.3/2.4); fixture "road ends mid-run".
5. **Radius-floor rejects frustrating in tight quarters** — F5 auto-lengthens runs first; reject
   message names the fix ("move anchors apart"); loop band default 3.5 keeps 270° compact.
6. **Legacy saves during the window between stage 2 and 5** — dual-path render preserved;
   `builderV` cleanly separates populations; H972 `laneCenterReverted` semantics untouched.
7. **Traffic lane-graph future** — will want travel direction on rows; plan: additive sidecar
   (`travelStart/travelEnd` unit vectors) in the lane-graph phase, not now; format stays put.
8. **Row point-count growth** (~110 pts on big loops) — measured against export size in stage 1;
   if needed, adaptive sampling by curvature (straights at 2 pts) halves it with zero visual cost.
