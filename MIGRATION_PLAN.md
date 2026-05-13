# Driver City — Migration Plan

**Audit date:** 2026-05-13
**Source:** `driver_city_charlotte_v8_99_126_89.html` (51,105 lines, 1,116 version-comment markers, ~1000 iterations of single-file development)
**Targets:** Steam (desktop) + Google Play (mobile)

---

## TL;DR

The codebase is in **much better shape than the line count suggests**. Three months of single-file iteration produced a 51k-line monolith, but:

- **Zero duplicate function definitions** across the whole file.
- ~200–300 lines of identifiable dead code (mostly commented archaeology, one orphan ~66-line block).
- **No `TODO`/`FIXME` items** outstanding.
- Functions are descriptively named with consistent prefixes (`_we*` for world editor, `draw*/handle*` for UI screens, `_v2*` for the V2 renderer, etc.) — natural module boundaries.
- Big monoliths (`update()`, `render()`, `_weBindUI()`) have clear internal comment-section headers.
- Modal/screen routing is **centralized**, not scattered — `gameState` + a cascade of `LIFE.*` flags + a single dispatch table at line 50974.
- Debug code is well-compartmentalized (`_diagOff*` flags, `_perfOn` gate) and easy to strip.

**The migration is mostly mechanical extraction, not a rewrite.**

---

## 1. The stack

| Layer | Tool | Reason |
|---|---|---|
| Build | **Vite** | ES modules, tree-shaking, asset hashing, fast HMR. Zero config for Canvas/JS. |
| Language | **TypeScript** (gradual; start with `// @ts-check`) | At 50k lines, catches the rename/typo bugs that hide in plain sight. |
| Desktop wrapper | **Tauri** (preferred) or Electron | Tauri ≈ 5 MB binary, Electron ≈ 100 MB. Both pass Steam cert. |
| Mobile wrapper | **Capacitor** | Wraps Vite build into a real AAB/APK, real native plugin surface (haptics, billing, GameServices). |
| Versioning | `package.json` + `src/config/version.ts` | Stop versioning via filename. |

**Stay in web-tech. Do not rewrite in Unity/Godot.** The Canvas/Web Audio engine already works, ships on every store via the wrappers above, and migrating it preserves every line of physics you've tuned.

---

## 2. The structural map (audited)

### 2.1 File regions, by line range

```
   1 –   6   HTML doctype + meta
   7 – 1185  <style> — ~1180 lines of CSS, ~70 versioned sections
1186 – 1494  <body> DOM:
              - Game canvas #c
              - HUD canvas #h
              - Speedometer SVG #speedoSvg, mobile RPM SVG, PC minimap SVG
              - #carSelect modal
              - #mctrl mobile controls (steer wheel SVG, pedals, shift knob)
              - #weEntryBtn + #weOverlay (World Editor)
1495 – 51103 <script> (single block, ~49,600 lines)
51104        </body></html>
```

### 2.2 JS regions, by line range

