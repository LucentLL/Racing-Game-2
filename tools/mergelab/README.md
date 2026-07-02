# mergelab — merge-geometry audit harness

Numeric invariant harness + sweep runners behind docs/AUDIT-merge-2026-07-02.md.
Runs the REAL editor modules headlessly in node.

## Rebuild the module bundles first (not committed — build artifacts)

```bash
cd <repo>
npx esbuild src/editor/draft.ts        --bundle --alias:@=./src --format=esm --outfile=tools/mergelab/draft.mjs
npx esbuild src/editor/merge/index.ts  --bundle --alias:@=./src --format=esm --outfile=tools/mergelab/merge.mjs
npx esbuild src/editor/merge/taper.ts  --bundle --alias:@=./src --format=esm --outfile=tools/mergelab/taper.mjs
```

## Run

```bash
node tools/mergelab/smoke.mjs            # 2 known-good cases must pass
node tools/mergelab/sweep-std-auto.mjs   # etc. — each sweep writes JSON
node tools/mergelab/diag_drift.mjs       # minimal repro: rebuild drift (+0.35/pass)
node tools/mergelab/diag_target.mjs      # minimal repro: lane-click target ignored
```

probe.mjs API: mkWorld / commitPlainRoad / commitMergeDraft / buildPolygon /
checkInvariants (I1 tip-on-bond, I2 stripe band, I2' clicked-lane tip,
I3 self-intersection, I4 sanity, I5 lane width) / rebuildOnce (I6) / injectRow.

Slice results committed alongside: sweep_results.json (yield+oneway),
out-std-auto.json, sweep-out.json (lane-click I2'), sweep-rebuild-pass.out.json.
These are the acceptance cells for the docs/ROADSPEC.md constructive builder.

# fixtures/maps + tools/maps

fixtures/maps/world_{hw77,hw485,minor,water}.json — the source maps
(Maps/*.png) vectorized and registered to world tile coords
(similarity: scale 1.19862, rot ~0, tx -1066.485, ty -109.951;
residuals vs hand-traced baseline: I-485 mean 0.79 tiles, I-77 mean 1.36).
Raw image-space traces + landmarks + fit_summary.json included.
tools/maps/*.py — re-runnable tracing/registration scripts (py -3; needs
numpy + Pillow; skeletonization is self-contained Zhang-Suen).
Pending before baseline regen: underpass gap-welds (join near-collinear
minor endpoints whose connector crosses a highway trace), boundary crop
decision (minor/water extend past the 2500-tile world), QC overlays.
