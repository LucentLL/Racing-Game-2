# Driver City — Session Handoff & Work Queue

> **Purpose:** let a fresh Claude Code session execute the open work below with no
> prior chat context. Written 2026-07-11. Anchors are `file:line` from recon done
> this session; line numbers drift — re-grep the named symbol if an anchor misses.
>
> Read the auto-memory index first (`memory/MEMORY.md`); the per-topic memory
> files it links carry the durable "why". This doc is the executable queue.

---

## 0. Orientation (do this once per fresh session)

- **Repo:** `C:\Users\mcgee\code\Racing-Game-2` — a ~110k-line TypeScript top-down
  racing game (Canvas 2D), Vite dev server, ships to GitHub Pages (mobile test loop)
  + Tauri (Windows exe) + Capacitor (Android).
- **Dev server:** `npm run dev` (Vite, port **5173**). Typecheck: `npx tsc --noEmit`.
- **Dev handle:** in DEV builds, `window.__dc = { ctx, mainCanvas, pcCanvas, hudCanvas, ... }`
  — `window.__dc.ctx` is the live `GameContext` (player, life, traffic, clock, home, menu…).
- **World scale:** `TILE = 18` px, map 2500×2500 tiles. `pAngle` 0 = east (`arcadeUpdate.ts`).
- **Perf HUD:** `import('/src/engine/perfHud.ts').perfSnapshot()` returns per-phase EMA ms.

### Cadence & rules (from memory — non-negotiable)
- **One `H<n>` commit per turn.** Never one-shot a whole phase. Current tip is **H1140**;
  next new commit is **H1141**. (H-numbers are reused across tracks — just pick the next free.)
- **Always push after every commit** (`git push origin main`) — Pages redeploys the phone
  build. No asking. Then **announce the next H commit** so the user can steer.
- **Every commit is verified before pushing** — typecheck + drive the actual flow headless
  (see §1). Screenshots/measurements in the reply, not "should work".
- **Feel rules:** never bank/dive/shake the world camera for feel (`memory/feedback_no_camera_motion_cues`).
  Run physlab probes before ANY motion/physics change (`memory/project_driving_feel_overhaul`).
- **Parity vs invention:** most systems are 1:1 ports from the monolith
  (`driver_city_charlotte_v8_99_126_89.html`) — check it before inventing behavior.
- **LFS gotcha:** `public/**/*.png` + `public/audio/*.wav` are Git-LFS-tracked; after
  committing assets confirm real bytes (`ls -la`, KB not ~130-byte pointer stubs).

---

## 1. The headless verification harness (reused by every gameplay commit)

There is no committed harness — it lives in the session scratchpad and is recreated
each session. Recipe:

1. **Launch headless Edge with CDP** (Chrome/Edge, port 9222):
   ```
   "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" --headless=new \
     --remote-debugging-port=9222 --user-data-dir="<scratch>/edgeprofile" \
     --disable-background-timer-throttling --window-size=1280,800 about:blank &
   ```
2. **`cdp.mjs`** — minimal CDP client over Node's built-in `WebSocket`: `connect()` →
   `{ eval(expr, awaitPromise), waitFor(expr, ms), navigate(url), screenshot(path) }`.
   (`Runtime.evaluate` with `returnByValue`; poll `http://127.0.0.1:9222/json` for the page target.)
3. **Fake gamepad** (drive menus/flow without a real pad):
   ```js
   window.__pad = { b: Array(17).fill(false), a: [0,0,0,0] };
   navigator.getGamepads = () => [{ id:'FAKE (STANDARD GAMEPAD)', index:0, connected:true,
     mapping:'standard', timestamp:0,
     get buttons(){ return window.__pad.b.map(p=>({pressed:p,touched:p,value:p?1:0})); },
     get axes(){ return window.__pad.a; } }];
   window.__press = (i,ms=250)=>new Promise(r=>{window.__pad.b[i]=true;
     setTimeout(()=>{window.__pad.b[i]=false;setTimeout(r,250);},ms);});
   ```
   Button map: 0=A, 1=B, 3=Y, 4=LB, 5=RB, 7=RT(gas), 6=LT(brake), 8=Back, 9=Start,
   12-15=dpad U/D/L/R. Axes 0=LX steer, 1=LY, 3=RY.