| Lines | System | Notes |
|---|---|---|
| 1659–1994 | **Vehicle sprite manifest** (`VEHICLE_IMAGE_MANIFEST`) | Hardcoded `raw.githubusercontent.com` base URL — must move local |
| 1995–2447 | **Sprite loading + caching** (`_loadVehicleSprites`, sprite buffer, downscale) | |
| 2448–2530 | **Canvas / viewport globals** (`GW`, `GH`, `canvas`, `hcanvas`, `mainCtx`, `hctx`) | |
| 2531–2585 | Shadow / light helpers (`_drawSoftCone`) | |
| 2586–2866 | **Asphalt pattern canvases** | Note: `_asphaltPatternAsphaltOld` / `Concrete Old` look orphaned (kept for compat?) |
| 2867–3343 | Grass variants + paint | |
| 3344–3500 | Shadow geometry helpers | |
| 5329–5800 | **Tilt + resize + perspective** | `recomputeTiltFactors`, `applyCssTilt`, `resize()` |
| 5802–5892 | Portrait sheets + character base (with `i.postimg.cc` URLs — also need to relocate) |
| 5894–7282 | **GT4 spec database + price calc** (`GT4_DB`, `GT4_SPECS`, `CAR_MSRP`, `BRAND_TIERS`, `CLASS_CURVES`) | Pure data + pure functions — easiest extraction |
| 7284–7720 | **CARS object + car-select modal** (`rebuildCarSpecs`, `openCarSelect`) | |
| 7732–7937 | **Game settings + LIFE state** | The single source of player state |
| 7938–8624 | **Race system** (`RACE`, generate opponent, drag race, race finish) | |
| 8625–8830 | Tow system | |
| 8825–8983 | Jobs system (work, pay, raise, applications, connections) | |
| 8984–9120 | **Car condition + odometer + lot generation** | Per-car save state |
| 9123–9200 | Menu state + title image (URL needs relocation) | |
| 9197–9628 | **World map data** (TILE, MAP, highway placement, gas stations, `_rp` baseline roads) | Static data |
| 9624–9728 | Road crossings, bridge points | |
| 9729–17200 | **WORLD EDITOR** (7,472 lines, ~59 functions) | F9-toggled, stores to localStorage `driverCity_worldEditor_v4`, fully optional at runtime. See §6.4 |
| 17205–17400 | Surfaces, buildings, I-277 polygon, building registry | |
| 17648–17985 | **Player state** (px, py, pSpeed, pAngle, physics dyn state, wheel state) | |
| 17783–17910 | Particle system | |
| 18007–18642 | **Audio engine** (Web Audio, V8 sample loops, tire grain, brake noise) | Loads `.wav` files from raw GitHub URLs |
| 18642–19842 | Traffic system (spawn, road preprocessing, T-junction + auto-taper detection) | |
| 19843–20100 | Spawn / overlap logic | |
| 20103–20280 | **Input** (keyboard, gamepad polling, touch shared state) | |
| 20281–20410 | Pursuit / cop AI + car logo URLs | |
| 20429–20930 | **Control layout** (PC vs mobile, pedal/wheel rebinding) | |
| 22217–23800 | **HUD SVG + speedo + RPM + minimap** (~1,600 lines of DOM/SVG sync code) | |
| 23838–27650 | **`update(dt)`** — 3,813 lines, the player tick. **14 internal blocks**: nearest-road cache, speed limit, fault effects, acceleration, cruise, NFS-Blackbox tire physics, steering, velocity, movement+collision, legacy movement (bikes/specials/drift/trailer), gear+RPM, camera, gas-pump save trigger, traffic-AI. 2 nested helpers (`_tireCurve`, `_combinedSlipFactor`). |
| 27653–28290 | Job vehicles, cop AI, trailer, traffic semi collisions, lane offsets | |
| 28291–29280 | **Bridges** (collision, layer transitions, deck mask, ramp climb, structures) | |
| 29369–29940 | Gauge cluster + needle + odometer drawing helpers | |
| 29957–36272 | **`render()`** — ~6,315 lines. **~22 z-ordered phases**: clear → camera → ground → foreground props → roads pass 1 → intersections → skid marks → particles → traffic trailers → cop visuals → tow → 53' trailer → headlight shadow mask → HUD context swap → minimap → full map → speed/gear/RPM (canvas fallback) → analog gauges → menu overlays → race HUD → scanlines → diag badges. 4 nested helpers (`edgePt`, `traceRoadPath`, `drawRoadOverlay`, `_strokeWide`). |
| 36273–42013 | **Car body drawing** (V2 renderer, generation data, x-ray wheels, traffic trailers, top-down car) | |
| 42013–42330 | Misc UI utils, notifications, confirm prompts, `lifeSimTick` | |
| 42348–42950 | Parts shop, repair popup, sell confirm | |
| 42951–43400 | **Fault pools, body damage, fault FX, used-car fault generation** | |
| 43444–43580 | Inspection screen | |
| 43580–43900 | Fuel, jerry can, paint, factory color, mechanic, car value, car ads | |
| 43904–44040 | **Perf instrumentation** (`_perfBuckets`, `_diagOff*`, overlay) — production-strippable |
| 44040–44680 | **Title screen + starting conditions + car choices** | |
| 44684–45110 | **Name entry overlay** (DOM-based) + job select | |
| 45114–45305 | Car select draw + handler | |
| 45306–45550 | Daily jobs, newspaper, housing/salary/loan rate tables | |
| 45557–45920 | **Finance system** (car loans, leases, paycheck tax, bank loans, fitness/health) | |
| 45971–46395 | Purchase menu + **`saveGame()` / `loadGame()`** (lines 46133, 46211 — localStorage `driverCitySave`) | |
| 46400–46950 | **Calendar + monthly bills + going-out + sleep** | |
| 47128–47297 | Office menu (work day flow) | |
| 47297–49800 | **Home screen + tabs** (garage, specs, repairs, parts, eat, housing, bills, bank loan) — single biggest UI cluster | |
| 49871–50130 | Realtor / home purchase flow | |
| 50127–50295 | Newspaper screen | |
| 50296–50563 | Pin picker, car pins, near-pin proximity | |
| 50563–50970 | **Home-screen click dispatcher** (`handleHomeScreenClick`) | |
| 50974–51102 | **`gameLoop(ts)`** — RAF entry, gameState branch, perf-bucketed system calls, single `requestAnimationFrame(gameLoop)` boot at the bottom |

### 2.3 Top-level architecture, as it is today

```
                       ┌──────────────┐
                       │  gameLoop()  │  RAF entry, gameState branch
                       └──────┬───────┘
                              │
       ┌──────────┬───────────┼───────────┬──────────┬─────────────┐
       ▼          ▼           ▼           ▼          ▼             ▼
   update(dt)  lifeSim    updateTraf   updateAudio  render()    WORLD_EDITOR
                                                              (when .active)

   update(dt)   = player input + physics + collision + traffic interaction
   render()     = entire scene + entire HUD + entire menu/modal stack
```

`gameLoop()` is already a perfect router — each system gets its own `_pf_start/_pf_end` perf-bucket call. **This is the bottleneck that already factors the code for you.** Migration just promotes each of those bucket boundaries to real ES module boundaries.

---

## 3. Target architecture & folder structure

