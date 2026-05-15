# Changelog

All notable changes to **Driver City — GBC Racer** are documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased] — 9.0.0-alpha

**Theme: Modularization for store-cert readiness.**

The 51,105-line single-file HTML build is being split into a modular Vite +
TypeScript project so the game can target Steam (via Tauri) and Google Play
(via Capacitor). The migration is structural — no gameplay changes from the
last 8.99.126.x build during this phase. See `MIGRATION_PLAN.md` for the
audit + phase plan.

### Added
- Vite 5 + TypeScript 5 build pipeline with `@/`-aliased imports, asset
  hashing via `public/`, ES2022 target, sourcemaps.
- 17 modular source trees: `engine/`, `state/`, `save/`, `input/`, `sim/`,
  `render/`, `physics/`, `world/`, `ui/`, `editor/`, `config/`, `styles/`,
  `platform/`. Each captures the v8.99.x-era archaeology in type-level
  contract docstrings.
- World Editor dev-gate (`LIFE.devToolsEnabled`, default `false`). The F9
  editor, entry button, and tap-to-enter are hidden from production builds
  unless the user opts in via Options → Advanced. Cert reviewers and
  screenshot capture don't see the editor.
- Production-build dead-code stripping: `__DEV__` Vite define + esbuild
  `pure` list drop diagnostic logs, perf overlays, and debug keybindings
  from shipped bundles without affecting `console.warn` / `console.error`.

### Changed
- Save format migrating to v9 with backward-compatibility read of v8.x
  shapes (`LIFE.portrait`, `LIFE.meals`, etc. normalized on load).
- Assets relocated from raw GitHub URLs into `public/sprites/`,
  `public/audio/`, etc. (mandatory for store-cert; Play Store disallows
  runtime fetching of executable/asset content from non-CDN sources).

### Removed
- Dead `placeGasAlongI485` commented-out IIFE (66 lines + 15-line tombstone)
  and legacy `STEER_DEAD_ZONE` constant (zero usages).

### Notes
- During alpha, the monolithic source `driver_city_charlotte_v8_99_126_89.html`
  remains the live runtime. The modular `src/` tree provides type contracts
  and architectural scaffolding; function bodies port from the monolith
  incrementally during a post-scaffolding phase.

---

## Prior versions (8.x monolithic era)

The 8.x line was built iteratively over ~2 months inside the Claude.ai app
(not Claude Code) from a blank HTML file to a 51,105-line single-file
codebase. Per-version change rationale is preserved as inline `// v8.X.Y:`
markers throughout `driver_city_charlotte_v8_99_126_89.html` (~1,374 entries
across the file). Those markers are not extracted into this file — they're
fine-grained developer-facing rationale, not user-facing changelog content
— but the major eras below summarize them at a usable level.

### [8.99.126.x] — Editor + render-fidelity era

Most recent monolithic-development era. Focused on bringing the World
Editor to feature parity with the source-defined road system and fixing
visual artifacts at merge-polygon edges.

- **v8.99.126.46–.47**: Baseline (permanent) road editing. Source-defined
  roads (I-485, Trade St, Tryon St, etc.) became selectable + vertex-editable.
  Edits persist to localStorage in a separate key from the overlay so a
  corrupted overlay save cannot take baseline edits with it. Whole-road
  delete via index-preserving placeholder; Section-mode split; Point-mode
  vertex remove.
- **v8.99.126.50**: Per-road and per-segment material + age decoupled from
  road class. Asphalt vs concrete, new vs old vs auto (age='auto' falls back
  to road-level). Section sub-mode writes per-segment overrides.
- **v8.99.126.53**: Stop vs Yield merge types split. Stop = perpendicular
  T-intersection landing (W.T. Harris Blvd reference); Yield = parallel-
  then-taper extension into cross-road flow lane (DOT MUTCD model).
- **v8.99.126.59**: One-click `➕ Lane` preset for tapered auxiliary-lane
  drafting.
- **v8.99.126.64–.65**: Tapered merge polygon stripe-inset (1.7/TILE) and
  `joinedTangent` parameter eliminated visible perpendicular + angular
  gaps at width-mismatched road junctions.