4. **New-game flow:** Start(9) on title → fill `#driverNameInput`/`#driverAliasInput` +
   click `#driverNextBtn` → A(0) on jobSelect → A(0) on carSelect → `ctx.gameState==='playing'`.
   Close the spawn Home overlay: `ctx.home.open=false`. For daylight: `ctx.clock.timeOfDay=0.5`.
5. **Drive/teleport:** set `ctx.player.px/py/pAngle`, hold gas via `__pad.b[7]=true`.
   Force job state directly on `ctx.life` (see per-task notes). Read state back with `eval`.
6. **Perf A/B:** `git stash push <file>` (Vite HMR reloads) → measure baseline → `git stash pop`.

**Gotchas:** a fresh module `import('/src/…')` in a probe may get a *different* instance
than the game's HMR-timestamped one (module state reads empty) — re-navigate or read via
`window.__dc`. Vite recompiles race the flow; if a probe throws null, just re-run.

Video reference frames: `ffmpeg -i in.mp4 -vf "fps=1,scale=960:-1" out_%02d.png` then
Read the PNGs (the model can't play video but can decode frames). 4K phone captures scale ×4.

---

## 2. Shipped this session (context for the open work)

| H | SHA | What |
|---|---|---|
| H1110 | b92c40a | Gamepad menu block: Start/Y/B/Back toggles, LB/RB+dpad tab paging, dpad/stick scroll |
| H1111 | 8934d59 | OPT "Drive Side" LHD/RHD/Manufacturer + RHD pad e-brake mirror (A→dpad↓) |
| H1112 | 437e0cf | Home-menu controller nav + `src/ui/focusNav.ts` (spatialNav + drawFocusRing) |
| H1113 | f0c66dd | Lock out sub-100HP cars (bikes + '79 Civic exempt) via `isCarAccessible`/`ACCESSIBLE_CAR_IDS` |
| H1114 | d0841da | Wind-sway grass (pre-baked phase frames) |
| H1115 | de1bb8e | PSX clump-grass retexture + meadow tints + flowers |
| H1116 | 262a384 | Cloud shadows (`src/render/cloudShadows.ts`, baked noise, `disableCloudShadows`) |
| H1117 | 55efcf0 | Grass flattened by cars (`src/render/grassFlatten.ts`, `addGrassFlattenStamp` generic API) |
| H1118 | bcd033f | Lush meadow rebake + visible clouds |
| H1119 | 998fe8a | Canopy second-pass layer (dissolves the tile grid) |
| H1120 | edeecf1 | ToonWater rework (`src/render/water.ts`) |
| H1121 | e2183f1 | Shoreline blend + no ruts-on-water + dithered tint borders |
| H1122 | 8ccae8a | Grass under road tiles (partial fix for blank road margins) |
| H1125 | 1c3a00b | Cop radar survives bumps/creep while parked |
| H1126 | 13eb5cd | Cop pull-over by pursuit ('yielding' phase) + closed the A/B shift bypass |
| H1127 | 4e843e0 | DeliveryTask abstraction: `sim/jobTargets.ts` resolver + `ARRIVAL_SPECS` table |
| H1128 | 2539ccf | FUEL TANKER live: depot→station, tanker trailer hook/drop, fuel top-up, markers |
| H1129 | 6579e7c | TOW TRUCK live (winch/haul/drop) + tow/cop render libs wired onto the live path |
| H1130 | a59a5e5 | Incoming tow truck follows roads (`sim/roadPath.ts` A*, straight-line fallback) |
| H1131 | 89a7f43 | Trailer FEEL live: accel ×0.82 both paths, arcade steer ×0.41, 0B intent threaded |
| H1132 | dddfcd1 | Sun rays through cloud gaps + `cloudCoverAt/cloudShadeAt/sunAt` sampler API |
| H1133 | 1724b4a | Cars catch sunlight + cloud shadows (`render/carLighting.ts`, glint + shade) |
| H1134 | d2e9a4d | Water sun glitter in cloud gaps (muted under cloud, same kill switch) |
| H1135 | 1f9e11d | Sun pools de-smogged: soft neutral box-filtered mask (was gold grain "smog boxes") |
| H1136 | 1a114cc | Cars light by cloud EDGE (nose/tail gradient) + shade fades when headlights on |
| H1137 | 2dfa8c4 | Night: moonlight sheen + cars catch headlights pointed at them (`HeadlightSource[]`) |
| H1138 | a075917 | Volumetric beam sprites (soft lateral shoulder + dust noise, 3 shimmer variants) |
| H1139 | f87d483 | Water tile-seam grid killed (1px overspill) + surface marks flow with the wind |
| H1140 | 56302d8 | Top-down ROSETTE grass rebake (kills the baked-in 'up') + 2D wind-diagonal sway |

Also delivered (no code): art-dump PNG tool + `docs/TERRAIN_ART_SPEC_AUTOMODELLISTA.md`;
Godot-transition realism assessment (verdict: **not now** — 4-6mo rewrite; steal techniques
instead — which is what the grass/water/cloud work did, all from reading the jomoho Godot
plugin source in `art-src/Godot Grass/`).

---

## 3. OPEN WORK QUEUE (priority order)

Each item: **goal**, **anchors**, **approach**, **verify**, **done**. Ship one H-commit per turn.

### A. TWO USER-REQUESTED INITIATIVES (2026-07-11) — see `memory/project_jobs_faults_overhaul.md`

#### ~~H1126 — Cop pull-over (yield) + fix the A/B bypass bug~~ ✅ SHIPPED 13eb5cd
- `'yielding'` phase live (tail 4s within 6 tiles/60° cone post-grace → amber-blink +
  sim-owned decel → shared `'bumped'` pin/ticket); ram still instant, incl. mid-yield.
  COP excluded from roller walk (zero coords) + `jobArrival` mainline + all 3 marker
  surfaces; HUD/pause read ON PATROL. Gotcha for future traffic-speed overrides:
  `tickTraffic` blends `car.speed`→`baseSpeed` every frame — a decel must ratchet a
  sim-owned copy (`cj._yieldSpeed`) and overwrite AFTER `tickTraffic` (cop tick at
  `gameLoop.ts:4529` runs after the traffic tick at `:4481`), else the car creeps forever.
  Headless-verified: `chasing@0s→yielding@4.02s→bumped@5.86s`, ticket paid, bypass dead.

#### ~~H1127 — DeliveryTask abstraction~~ ✅ SHIPPED 4e843e0
- `sim/jobTargets.ts` NEW: `resolveTarget(kind, tileMap)` — kinds `road|gasStation|building|
  partsStore|restaurant|house`; building-backed kinds snap to nearest road (ring search,
  `SNAP_MAX_R 80` — the H13-era GAS_STATIONS coords sit up to ~69 tiles off-road in the
  user's world export: Uptown 29 / Pineville 69 / Westside 5 / University 14); empty pools +
  failed snaps degrade to a road point and report `kind:'road'` (never claim a missing anchor).
  `DailyJob` grew `fromLabel/toLabel/targetKind` + reserved `legs[]`. `jobArrival` now runs a
  per-job `ARRIVAL_SPECS` table (radii/needStop/notifs/onPickup/onDeliver) — TRUCK's H897
  trailer hook/drop is a data row; behavior verified 1:1 headless (drive-through paid exactly,
  truck blow-through did NOT hook, near-stop hooked/dropped). H1128 = spec row + un-bail.

#### ~~H1128 — FUEL TANKER live~~ ✅ SHIPPED 2539ccf
- Roller depot→station 1:1 (monolith L45244, depot ≥200wpx Manhattan from station);
  `ARRIVAL_SPECS` row hooks `trailerType:'tanker'` 58×16 (monolith 11 × H898b ratio) +
  drops + `fuel=100` on deliver; un-bailed on arrival + all 3 marker surfaces; tanker
  silhouette arm at the depot; `playerTrailer` lost-trailer failsafe ported (both arms,
  monolith L27804-27810). At-pump free fuel was ALREADY live (`sim/gasStation.ts`).
  Note: per-job HUD lines ('DELIVERING → GAS STATION', jackknife warnings, monolith
  L34395) still deferred for truck+tanker alike — generic `[DELIVER ▶B]` shows instead.

#### ~~H1129 — TOW TRUCK live~~ ✅ SHIPPED 6579e7c
- Full monolith tow arm: acceptJob seeds `life.towJob` (typed on LifeState now); rear-facing
  (~70° cone) + near-stop progressive winch (~3s, resets on drive-away), haul at ≤72mph with
  light drag, dest delivery pays `towJob.pay` (=$0 by design, v8.99.26). Markers: broken car +
  ⚠ at A, teal $-ring/minimap pin/full-map TOW DROP at `towJob.dest` (50% home junkyard!).
  ALSO wired the whole render/tow.ts + render/trafficCop.ts libs onto the LIVE path via a
  `DrawTopCarFn` adapter in gameLoop (they were orchestrator-only dead code since H598/H704):
  real towtruck body replaces the yellow-disc incoming-tow placeholder, player body hides
  during loading/departing (monolith L31747), radar fan/lightbar/H1126 amber ring now render.
  `tickJobArrival` grew a `dt` param (progressive load needs it).

#### ~~H1130 — Incoming tow truck follows roads~~ ✅ SHIPPED a59a5e5 (user ask 2026-07-11)
- NEW `sim/roadPath.ts` — A* over road tiles (4-neighbor, heap, endpoints snapped, collinear
  collapse, 120k expansion cap ≈ tens of ms worst case; null = disconnected island → caller
  falls back). `incomingTowTick` arriving/departing walk the route (departs the way it came);
  short off-road legs at spawn + stranded car remain straight. Null path/no tileMap = exact
  old straight-line (never strands). Verified: 81% of arriving samples on road tiles on a
  real breakdown; 8/8 random pairs ≤2231 tiles routed ≤20ms.

#### H1131 — Trailer FEEL (wire the unwired penalties)
- ✅ SHIPPED 89a7f43. Accel penalty live on BOTH paths (`computeTrailerMassFactor` →
  `advancePSpeed` gas branch; semi 8165 kg: ×0.87 light → ×0.82 full; probed ×0.80 @1.2s).
  Legacy/arcade steering damp exact (`computeTrailerSteerFactor` = 0.65 × hitch-coupling
  ratio; probed yaw ratio 0.413 vs predicted 0.411). Phase 0B adapter now feeds REAL
  trailer state (massDamp load coupling + hasTrailer→×0.65 intent) — but measured only
  ~0.94 yaw in dyn mode: steady-state yaw is tire-force/geometry-set, intent shapes
  transients only. DELIBERATE deviation documented in phase0BAdapter: eligibility keeps
  hasTrailer=false (monolith kicked rigs to its RICH legacy chain; the modular fallback
  is the simple arcade formula, which measured 1.92× MORE agile — worse).
- **REMAINING GAP (physics-tuning backlog, needs fullcircle/reversal probes + user
  feel-test):** real trailer yaw inertia inside the dyn integrator. Discovered en route:
  fresh saves have bicycleModel+dynPhysics0B **ON by default** (the gameLoop H502 comment
  claiming defaults-off is stale); the gameLoop:3255 comment block still lists
  trailerMassFactor as "unported" — stale too.

#### Dock/backing gameplay + reverse camera — SKIPPED for now (user call 2026-07-11)
- Note: `isSemiWithTrailer` in phase0BAdapter (:405) is the dead reverse-camera gate —
  one-line enable (`bodyType==='semi' && !!LIFE.trailer`, monolith L26538) once this
  lands; deliberately NOT flipped in H1131 (camera-behavior change = its own feel-test).

#### ✅ SHIPPED 2026-07-11 — dynamic sun/cloud lighting sweep (user ask, sanctioned invention)
- H1132 (dddfcd1) sun rays: warm additive pools in the cloud gaps, same drift/scroll as
  the shadows, streaky crepuscular grain; `cloudCoverAt/cloudShadeAt/sunAt` sampler API
  (bake retains the alpha field — NO runtime getImageData). Tuning lesson repeated: first
  cut invisible (H1118 déjà vu) → 0.22 alpha / 0.62 floor.
- H1133 (1724b4a) `render/carLighting.ts`: every car (player + traffic) multiply-darkens
  under the drifting cloud field (pixel-proven exact: 0.7×193+0.3×26=143) + a warm
  specular band that slides/swells with heading vs a time-of-day sun azimuth
  (`sunAzimuth()`), killed under clouds. Drawn AFTER the cel bake (cache keys static).
- H1134 (d2e9a4d) water glitter: ≤3 gold/white glints per SUNLIT water tile, muted under
  cloud. All three share the `disableCloudShadows` kill switch; FPS 125-126 unchanged.
- **Verification gotcha for future cloud work:** the field drifts 24 wpx/s — a spot picked
  "cloudy" goes stale in seconds; always re-pick + screenshot atomically (≤1s), and
  validate with `cloudShadeAt` sampled AT shot time.
- Possible follow-ups if the user wants more: parked/meet cars + race opponents don't
  catch light yet (only player + traffic pool); trailer bodies don't shade; grass/roads
  could get a subtle warm lift in gaps (terrain already gets rays via the overlay).
- **2026-07-11 user feedback round (all shipped):** H1135 rays de-smogged (neutral soft
  mask — gold + streak grain read as "smog boxes" on asphalt); H1136 nose/tail cloud-edge
  gradient on bodies + shade fades over the dusk bulb window (no shade "through" lit
  headlights); H1137 moon sheen + headlight catch (`HeadlightSource[]` on the _carSun
  bundle: player 220 / traffic 140 beams, cos-36° cone gate); H1138 beam cones are baked
  volumetric sprites now (lateral smoothstep shoulder + 2-octave dust noise, 3 variants
  @3.5Hz de-synced per car) — `drawSoftCone` fan-fill retired from drawHeadlightsAt.
  Night FPS 112 / day 126. All still awaiting the user's phone verdict.
- **Round 2 (same day):** H1139 water tile-seam grid killed (base fill overspills 1px onto
  water neighbours — row-major repaint keeps decorations intact; land edges exact) + water
  sparkles/gulls/glitter now TRAVEL along the (2,1) cloud-drift vector; H1140 grass rebaked
  as TOP-DOWN ROSETTES (the H1115 sprig grew toward −y → read upside-down when driving
  south with the rotating camera) with 2D wind-diagonal sway (swx/swy), flowers/straw/
  canopy-glint de-directionalized. Verified: north vs south meadow shots identical; lake
  seamless. NOTE for any per-tile fillRect pass: rotated camera + AA = hairline grid; the
  overspill-onto-later-drawn-neighbours trick is the fix pattern.
- Reverse-in arrival validation (trailer pose at the dock), not just radius+stop
  (`jobArrival.ts:156`). Resurrect the **dead** semi-reverse camera-follow path
  (`selectCamTarget`/`tickCameraAngleRealistic` semi branches are unreachable; legacy path
  heading-locks the camera in reverse). NB camera-motion feel rule still applies.

#### H1133 — Fault hidden-identity (the core of the user's fault ask)
- **Goal:** faults are FELT but not auto-named while driving; identity revealed by inspection/
  mechanic; category-level warnings only (e.g. "⚠ WARNING: steering").
- **Anchors:** three sources feed `life.faults`; `diagnoseFault.ts:181` toasts the EXACT name
  the frame a wear fault crosses threshold; `_hiddenFaults` are physically INERT until
  `tickHiddenFaultReveal` (every 500-2000 game units) surfaces + names them same frame; crash
  zone faults (`maybeTriggerZoneFault`) pushed silently but named in menus. Effects aggregated
  by `computeFaultEffects` (reads only `life.faults`, `gameLoop.ts:3155`).
- **Approach:** faults enter `life.faults` **unidentified** (`detected:false`) WITH live effects;
  `diagnoseFault` stops naming — emit a category toast instead; STATUS/REPAIRS show
  "??? (category)" until the H948 paid DIAGNOSE flow or a DIY home inspection flips `detected`.
  Give `_hiddenFaults` live effects too (so symptom precedes identity).

#### H1134 — Fault magnitude realism pass
- **Anchors:** `sim/faultEffects.ts` `FAULT_EFFECTS` table — `alignment: {steerPull:0.25}` (:133),
  `control_arm_rust: {steerPull:0.12}` (:131); `_pullDir` (:184). Applied RAW at
  `arcadeUpdate.ts:418` `turnInput = input.steerAxis + steerPull` → 0.25 = permanent quarter-lock
  = the user's "car turns 90°" complaint.
- **Approach:** audit every `FAULT_EFFECTS` row vs its `desc`; make magnitudes realistic
  (alignment ~0.05, and **speed-scaled** — pull grows with speed, near-zero when crawling).
  physlab probe each change (feel rule).

### B. TERRAIN / PERF (older queue, still open)

#### H1122b — Kill the blank/brown band still flanking roads
- **Status:** H1122 (grass under `cls===1` road tiles) did NOT fully fix it — user still sees
  brown strips. Ruled out: road-tile stamps (already asphalt-width since H682), shoulders (0 on
  undivided roads), wear strokes (translucent black, too narrow). The band is PAINTED by some
  pass not yet caught.
- **Decisive test (do this):** teleport the player NEXT TO a `BASELINE_ROADS` waypoint, midday,
  screenshot mainCanvas, **sample the band's exact pixel color**, grep that hex in
  `src/render/worldMap.ts` (suspects: `strokeRoad` base coat ~:2626, `baseWear` ~:2875-2911, a
  full-width undercoat for majors) + `render/roadTextures.ts`. Then narrow/remove it so meadow
  meets asphalt. First confirm the user is on build ≥ 8ccae8a (Pages lag).

#### H1123 — Chunk-cached terrain (the real 120fps/144fps unlock)
- **Finding:** there is NO frame cap. rAF loop is limiterless; `dt` is wall-clock
  (`updateFrameStats` `gameLoop.ts:1653`, only a 50ms tab-suspend ceiling). The user's "60/75"
  are their **display refresh rates** (PC monitor at 75Hz; phone likely in 60Hz mode OR frame
  cost >8.3ms locking Chrome into the 60Hz vsync bucket). The FIX in our power: cut frame cost.
- **Approach (from the jomoho plugin's chunk trick):** pre-render 8×8-tile terrain blocks to
  offscreen canvases; redraw a chunk only when its wind step changes (~1.3/s, staggered per
  chunk). Collapses grass+water+flatten from ~3000 tile draws to ~a dozen `drawImage`/frame.
  Target total frame < 8.3ms on phone so Chrome grants 120. Measure `perfSnapshot().total`
  before/after. (Also point the user at the OPT **Render Scale** slider — the one cost that
  scales with a 4K screen.)

#### H1124 — Full water submersion totals the car
- **Spec (user):** fully driving into water (car center on tile 9) should TOTAL the car, require
  a tow truck, and reuse the **canyon-fall animation** from touge. Also: skid marks
  (physics-emitted brown off-road dabs, a DIFFERENT system from H1117 ruts) still paint on
  water — gate the emit side (`physics/movement.ts` C22 emit) with a not-water check like the
  H1121 grassFlatten fix.
- **Anchors to find:** canyon-fall sequence (grep `canyonFall`/fall anim in touge/`sim/trackRace`
  or physics); tow trigger (`towMenu`/breakdown flow); car "totaled" condition write.

### C. CONTROLLER FOLLOW-UPS (from `memory/project_controller_support.md`; H-numbers there are stale)
H1110-H1112 shipped. Remaining, all built on `src/ui/focusNav.ts` (spatialNav + drawFocusRing,
activate via the screen's existing tap handler at the focused rect's center):
- Home SLEEP/RELAX buttons + sub-screen internals (GARAGE panels etc.).
- **Pause-menu OPT rows** focus nav — so the H1111 "Drive Side" row is reachable by pad (it's
  currently mouse/touch-settable only).
- Service modals (dealer/junkyard/autoparts/gas/purchase/inspection/confirm/tow/office/repair/dialogue).
- **Pad pop-up on-screen keyboard** for name entry (`ui/widgets/padKeyboard.ts` — dpad grid,
  A type, B backspace, Start commit; wire to `nameEntry` DOM inputs when a pad is connected).
- Full-map d-pad (bind to existing `cycleFullMapCategory`/`cycleFullMapInstance`), title confirm,
  race-HUD buttons, blacklist board.

### D. ART PIPELINE (parked, may revisit)
- `art-src/terrain/` has ChatGPT tile attempts + a "pixel-block scale" prompt refinement. The
  reduce-test proved 300px AI art mushes at 18px, so grass was **hand-authored** instead
  (H1115-H1122). If revisiting the AI route: force pixel-block-scale output, then the
  `public/terrain/` loader (NOT built) would read seamless 18px tiles with the procedural bake
  as fallback. Spec: `docs/TERRAIN_ART_SPEC_AUTOMODELLISTA.md`. The DORMANT `render/ground.ts`
  18-type tileset (sidewalk/forest/canyon/bridge/lots) is still unwired — revive-or-retire
  decision pending from the user.

---

## 4. Key memory files to read (durable "why")
- `project_jobs_faults_overhaul.md` — this session's initiative roadmap (H1125-H1133 detail).
- `project_dynamic_grass.md` — grass/water/cloud technique map + perceptual lessons (palette
  reads mud in-game, shadow-bigger-than-screen = invisible, tile-grid is the lushness killer).
- `project_controller_support.md` — focus-registry architecture.
- `project_jobs_functionality.md`, `project_physics_tuning.md`, `feedback_no_camera_motion_cues.md`,
  `feedback_migration_commit_cadence.md`, `feedback_check_build_sha_first.md`.