```
Racing-Game-2/
├── package.json
├── tsconfig.json
├── vite.config.ts
├── index.html                       # ~50 lines — canvas elements + entry SVG defs + <script type="module" src="/src/main.ts">
├── public/                          # static assets, hashed at build
│   ├── sprites/cars/                # all car PNGs
│   ├── sprites/portraits/           # Character-Bases-1.png + portrait sheets
│   ├── sprites/titles/              # CLT-Title-{Day,Night,Sunrise,Sunset}.png
│   ├── audio/sfx/                   # Tire_Screech-*.wav, Crash_Hard-*.wav
│   ├── audio/engine/                # Muscle_Car_Gear*.wav
│   └── logos/                       # car-brand badges
├── src/
│   ├── main.ts                      # bootstrap: init audio, wire input, start gameLoop
│   ├── gameLoop.ts                  # the RAF loop (~80 lines, from L50974)
│   ├── state/
│   │   ├── gameState.ts             # 'title' | 'nameEntry' | 'jobSelect' | 'carSelect' | 'playing'
│   │   ├── life.ts                  # the LIFE object (player save state) + types
│   │   ├── player.ts                # px, py, pSpeed, pAngle, dyn physics state (L17648–17985)
│   │   └── camera.ts                # camera position + smoothing
│   ├── config/
│   │   ├── version.ts               # build version, replaces filename versioning
│   │   ├── viewport.ts              # GW, GH, BACK_ZONE, tile constants (L2448–2477)
│   │   ├── cars/
│   │   │   ├── manifest.ts          # VEHICLE_IMAGE_MANIFEST → local paths (L1659–1994)
│   │   │   ├── gt4Database.ts       # GT4_DB (L5894–6772)
│   │   │   ├── msrp.ts              # CAR_MSRP + LUXURY_BRANDS (L6834–7176)
│   │   │   ├── brandTiers.ts        # BRAND_TIERS + CLASS_CURVES (L7177–7232)
│   │   │   ├── pricing.ts           # _classicPrice, calcGT4Price, rebuildCarSpecs (L7233–7566)
│   │   │   └── ids.ts               # CAR_IDS, ALL_CAR_IDS, activeCar (L7645–7660)
│   │   ├── world/
│   │   │   ├── tiles.ts             # TILE, MAP_W, MAP_H, tile constants (L9197–9206)
│   │   │   ├── highways.ts          # placeHighwayH/V, placeCurvedRoad, smoothHighwayPts (L9225–9549)
│   │   │   ├── gasStations.ts       # GAS_STATIONS, FUEL_GRADES, placeGasStation (L9304–9327)
│   │   │   ├── majorRoads.ts        # _rp baseline data, majorRoads, EXIT_MARKERS (L9328–9623)
│   │   │   └── crossings.ts         # roadCrossings, bridgePoints (L9624–9728)
│   │   ├── jobs.ts                  # JOB_BASE_PAY, JOB_VEHICLES, JOB_SALARY, JOB_PAY_CAP (L8825–8830, L27653+, L45511+)
│   │   ├── housing.ts               # HOUSING_TIERS, loan rates, house rates (L45538+, L45557+, L49871+)
│   │   ├── parts.ts                 # PARTS_SHOP, FAULT_POOLS, USED_FAULTS, REPAIR_TIERS, FAULT_EFFECTS, TEST_DRIVE_ONLY, BODY_DAMAGE_FAULTS (L42510, L42951, L43137, L43214, L43285, L43350, L43357)
│   │   ├── traffic.ts               # TRAFFIC_COLORS_NORMAL/RACER, copSpawnRate (L18644–18653)
│   │   ├── gauges.ts                # GAUGE_PRESETS, gauge symbols (L29369–29456)
│   │   ├── names.ts                 # RANDOM_NAMES (L44173)
│   │   └── carLogos.ts              # CAR_LOGOS map + getCarLogoUrl (L20366–20410)
│   ├── engine/
│   │   ├── canvas.ts                # canvas/hcanvas init, ctx swaps, _drawUIStateFlat helper (L2478–2530, L50997–51019)
│   │   ├── tilt.ts                  # TILT_MODE, recomputeTiltFactors, applyCssTilt (L5329–5495)
│   │   ├── resize.ts                # resize() + SVG sync (L5496–5800)
│   │   ├── assets.ts                # sprite/audio loader, manifest resolver
│   │   ├── sprites.ts               # _vehicleSprites, _loadVehicleSprites, getVehicleSprite (L1995–2447)
│   │   ├── shadows.ts               # _drawSoftCone, _rectCornersWS, _castShadowPoly, _castParallelShadow, _tireRectsWS (L2531–3500)
│   │   ├── patterns.ts              # asphalt/grass pattern canvases (L2586–3343)
│   │   ├── particles.ts             # particle pool + spawners + drawParticles (L17783–17910)
│   │   ├── audio/
│   │   │   ├── init.ts              # audioCtx, masterGain, sfxGain, initAudio (L18007–18330, L18423)
│   │   │   ├── sfxLoader.ts         # loadAllSFX, tire/crash sample buffers (L18044–18072)
│   │   │   ├── v8Engine.ts          # V8 gear-loop crossfade engine (L18091–18178)
│   │   │   ├── tireGrain.ts         # tire grain scheduler + chirp (L18179–18272)
│   │   │   ├── crash.ts             # playCrashSound (L18072–18091)
│   │   │   └── update.ts            # updateAudio() + procedural engine (L18441 — main per-frame audio)
│   │   └── input/
│   │       ├── keyboard.ts          # keys{}, gas/brake/ebrk/steer state + handlers (L20103–20110, L20755+)
│   │       ├── gamepad.ts           # pollGamepad, gpRumble, gpPressed (L20111–20280)
│   │       ├── touch.ts             # steer zone + pedal sliders + tap detection (L23309–23800, L22217+)
│   │       ├── controlLayout.ts     # updateControlLayout, rebindPedals, PC vs mobile (L20429–20930)
│   │       └── shifter.ts           # doShift, shift knob bindings (L23597–23800)
│   ├── physics/
│   │   ├── vehicle.ts               # acceleration, torque curve, turbo, drivetrain (L24070–24208)
│   │   ├── tire.ts                  # _tireCurve, _combinedSlipFactor, NFS-Blackbox 0A/0B branch (L24217–24720, was nested)
│   │   ├── steering.ts              # steering math + power-steering fault (L24721–25119) — **extract shared `applyPowerSteeringFault()` (currently duplicated 3×)**
│   │   ├── movement.ts              # velocity → position, collision integration (L25193–26377)
│   │   ├── legacyMovement.ts        # bikes, specials, drift, trailer (L26378–26448) — review whether still needed
│   │   ├── gearAndRpm.ts            # shift logic, engine-brake, manual-limit (L26449–26599)
│   │   ├── trailer.ts               # updateTrailer (L27884–28101)
│   │   ├── collision.ts             # isSolid, collide, isOnMajorRoad (L23804–23830)
│   │   └── fuel.ts                  # buyFuel, jerry can, gas station proximity (L43580–43620, L26632)
│   ├── world/
│   │   ├── city.ts                  # map generation orchestrator
│   │   ├── buildings.ts             # buildings registry, getBldg, I-277 inside test (L17388–17430)
│   │   ├── surfaces.ts              # _surfaces array + parking lots (L17205+)
│   │   ├── bridges.ts               # bridge structures, collision, layer transitions, render (L28291–29368)
│   │   ├── roadProfiles.ts          # getRoadProfile, lane geometry (L18657)
│   │   ├── roadPreproc.ts           # preprocessRoadsForRender (L18863), _weDetectAutoTapers, _weDetectTeeJunctions
│   │   ├── traffic/
│   │   │   ├── spawn.ts             # spawnTrafficOnRoad, trafficOverlaps, pickTrafficColor (L18642–20102)
│   │   │   ├── ai.ts                # GTA-style traffic AI (extracted from update(dt) traffic block L26663+)
│   │   │   ├── cop.ts               # updateTrafficCop, pursuit state, ticket issue (L27682–27884)
│   │   │   ├── semis.ts             # updateTrafficSemiCollisions, updateTrafficTrailerAngles (L28102–28221)
│   │   │   └── tow.ts               # updateIncomingTow, finishIncomingTow (L8694–8824)
│   │   └── time.ts                  # day/night/sunset/sunrise selection (L9158–9171)
│   ├── render/
│   │   ├── index.ts                 # the `render()` orchestrator — 22 z-ordered phases, calls submodules in order
│   │   ├── ground.ts                # ground tiles, water, grass, dirt (L30144–30518)
│   │   ├── foregroundProps.ts       # storm drains, street signs, water shimmer (L30494–30573)
│   │   ├── roads.ts                 # road overlay drawing, lane dividers, edge stripes (L30577–30738)
│   │   ├── intersections.ts         # stop bars, crosswalks, zebra stripes (L30739–30762)
│   │   ├── skidMarks.ts             # persistent skid mark drawing (L30763–30804)
│   │   ├── speedTrail.ts            # Akira taillight trail (L30805–30878)
│   │   ├── trafficCop.ts            # cop pursuit visuals, ticket overlays (L30919–31076)
│   │   ├── tow.ts                   # tow truck winch animation (L31077–31092)
│   │   ├── trailer.ts               # 53' trailer rendering (L31093–31750)
│   │   ├── headlightShadows.ts      # headlight shadow mask pass (L31751–32804)
│   │   ├── carBody.ts               # traceCarBodyPath, drawTopCar, _v2Wheels, _v2GroundShadow (L36273–42013)
│   │   ├── carBodyV2.ts             # drawCarBodyV2, V2 generation data, xray geom (L40346–40558)
│   │   ├── gauges.ts                # _drawGaugeCluster, _gaugeNeedle, _gaugeOdometer (L29472–29940)
│   │   ├── damage.ts                # drawXrayDamageOverlay, getDamageZoneRects (L43164–43213)
│   │   └── crt.ts                   # scanlines, CRT overlay
│   ├── ui/
│   │   ├── router.ts                # the modal-priority cascade from L34586–35872 and L21780 click dispatcher
│   │   ├── hud/
│   │   │   ├── speedoSvg.ts         # _buildSpeedoSvg, _updateSpeedoSvg, _syncSpeedoSvgPosition (L22896–23000)
│   │   │   ├── rpmGauge.ts          # _buildWheelRpmGauge, _buildMobileRpmGauge, _updateMobileRpm (L23041, L22619–22710)
│   │   │   ├── minimap.ts           # _updateMobileMinimapSvg + sync (L22791–22895)
│   │   │   ├── canvasHud.ts         # canvas-fallback speed/gear/RPM (L34447–34795)
│   │   │   └── gaugeCluster.ts      # canvas analog gauges fallback (L34568–34795)
│   │   ├── screens/
│   │   │   ├── title.ts             # drawTitleScreen, handleTitleClick, titleBtnHit (L44040–44172)
│   │   │   ├── nameEntry.ts         # ensureNameOverlay, hideNameOverlay, drawNameEntry, handleNameEntryClick (L44684–45030)
│   │   │   ├── jobSelect.ts         # drawJobSelect, handleJobSelectClick (L44935–45085)
│   │   │   ├── carSelect.ts         # drawCarSelect, handleCarSelectClick (L45114–45305)
│   │   │   ├── home/
│   │   │   │   ├── index.ts         # drawHomeScreen, handleHomeScreenClick (L47297, L50563–50972)
│   │   │   │   ├── garage.ts        # drawHomeGarage, drawGarageSpecs, drawGarageRepairs, drawGarageParts (L48176, L48361, L48548, L48642)
│   │   │   │   ├── mail.ts          # drawHomeMail (L47878)
│   │   │   │   ├── eat.ts           # drawHomeEat (L48854)
│   │   │   │   ├── housing.ts       # drawHomeHousing, handleHousingClick (L49022, L49469)
│   │   │   │   ├── bills.ts         # drawHomeBills, drawBankLoanOffer (L49108, L49341)
│   │   │   │   ├── newspaper.ts     # drawHomeNewspaper (L50127)
│   │   │   │   └── calendar.ts      # drawCalendar (L46408)
│   │   │   └── office.ts            # drawOfficeMenu, handleOfficeMenuClick, completeOfficeDay (L47156–47297)
│   │   ├── modals/
│   │   │   ├── repairPopup.ts       # drawRepairPopup, handleRepairPopupClick, processRepair (L42702, L42867, L42919)
│   │   │   ├── sellConfirm.ts       # drawSellConfirm, handleSellConfirmClick (L42795, L42848)
│   │   │   ├── inspection.ts        # drawInspection, handleInspectionClick (L43458, L43536)
│   │   │   ├── purchase.ts          # drawPurchaseMenu, handlePurchaseMenuClick, completePurchase (L46028, L46096, L45971)
│   │   │   ├── seller.ts            # drawSellerOverlay, handleSellerClick, startSellerVisit, haggleWithSeller (L49560, L49645, L49513, L49708)
│   │   │   ├── realtor.ts           # drawRealtorOverlay, handleRealtorTap, openRealtorVisit (L49990, L50106, L49928)
│   │   │   ├── pinPicker.ts         # drawPinPicker, handlePinPickerClick, drawCarPinsWorld, drawCarPinsMinimap (L50296–50545)
│   │   │   ├── carPicker.ts         # the #carSelect modal HTML view (L1204–1208 DOM + L7686–7720 logic)
│   │   │   └── confirmPrompt.ts     # handleConfirmPromptTap, executeConfirmAction (L42026–42058)
│   │   ├── overlays/
│   │   │   ├── fullMap.ts           # the F-toggle full-screen map render
│   │   │   └── raceHud.ts           # race HUD overlay (L36109+)
│   │   └── notif.ts                 # showNotif, notification overlay (L42023)
│   ├── save/
│   │   ├── schema.ts                # save shape + version constant + migration rules (handles `portrait`, `meals`, etc. legacy fields)
│   │   ├── persistence.ts           # saveGame, loadGame, autosave gate (L46133, L46211)
│   │   ├── carCondition.ts          # carConditions, saveCarCondition, loadCarCondition (L8984–9105)
│   │   └── migrate.ts               # v8.99.x localStorage shape → v9.0.0 module shape (DEPRECATED fields, see §5)
│   ├── sim/
│   │   ├── life.ts                  # lifeSimTick + monthly bills + day phase (L42059–42329, L46561–46950)
│   │   ├── finance.ts               # loan/lease/tax math (L45557–45920)
│   │   ├── credit.ts                # adjustCredit, getCreditTier, getBankLoanAPR (L46840, L44326, L45699)
│   │   ├── jobs.ts                  # applyForJob, completeWorkDay, checkMonthlyRaise, generateJobListings (L8919, L8881, L8899, L47128)
│   │   ├── newspaper.ts             # generateNewspaper, fillNewspaper, generateCarAdOffers (L45376–45464, L43827–43903)
│   │   ├── race.ts                  # generateRaceOpponent, startRaceSetup, raceOpponentTick, checkRaceFinish, endRace (L7975–8618)
│   │   ├── faults.ts                # generateUsedCarFaults, computeFaultEffects, diagnoseFault, applyZoneDamage (L43308, L43262, L43050–43135, L43308, L43403)
│   │   ├── health.ts                # updateDailyHealth, doGymWorkout, eatFood, buyGroceries (L45836–45920)
│   │   └── pursuit.ts               # arrestPlayer, issueTrafficTicket, acceptCopAlert (L20291, L27842, L27869)
│   ├── editor/                      # WORLD EDITOR — 7,500 lines, dev-gated in production builds
│   │   ├── index.ts                 # _weBindUI, _weToggle, _weTick, _weExit (L16610–17200)
│   │   ├── storage.ts               # WE_STORAGE_KEY*, load/save overlay, baseline edits (L9729–9980)
│   │   ├── baseline.ts              # _weCaptureBaseline, _weApplyBaselineEdits (L9981–10021)
│   │   ├── stamp.ts                 # _weStampSurface, _weStampBuilding, _weStampRiver, _weStampLake (L10046–10120)
│   │   ├── apply.ts                 # _weApplyOverlay, _weRebuildWorld (L10201–10470)
│   │   ├── merge/
│   │   │   ├── standard.ts          # _weMergeBondEndpoints_standard (L13346–14215)
│   │   │   ├── cloverleaf.ts        # _weMergeBondEndpoints_cloverleaf (L14216–14550)
│   │   │   ├── stop.ts              # _weMergeBondEndpoints_stop (L14701–15025)
│   │   │   └── taper.ts             # _weBuildAutoTaperPolygon, _weBuildTaperedMergeEdges (L10902–11335)
│   │   ├── render.ts                # _weRender, _weDrawRoadFull, _weDrawTaperedMergeRoad (L11336–12871)
│   │   ├── draft.ts                 # _weBeginDraft, _weCommitDraft, _weCancelDraft (L13194–15155)
│   │   ├── snap.ts                  # _weFindSnap, _weSnapSelectedEndpoints, _weSnapDraftLastPoint (L11972–15295)
│   │   ├── input.ts                 # _weCanvasMouseDown/Move/Up, _weTouchStart/Move/End (L15850–16378)
│   │   ├── select.ts                # _weHitTestSelectedVertex, _weFindNearestVertex, etc. (L15668–15817)
│   │   ├── delete.ts                # _weDeleteSelected, _weSplitOrTrimOverlayRow (L15336–15642)
│   │   ├── export.ts                # _weExport (L16456–16560)
│   │   └── ui.ts                    # _weReadProps, _weBindUI button wiring (L16379–17200)
│   ├── styles/                      # CSS modules, one per UI cluster
│   │   ├── base.css                 # html/body/canvas + body.pc / body.mob
│   │   ├── carSelect.css            # #carSelect, .cs-item, .cs-swatch (L16–33)
│   │   ├── mobileControls.css       # #mctrl, .steer-zone, .pedal-zone (L34–~200)
│   │   ├── steeringWheel.css        # .steer-wheel, sw-svg, rim gradients
│   │   ├── pedals.css               # .pedal-bar, .pfill, .ptick, .pthumb
│   │   ├── shiftKnob.css            # shift knob + #skGearText
│   │   ├── worldEditor.css          # #weOverlay, #weTopBar, #weCanvas, weBtn*
│   │   └── nameOverlay.css          # the DOM portrait/name/age picker
│   └── platform/
│       ├── index.ts                 # detect web vs tauri vs capacitor
│       ├── web.ts                   # browser baseline
│       ├── desktop.ts               # Tauri hooks: file I/O for save export, gamepad rumble parity, window control
│       └── mobile.ts                # Capacitor hooks: haptics, in-app billing (DLC cars?), share, splash
├── src-tauri/                       # Tauri desktop shell (added in Phase D1)
├── android/                         # Capacitor Android project (added in Phase M1)
└── ios/                             # only if you ever target App Store
```