- **v8.99.126.00–.45**: Initial merge ramp system (`mergeType`,
  `mergeAlign`). Standard / Cloverleaf Loop / Stop types with per-type
  bond-endpoint pipelines. Lane-edge-stripe snap (v126.26) replaced the
  prior lane-center snap so taper polygons add an auxiliary lane outside
  the destination's outermost lane rather than physically occupying an
  existing lane.

### [8.99.125.x] — Bridge + physics polish

Small era focused on bridge layer-transition logic and a handful of
physics interactions. Two patch versions (v125.00, v125.01).

### [8.99.124.x] — Water, polygon, mobile-input era

- **v8.99.124.22**: World Editor tile-rendering pass with adaptive stride
  (~80k iteration cap regardless of viewport × zoom).
- **v8.99.124.25**: Width-aware snap radius. Pre-v124.25, clicks on wide
  highways (w=12, ~10-tile asphalt) landed outside the 2-tile snap window;
  per-road threshold now scales with `r.w`.
- **v8.99.124.26**: Mobile hover-tile fix for draft preview. Anchoring
  `hoverTile` to the just-placed point eliminated the giant preview
  triangle stretching to world (0,0) on touch devices.
- **v8.99.124.28**: Rivers (polylines) and lakes (closed polygons) added
  to the World Editor. Both soft-stamp tile=9 (water) so existing roads
  and structures crossed by user-drawn water survive intact.
- **v8.99.124.30**: Arc mode for road / river drafts. Curve bakes into
  the stored polyline at commit so render and physics see it as a longer
  polyline — no schema change.
- **v8.99.124.31**: Snap pass considers the row's own opposite endpoint
  as a candidate so near-closed loops snap shut cleanly.
- **v8.99.124.32**: Editor keyboard handler bails on text-input focus —
  Backspace stopped intercepting deletes in Curve/Name/Z fields.
- **v8.99.124.39**: Stacked-bridge Z clamp bumped 3 → 10.

### [8.99.123.x] — Mobile rotational steering + HUD relocation

- **v8.99.123.30+**: Mobile steering switched from x-axis bar to rotational
  wheel. Inner deadband for hub-grab; ±165° max rotation.
- **v8.99.123.55–.97**: Steering wheel SVG simplification — spokes removed,
  RPM gauge interior re-styled, gear-text moved to shift-knob pill.
- **v8.99.123.97**: Gas + temp gauges relocated from wheel OD onto the
  mobile RPM SVG (temp, cyan) and speedo SVG (fuel, orange).

### [8.99.122.x] — Stabilization era

- **v8.99.122.42–.46**: Save format consolidation. `LIFE.portrait` and
  `LIFE.meals` deprecated (preserved on import, dropped on write).
- **v8.99.122.50–.97**: Sprite manifest, vehicle sprite loader, asphalt
  pattern canvases, downscale buffer.
- **v8.99.122.76+**: Engine audio + V8 sample-loop crossfade, tire grain
  scheduler, crash sound bank.

### Pre-122 (v8.0–8.99.121)

Foundational era. Major systems introduced:

- v8.32: Cruise control as HTML button (replaced canvas hit-test).
- v8.50–8.80: Physics + tire + steering tuning passes.
- v8.87: Procedural city-grid generator removed in favor of hand-drawn
  minor roads.
- v8.95–8.99: World tile system, road profiles, GBC pixel-art water,
  V2 car renderer + 14-car generation database (Civic / RX-7 / Skyline /
  Supra / Evo / Impreza / Focus), save persistence, jobs + finance,
  fault + repair system, World Editor (initial cut).

For per-marker detail of any of the above, see:
1. **Type-level docstrings** in `src/**/*.ts` — these capture the
   why-was-it-built-this-way at module contract boundaries.
2. **The monolithic source file** at the root of the repo
   (`driver_city_charlotte_v8_99_126_89.html`) — every inline `// v8.X:`
   marker remains in place as archaeology during the modularization.
3. **Git history** — all changes from this repo onward are commit-tracked.

---

## Source

The pre-9.0 codebase was a single-file HTML build. That file is preserved
at the repo root and serves as the runtime during the modularization phase.
The modular `src/` tree replaces it incrementally — once body porting
completes, the monolithic file will be removed and this changelog will
become the single source of truth for version history.
