# physlab — headless driving-feel harness

Runs the LIVE Phase 0B integrator (`src/physics/phase0BIntegrator.ts`) in
plain node with no game loop, no DOM, no test framework, and measures
handling-feel metrics on scripted scenarios. Built for H1059 (the
rubber-band-to-camera fix); use it before/after ANY handling change.

## Run

```sh
# from repo root — rebuild the bundle after EVERY physics source edit
npx esbuild tools/physlab/entry.ts --bundle --alias:@=./src --format=esm --outfile=tools/physlab/physlab.mjs
node tools/physlab/feelmetrics.mjs mylabel   # -> feel_mylabel.json + console summary
```

## Scenarios & metrics

| Scenario | What it probes |
|---|---|
| A_gentle60 | steady 0.5-steer corner @60 mph + release — everyday cornering |
| B_fulllock60 | full-lock corner @60 mph + release |
| C_ebrakeSlide40 | e-brake yank @40 mph then hands-off — slide-catch / spin honesty |
| D_straight | 5 s straight-line @60 mph — longitudinal regression guard (must stay flat) |
| E_flick60 | left-right flick @60 mph + release — slide momentum & recovery |

Release metrics: `slipTau_s` (time for body slip to fall to 1/e),
`settleTo0p3deg_s`, `yawTau_s` (rotation decay — the "does the car carry
momentum" number), `overshootDeg`, `residualCamOffsetDeg` (sprite-vs-camera
angle left to unwind once yaw is dead — the visible "snap-back" the player
sees; camera follows heading per H1060 camera redesign).

## Reference targets (from the H1059 audit's reference research)

- Release-straighten tau: 0.4–0.6 s = NFS Blackbox feel, 0.8–1.0 s = pure
  real (caster/SAT). NEVER < 0.3 s — reads as scripted.
- Yaw response tau at highway speed: 0.15–0.30 s.
- Peak road-tire slip: 6–10°; linear region < ~3°.
- H1059 baseline numbers live in git history (commit message) — the "before"
  numbers were: gentle-corner release slipTau 0.25 s, flick release slipTau
  0.35 s with yawTau 0.10 s (rotation frozen in one tenth of a second — the
  rubber-band signature).

## Gotchas

- `CAR_CATALOG` is keyed by slug id; `GT4_SPECS` by full car name.
- Settings numeric overrides use 0 = "use internal default" (adapter
  convention) — do not pass the documented defaults directly.
- Keep speed above `BICYCLE_MIN_SPEED` and use a GT4-rowed, non-bike car or
  the integrator's eligibility bail leaves state frozen.
- Pin `state.pGear` / `state.pRpm` for constant-speed tests (gear/RPM are
  gameLoop-owned in the real game).
- In-game, gameLoop RESTORES pSpeed after each tick (arcade scalar owns
  longitudinal) — the harness lets pSpeed evolve, which is fine for lateral
  metrics; scenario D guards the difference.