---

## 4. Extraction order (commit-by-commit)

**Principle:** start with the lowest-coupling extractions to validate the pipeline. Each commit is a single ES-module pull-out plus a passing playthrough check. **Do not refactor while extracting.** Tidy passes come later.

### Phase 0 — scaffolding (1 commit)

1. `chore: init vite + ts scaffold alongside existing HTML`
   - `npm init -y`, install vite, typescript, @types/node
   - Add `vite.config.ts` with `publicDir: 'public'`
   - Create `index.html` with `<script type="module" src="/src/main.ts">`
   - Stub `src/main.ts` that just throws "not yet wired"
   - Existing `driver_city_charlotte_v8_99_126_89.html` keeps running unchanged — Vite app lives in parallel until cut-over

### Phase A — static data (5–7 commits, no behavior change)

These have zero behavior coupling — pull them first to prove the import path works end-to-end.

2. `refactor(config): extract version constant`
3. `refactor(config): extract cars/manifest.ts` (lines 1659–1994)
4. `refactor(config): extract cars/gt4Database.ts` (5894–6772)
5. `refactor(config): extract cars/msrp.ts + brandTiers.ts + pricing.ts`
6. `refactor(config): extract world/highways.ts + majorRoads.ts + crossings.ts`
7. `refactor(config): extract jobs/housing/parts/traffic data tables`

