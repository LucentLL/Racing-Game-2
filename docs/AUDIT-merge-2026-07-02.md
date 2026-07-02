# Merge-geometry audit — 2026-07-02 (HEAD ≈ H979/H980)

Numeric sweep of the merge commit+render pipeline via the real modules
(esbuild bundles, scratchpad mergelab/probe.mjs). Invariants: I1 tip-on-bond,
I2 run-edge-in-stripe-band (I2' = tip at explicitly clicked lane), I3 no
self-intersection, I4 sanity, I5 full lane width, I6 rebuild round-trip.
Classes: A alongside-straight, B 90° two-road connector, C 45° connector,
D one-end ramp. Repro inputs for every failure are in the slice JSONs
(mergelab/out-std-auto.json, sweep-out.json, sweep_results.json,
sweep-rebuild-pass.out.json).

## Confirmed defect classes (all in code the ROADSPEC builder replaces)

1. **Two-road connectors self-intersect on first commit** — every B and C
   cell, all widths: 8–30 polygon fold crossings (I3). Yield (mt=3) worst.
   Small folds cluster at the gores; reads as flipped dashes/taper.
2. **Lane-click targets are ignored at the tip** — explicit outer/inner/far
   BondTargets all land the tip at the STRIPE (2.460 for w=6) instead of the
   clicked lane center (expected 1.912 outer / 0.637 inner). The user "always
   selects the outer lanes" — it never had an effect. Far-side targets also
   self-intersect (I3).
3. **One-end ramps snap the bonded tip to the road CENTERLINE** — D cells:
   tip at 0.000 from centerline, expected outer-lane ~2.46/3.81/5.11 by
   width; polygon reaches the middle of the destination road ("lane dives
   into the road").
4. **Loosely drawn alongside lanes never clamp to the stripe** — std A-w6
   cells: inner edge 4.15 vs band ≤2.90 (dev 1.25). Draw a lane slightly too
   far out and it floats there; the yield-slice A cells drawn at exactly
   2 tiles pass. Placement forgiveness is ~0.
5. **Rebuild Roads drifts every merge outboard ~+0.35 tiles per press**
   (I6, systemic on both-ends-bonded rows; +1.35 observed after the loose-A
   case). Rebuild in its current form DEGRADES merges — do not use it as the
   migration vehicle; the ROADSPEC rebond (re-derive anchors, rebuild
   constructively) replaces it.

## What passes (post-H979/H980)

- A alongside lanes drawn near the stripe: all invariants, both sides,
  first commit.
- D ramps at w=2 one-way destinations: all invariants incl. rebuild.
- I5 (full lane width) passes everywhere — the needle era is over.

## Disposition

No further patches to standard.ts/taper.ts branches. All five classes are
acceptance cells for the constructive builder (docs/ROADSPEC.md):
I1+I2' kill #2/#3, I3 kills #1, construction-from-anchors kills #4
(placement is derived, not drawn), rebond idempotence (I6 ≤0.35 drift)
kills #5. Coverage gaps NOT audited: cloverleaf (mt=1), stop (mt=2),
z≥2 cross-z merges, draft-preview-vs-commit parity — carried as builder
acceptance cells too.
