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
- **One `H<n>` commit per turn.** Never one-shot a whole phase. Current tip is **H1125**;
  next new commit is **H1126**. (H-numbers are reused across tracks — just pick the next free.)
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

Also delivered (no code): art-dump PNG tool + `docs/TERRAIN_ART_SPEC_AUTOMODELLISTA.md`;
Godot-transition realism assessment (verdict: **not now** — 4-6mo rewrite; steal techniques
instead — which is what the grass/water/cloud work did, all from reading the jomoho Godot
plugin source in `art-src/Godot Grass/`).

---

## 3. OPEN WORK QUEUE (priority order)

Each item: **goal**, **anchors**, **approach**, **verify**, **done**. Ship one H-commit per turn.

### A. TWO USER-REQUESTED INITIATIVES (2026-07-11) — see `memory/project_jobs_faults_overhaul.md`

#### H1126 — Cop pull-over (yield) + fix the A/B bypass bug
- **Goal:** after a chase, let the player pull the target over WITHOUT ramming; also fix a
  recon-found bug where a cop can "complete the shift" by driving marker A→B for band pay,
  bypassing the whole ticket loop.
- **Anchors:** `sim/trafficCop.ts` — phases `'radar'|'chasing'|'bumped'` (`CopJobState` ~:60),
  ticked `gameLoop.ts:4529`; pull-over today needs a RAM (`BUMP_RADIUS_TILES 2.2`,
  `BUMP_CONE_RADIANS 1.05`, bump handler ~:206-226). The bypass bug: `jobsRoller.ts:122-132`
  gives COP random A/B coords despite the header comment; `jobArrival.ts` mainline + markers
  (`jobMarkers.ts`, `minimap.ts:378-403`, `fullMap.ts:401-415`) all render/complete for COP.
  UI buttons `gameLoop.ts:8017-8021` (acceptCopAlert / issueTrafficTicket); HUD `ui/hud/copHud.ts`.
- **Approach:** add a `'yielding'` phase between `'chasing'` and `'bumped'`: when the player
  stays within ~6 tiles behind the target inside the heading cone for ~4s continuous, the
  target signals + decelerates to a stop → reuse the existing `'bumped'` pin + ticket flow.
  Keep the ram as the forceful alternative. Separately, EXCLUDE `'TRAFFIC COP'` from the
  roller's random-coord walk + `jobArrival` mainline + all three marker surfaces so cop duty
  is purely radar→pursuit→pull-over→ticket.
- **Verify:** fake-pad harness — force an alert (`ctx.life.copJob.phase='chasing'`, target a
  moving traffic car), tail it, assert `phase` walks `chasing→yielding→bumped/ticket`; assert
  no A/B markers render for COP and `jobArrival` no longer pays a cop for driving A→B.
- **Done:** pull-over works by pursuit alone; cop can't complete via A/B.

#### H1127 — DeliveryTask abstraction (the scaffolding the user asked for)
- **Goal:** generic A/B delivery with a target `kind`, so restaurants/parts-stores/houses
  plug in later without touching the run machine.
- **Anchors:** `sim/jobsRoller.ts:34-42` `DailyJob {type,pay,fromX/Y,toX/Y,pickedUp}`,
  `:136-157` two copy-pasted random road-tile walks, `:122-132` OFFICE special coords.
  Run loop `sim/jobArrival.ts:49-188` (called `gameLoop.ts:3993`), radius `:27`, TRUCK branch
  `:111-167`, pay math `:175-176`, TOW/TANKER bail `:70-73`. Markers `render/jobMarkers.ts`
  (bail `:46-49`, trailer silhouette `:69-91`). Anchor sources that already exist:
  `world/placedBuildings.ts` (types autoparts/dealership/mechanic/junkyard — **no `restaurant`
  yet**), `config/world/gasStations.ts` (4 named stations), `life.homeX/officeX`. LIFE persists
  wholesale (`save/interim.ts:105`) so `DailyJob` can grow fields safely.
- **Approach:** introduce `Target { kind:'road'|'gasStation'|'building'|'restaurant'|'partsStore'|'house', x, y, name }`
  + a resolver replacing the two random walks (buildings are solid H998 → need a snap-to-nearest-road
  helper). Grow `DailyJob` with `fromLabel/toLabel/targetKind` (+ optional `legs[]` for
  multi-stop restaurant→house loops). Add a per-job **arrival-spec table**
  `{pickupR², deliverR², needStop, onPickup(life), onDeliver(life)}` to replace `jobArrival`'s
  hardcoded `isTruck` branches (TRUCK's trailer-hook becomes an `onPickup`).
- **Verify:** accept a delivery job headless, assert markers resolve to the right target kind,
  drive A→B, assert pay + completion. Round-trip a save.
- **Done:** the 4 generic delivery jobs run through one table; adding a `kind` is data-only.

#### H1128 — FUEL TANKER live · H1129 — TOW TRUCK live
- **H1128:** depot→`GAS_STATIONS` on the H1127 DeliveryTask; require the tanker trailer hooked
  (`trailerType:'tanker'` already reserved `life.ts:599`). Un-bail `jobArrival.ts:70-73` +
  `jobMarkers.ts:46-49`.
- **H1129:** stalled-NPC pickup → tow to a shop; use the monolith `towJob` (broken-car pickup,
  `loadProgress` hook, drop at shop) as reference. `render/tow.ts` exists.

#### H1130 — Trailer FEEL (wire the unwired penalties)
- **Anchors:** trailer physics is REAL (`physics/trailer.ts` `trailerKinematicTick` no-slip hitch
  ODE; `sim/playerTrailer.ts` wired `gameLoop.ts:3998`; jackknife 60/75/90° zones + 90° clamp).
  **Unwired on the live path:** `trailerMassFactor` (`acceleration.ts`, zero call sites),
  `TRAILER_STEER_MULT 0.65` (only via Phase 0B with `hasTrailer` hardcoded false),
  `computeMassDamp` trailer coupling (called with null). `arcadeUpdate.ts` — the path the semi
  actually runs — has **no trailer awareness**.
- **Approach:** thread `hasTrailer`/load into `arcadeUpdate` and apply accel + steer + mass-damp
  penalties. **physlab probe** the accel/brake/steer deltas with/without trailer first (feel rule).

#### H1131 — Dock/backing gameplay + reverse camera
- Reverse-in arrival validation (trailer pose at the dock), not just radius+stop
  (`jobArrival.ts:156`). Resurrect the **dead** semi-reverse camera-follow path
  (`selectCamTarget`/`tickCameraAngleRealistic` semi branches are unreachable; legacy path
  heading-locks the camera in reverse). NB camera-motion feel rule still applies.

#### H1132 — Fault hidden-identity (the core of the user's fault ask)
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

#### H1133 — Fault magnitude realism pass
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