After Phase A, ~7000 lines of pure data have moved out. Game still imports them via a transitional shim.

### Phase B — leaf systems (8–12 commits)

Subsystems with narrow surface area and no upward dependencies.

8. `refactor(engine): extract sprites + assets loader` — **also move asset files into `public/sprites/`** and replace raw GitHub URLs with `import.meta.url`-relative paths
9. `refactor(engine): extract audio (init, sfxLoader, v8Engine, tireGrain)`
10. `refactor(engine): extract particles`
11. `refactor(engine): extract shadows + patterns`
12. `refactor(engine): extract tilt + resize`
13. `refactor(save): extract persistence + carCondition + schema with v9.0.0 migration`
14. `refactor(input): extract keyboard + gamepad + touch + controlLayout`
15. `refactor(sim): extract finance + credit + jobs + newspaper + faults + health + race + pursuit`

### Phase C — render and physics (8–10 commits)

The two monoliths. Extract `render()` first because the z-order phases are already cleanly comment-delimited.

16. `refactor(render): extract render() orchestrator + ground.ts + foregroundProps.ts`
17. `refactor(render): extract roads + intersections + skidMarks + speedTrail`
18. `refactor(render): extract trafficCop + tow + trailer + headlightShadows`
19. `refactor(render): extract carBody + carBodyV2 + damage`
20. `refactor(render): extract gauges + canvasHud + crt`
21. `refactor(physics): extract vehicle + tire + steering` — **deduplicate the 3× power-steering-fault block** into one `applyPowerSteeringFault()` (audit found at L24851, L26076, L26082)
22. `refactor(physics): extract movement + legacyMovement + gearAndRpm`
23. `refactor(physics): extract trailer + collision + fuel`
24. `refactor(world): extract bridges + buildings + surfaces + roadProfiles`
25. `refactor(world): extract traffic/{spawn,ai,cop,semis,tow}`

### Phase D — UI (6–8 commits)

26. `refactor(ui): extract router (modal cascade + click dispatcher)`
27. `refactor(ui): extract hud/{speedoSvg,rpmGauge,minimap,canvasHud}`
28. `refactor(ui): extract screens/title + nameEntry + jobSelect + carSelect`
29. `refactor(ui): extract screens/home/{index,garage,mail,eat}`
30. `refactor(ui): extract screens/home/{housing,bills,newspaper,calendar} + office`
31. `refactor(ui): extract modals (purchase, repair, inspection, seller, realtor, pinPicker, confirm)`
32. `refactor(ui): extract overlays/fullMap + raceHud + notif`

### Phase E — world editor (2 commits)

33. `refactor(editor): extract editor/* (7,500 lines, one big extraction since it's already self-contained)`
34. `feat(editor): gate behind DEV_MODE env var` — production builds strip the editor; dev/internal builds keep it. See §6.4.

### Phase F — cleanup (3 commits)

35. `chore: delete commented-out placeGasAlongI485 block (L17496–17561) + other dead code`
36. `chore: strip _diagOff* perf overlays from production build via Vite define`
37. `chore: remove the version-history inline comments` — they're invaluable, but they belong in `CHANGELOG.md` (extract them) and git history, not in the shipped JS bundle. ~1200 markers, ~40k characters of comments.

### Phase G — store packaging (parallel after Phase A is done)

38. `feat(desktop): add Tauri shell` (`cargo tauri init`)
39. `feat(desktop): wire save-file import/export via Tauri fs API`
40. `feat(mobile): add Capacitor android project`
41. `feat(mobile): wire haptic feedback via Capacitor Haptics`
42. `feat(mobile): wire in-app review prompt`
43. `feat(input): gamepad rumble parity across platforms`

**Total: ~43 commits over a manageable migration window.** Each is testable in isolation by reloading the game and playing through.

---

## 5. Cleanup catalog (line-anchored)

### 5.1 Outright dead code (delete in Phase F)

| Lines | What | Action |
|---|---|---|
| 17496–17561 | `placeGasAlongI485()` — 66-line commented-out function | Delete |
| 2586–2587 | `_asphaltPatternAsphaltOld`, `_asphaltPatternConcreteOld` orphan globals | Verify zero refs, delete |
| 22792 | `_cruiseBtnRect={x:-999...}` legacy (cruise is now HTML button) | Delete |
| 23157 | `STEER_DEAD_ZONE=0.10` — explicitly marked `legacy — unused on rotational path` | Delete |
| 1217 | World editor SVG defs `swSpokeHG/swSpokeVG/swHubG` — referenced by removed elements | Delete from `worldEditor.css`/SVG section |

### 5.2 Save-schema legacy fields (handle in `save/schema.ts`)

These fields exist for backward-compat with old saves. The migration must preserve them on import, then drop them on write.

| Line | Field | Status |
|---|---|---|
| 7891 | `LIFE.portrait` | DEPRECATED v8.99.122.46 (pre-v46 saves) |
| 7909 | `LIFE.meals` | Replaced by `foodStock` |

Migration path: `migrate.ts` reads any of v8.x localStorage shapes, normalizes to v9.0.0 internal shape, writes only the new shape. Old shapes are read-only.

### 5.3 Duplicated logic to consolidate

| Location | Issue | Fix |
|---|---|---|
| L24851, L26076, L26082 | `_psMph=absSpd/SCALE_MS*2.237; _psLo=Math.max(0,1-_psMph/25); pAngVel*=1-0.60*_psLo` — copy/pasted 3× | Extract `applyPowerSteeringFault(pAngVel, absSpd)` to `physics/steering.ts` |
| L24134, L24262 | Trailer-mass-from-loadWeight computed in two places | Extract `getTrailerKg(LIFE.trailer)` to `physics/trailer.ts` |
| canvas vs SVG | Gauges drawn on both canvas (fallback) and SVG (preferred) | Acceptable today; document the fallback contract in `ui/hud/canvasHud.ts` header |

### 5.4 Strippable in production builds

| Lines | What | How to strip |
|---|---|---|
| 43920–43925 | `_diagOff*` flags | Vite `define: { __DEV__: false }` + dead-code elimination |
| 43904–44039 | Perf bucket tracking, `_pf_*` calls | Same |
| 20786–20794 | Diagnostic keyboard shortcuts (keys 1–6, 0) | Same |
| Various | `console.log('[VehicleSprites]', ...)`, gamepad detect logs | `vite-plugin-remove-console` |
| 1186–1494 | Inline version-history comments embedded in CSS/HTML | Build step extracts them to `CHANGELOG.md`, source omits |
| Multiple `//v8.99.X: REVERTED` block comments | ~1200 markers | Same — move to CHANGELOG before delete |

---

## 6. Store-readiness checklist

### 6.1 Asset bundling — **mandatory before any store submission**

The raw GitHub URLs at the following locations **must** become local imports:
- L1659 — `VEHICLE_IMAGE_BASE`
- L5805–5808 — `PORTRAIT_URLS` (i.postimg.cc — also remove this dependency)
- L5848 — `CHARACTER_BASE_URLS`
- L9162 — title screen image
- L18031 — `SFX_BASE` (audio samples)
- L20394 — car logo base path

Reasons it's mandatory:
1. **Play Store policy** disallows runtime fetching of executable/asset content from non-CDN sources.
2. **Steam cert** expects offline play.
3. **Latency** — raw GitHub fetches are slow on first load and rate-limited.
4. **Versioning** — if you ever rename a sprite in the repo, every existing player's game breaks until reload.

After move: each asset import becomes `import carPng from '@/assets/sprites/cars/Honda-Civic-Blue.png'` and Vite hashes/optimizes it.

### 6.2 Save migration

Build a one-time migrator that:
- Reads `localStorage.driverCitySave` if present
- Detects v8.99.x shape (presence of `LIFE.portrait`, `LIFE.meals`, etc.)
- Translates to v9.0.0 shape
- Writes back under a versioned key (`driverCitySave_v9`)
- Keeps the old key as read-only fallback for 1 major version

Also migrate the World Editor keys: `driverCity_worldEditor_v1..v4` → `driverCity_worldEditor_v9`.

### 6.3 Input abstraction (gamepad)

You already poll the Gamepad API for `gpA/gpB/gpStart/gpDpad*` etc. (L20111–20280). For Steam:
- Verify haptics work via Gamepad API's `vibrationActuator` (already wired at L20262 — good)
- Test Xbox + DualSense + Switch Pro on Steam Input
- Tauri lets the OS handle Steam Input transparently — no extra work

For mobile:
- Capacitor Haptics for crash/shift feedback
- Touch controls already exist — verify on real hardware (the steer wheel + pedal SVGs)

### 6.4 World Editor decision

**Recommendation: ship it, but gate it.**

| Option | Pros | Cons |
|---|---|---|
| **A. Ship enabled by default** | Modding community, replay value | Player-drawn bridges have no collision (debt from v126.22). Could embarrass for cert review. |
| **B. Strip from production** | -7500 lines, faster boot | Loses a real differentiator. Throws away 3 months of editor work. |
| **C. Ship gated behind in-game "Developer Tools" toggle** ← my pick | Available to enthusiasts, hidden from store reviewers | One line of gating + a settings flag |

Implementation for C: add `LIFE.devToolsEnabled` (default false), gate `_weEntryBtn` visibility and F9 binding on it, expose toggle in Options → Advanced. Cert reviewers won't see it; players who want it find it.

### 6.5 Other store-cert items

- **Privacy policy** — required for Play Store. Even if you don't collect data, the app declares "no data collected" in a Data Safety form.
- **Content rating** — IARC questionnaire. Driving + occasional cop pursuit reads as 7+/PEGI 7. Confirm no in-game gambling triggers AO rating (the haggling system is fine).
- **Icon + screenshots + trailer** — 512×512 icon, feature graphic, 2–8 screenshots per orientation. Plan a shot list.
- **In-app purchases** (if any) — billing wiring via Capacitor + Google Play Billing.
- **Anti-cheat** (Steam only) — VAC is opt-in; you almost certainly don't need it for a single-player racer.

---

## 7. Open decisions for you

Before I start the migration in earnest, I need your call on:

1. **Editor in production?** A / B / C from §6.4. My recommendation: **C**.
2. **TypeScript adoption pace?** All-at-once (rewrite types as we extract) vs gradual (`// @ts-check` per file). My recommendation: **gradual**.
3. **Desktop wrapper?** Tauri vs Electron. My recommendation: **Tauri** (5 MB binary, ~$0 Steam overhead).
4. **Migration cadence?** Do you want me to do Phases A–F end-to-end as a single sprint, or one phase at a time with your validation between each?
5. **Sprite/audio repository.** Right now sprites + audio are committed to the same repo. Fine for now (they're small enough), but >100 MB triggers Git LFS — worth setting up before they grow further. Yes/no?
6. **In-game branding pivot?** The title still reads "DRIVER CITY — GBC Racer v8.99.126.79" — confirm the production name (Steam page title) so the migration sets the canonical string in `config/version.ts` once.

---

## 8. Time estimate (rough)

| Phase | Effort |
|---|---|
| Phase 0 (scaffold) | 1 session |
| Phase A (static data) | 1 session |
| Phase B (leaf systems) | 2–3 sessions |
| Phase C (render + physics) | 3–4 sessions |
| Phase D (UI) | 2–3 sessions |
| Phase E (editor) | 1 session |
| Phase F (cleanup) | 1 session |
| Phase G (Tauri + Capacitor scaffolding) | 1–2 sessions |
| Store cert prep (icons, screenshots, listing) | separate effort |

**Total code migration:** ~12–15 focused sessions to reach a fully-modularized, store-wrappable state. None of these require rewrites; they are mechanical extractions on a clean baseline.
