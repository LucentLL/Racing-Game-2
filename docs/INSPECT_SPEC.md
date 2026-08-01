# INSPECT — visual X-ray inspection (replaces DIAGNOSE)

**Status: DRAFT — awaiting user sign-off. Decisions marked ► are open.**

User spec (2026-08-02 playtest, canonical):

> Diagnose should be Inspect, and allow player to visually inspect the car
> components with X-ray. Having a lift or jack/jack stands increases chance
> of finding issues. When selecting a component, it should be highlighted
> and display information.
>
> Ex: Viewing complete car X-ray. Select Engine. Screen transitions to focus
> on engine, text may say "hard to get a view from underneath without
> raising the car, but no leaks are seen on the garage floor."
> Which component would you like to inspect?
> \>Spark Plugs / Head Gasket / Throttle Body / Intake
> "Spark plugs are showing their age, but no sign of oil on them."
> [player leaves inspection menus]
> Inspection Results: Replace Spark Plugs

---

## 1. Why this is mostly reuse

- **The X-ray is a car-local vector drawing** behind one translate+scale
  (`carSpritePreview.ts:21`). "Focus on engine" = the same draw at ~3× scale,
  translated to the component's center (all centers recompute from
  `xrayCarGeom` + the layout formulas in `xrayDrivetrain.ts`), clipped to the
  panel. Only tweak: divide the outline's car-unit lineWidth/dash by zoom.
- **`previewDepsForCar(car, xrayCond, bodyDamage)`** (H1284) renders any
  catalog car as a condition-tinted X-ray with no live PlayerState — built
  for exactly this.
- **`inspectOwnCar`** (H948) is the reveal engine: rolls `_hiddenFaults`,
  flips `detected`, pushes copies into `life.faults` (REPAIRS lists them
  automatically). INSPECT extends it with a sub-component filter + per-fault
  chance instead of the flat thorough scan.
- **The seller-visit menu** (`seller.ts:332`) is the UI pattern for
  "focus header + growing flavor-text band + stacked action buttons" —
  paint and hit-test walk the same action list so they can't drift.
- **Skill + tools exist**: 6-category `catSkill` (`repairSkills.ts`),
  `categoryForFault`, and the toolbox ("Floor Jack + Stands" is already in
  the STARTER kit — the jack baseline is free; the LIFT is the new purchase).

Net-new machinery: component hit-rects on the X-ray, the sub-component menu
screen, and the results summary. That's it.

## 2. Component map (8 tappable zones)

Every one of the 40 FAULT_POOLS ids has a home — nothing is unreachable.

| # | Component (X-ray element) | Faults it can reveal |
|---|---|---|
| 1 | **ENGINE** (block) | spark_plugs, timing_belt, timing_chain, valve_cover_gasket, oil_leak, oil_pan_gasket, intake_manifold, carbon_buildup, o2_sensor, cam_sensor, electrical_sensor, alternator, battery_drain |
| 2 | **TRANSMISSION** (gearbox + transfer case) | trans_hesitation, trans_slip |
| 3 | **DRIVELINE** (props, diffs, halfshafts) | — flavor-only today; impact `drv_*` faults + future ids land here |
| 4 | **COOLING** (radiator) | cooling_fail (+ timing_belt via Water Pump) |
| 5 | **STEERING** (tie rods) | ps_leak, alignment |
| 6 | **SUSPENSION** (sway bars) | strut_bushings, strut_wear, control_arm_bush, control_arm_rust, ball_joint, bushing_clunk, air_susp_leak |
| 7 | **WHEELS & BRAKES** (tires) | tire_wear, rotor_warp, sport_brake_wear |
| 8 | **BODY** (outline / elsewhere) | minor_rust, panel_rust, frame_rust, paint_fade, paint_bubble, bumper_crack, bumper_dent, exhaust_rust, exhaust_rot, trim_rattle, electrical_gremlin, display_failure |

No-natural-home notes: exhaust lives under BODY (the renderer intentionally
draws no exhaust — an optional drawn exhaust line is polish slice H-E);
interior/electrical live under BODY › Interior & Electronics; battery under
ENGINE › Battery & Alternator.

## 3. Sub-component menus

Legend: **F** = flavor-only (reveals nothing — "checked it, looks fine" IS
the fiction; the user's own Head Gasket / Throttle Body picks are these),
**TD** = test-drive-only fault, shows a *hint* not a reveal,
**L** = underside (access rules §4).

- **ENGINE**: Spark Plugs → spark_plugs · Head Gasket **F** · Throttle Body
  **F** · Intake Manifold → intake_manifold **TD**, carbon_buildup **TD** ·
  Timing Cover → timing_belt, timing_chain · Valve Cover →
  valve_cover_gasket · Oil Pan **L** → oil_leak, oil_pan_gasket · Sensors &
  Wiring → o2/cam/electrical_sensor **TD** · Battery & Alternator →
  alternator, battery_drain **TD**
- **TRANSMISSION**: Fluid & Pan **L** → trans_* **TD** ("fluid is dark and
  smells burnt — worth a test drive") · Clutch & Linkage **F** · Mounts **F**
- **COOLING**: Radiator Core → cooling_fail · Hoses & Clamps → cooling_fail ·
  Water Pump → timing_belt · Overflow Tank **F**
- **STEERING**: Tie Rod Ends **F** · PS Pump & Lines **L** → ps_leak ·
  Rack Boots **F** · (alignment: TD hint only — can't be seen parked)
- **SUSPENSION** (all **L**): Struts & Shocks → strut_wear, strut_bushings ·
  Control Arms & Bushings → control_arm_bush/rust, bushing_clunk ·
  Ball Joints → ball_joint · Springs & Air Bags → air_susp_leak ·
  Sway Bar End Links **F**
- **WHEELS & BRAKES**: Tires → tire_wear · Brake Pads → sport_brake_wear
  (wheel-off) · Rotors → rotor_warp (wheel-off) · Wheel Bearings **F**
- **DRIVELINE**: Prop Shaft & U-Joints **F** · Differential **L** **F** ·
  CV Boots **L** **F**
- **BODY**: Paint & Trim → paint_fade, paint_bubble, minor_rust · Panels &
  Bumpers → panel_rust, bumper_crack, bumper_dent · Frame Rails **L**
  (lift REQUIRED) → frame_rust · Exhaust **L** → exhaust_rust, exhaust_rot ·
  Interior & Electronics → trim_rattle, display_failure, electrical_gremlin

Hint prose for TD faults comes free from `FAULT_EFFECTS[id].desc`.

## 4. Find-chance model

Per sub-component tap, per hidden fault mapped there:

```
p = clamp(base + skill + tools + access, 0.05, 0.95)
base   = f.detectChance ?? 0.5          (already on every PreFault)
skill  = catSkill[categoryForFault(f)] × 0.003   (+0.05 novice … +0.30 master)
tools  = borescope +0.15 (ENGINE internals) · LED lamp +0.05 (everywhere)
access = underside subs: LIFT +0.15 full access · jack only −0.10 · no jack: no roll
         wheel-off subs (Pads/Rotors): impact wrench required, else capped 0.15
```

- **Floor check** (automatic, free, on entering any focus view): rolls leak
  faults (oil_leak, oil_pan_gasket, ps_leak, air_susp_leak) at flat 0.25 —
  this is the user's "no leaks are seen on the garage floor" line.
- **Lift override**: 10 of the 19 TEST_DRIVE_ONLY ids are underside-VISUAL
  (struts, bushings, control arms, ball joints, air susp, ps_leak, rotors,
  brake pads). ► With a LIFT these become inspectable parked (torn boots and
  scored rotors ARE visible on a lift) — this is what makes the lift matter.
  The other 9 (trans, sensors, alignment, intake, carbon, battery) stay
  drive-only with hint text, preserving the test-drive economy.
- **New TOOL_SHOP items** (category `power` — the ToolItem union stays
  closed): **Two-Post Lift $2,200** (deliberately the biggest tool; hoist is
  $560) · **Borescope Camera $260** · LED Shop Lamp $35 (optional).
  Ride-along fix: junkyard's Used Engine pull gates on *category* 'power' —
  switch that gate to an id check so a $35 lamp can't stand in for the hoist.
- Successful finds grant small `trainCategory` XP (inspection teaches).

## 5. Economy: what replaces what

- The garage **DIAGNOSE button becomes INSPECT** (user: "Diagnose should be
  Inspect"). Free — your time and tools are the cost.
- ► The **$120 thorough scan relocates to the mechanic** as PRO DIAGNOSTIC
  (the low-skill/no-tools escape hatch; the overlay comment at
  `DIAGNOSE_FEE` already planned scoped scans).
- **Anti-spam (recommended combo)**:
  1. Entering INSPECT costs a **time slot** (`slotsActiveToday += 1`, the
     exact gym pattern — inspecting your whole fleet daily exhausts you via
     the existing overwork health penalty), and
  2. each sub-component **rolls once per car per day** (latch on the per-car
     condition record; a failed roll reads "looks fine to me" until
     tomorrow). Ride-along fix: today's `_lastInspectDay` latch is GLOBAL,
     not per-car — moves onto the car record.
  - ► Alternatives if the slot cost feels heavy: (a) daily latch only,
    no slot; (b) $5–15 shop-supplies fee per sub instead of the slot;
    (c) keep one global inspect/day (simplest, weakest fiction).

## 6. Flow (screens)

1. Garage → car → **INSPECT** → full-car X-ray (existing SPECS X-ray draw)
   with the 8 components tappable; selected component pulses.
2. Tap component → **focus view**: same X-ray zoomed ~3× onto the component
   (pure transform), flavor band prints the access line ("hard to get a
   view from underneath without raising the car…") + floor-check result,
   then the sub-component button stack (seller-menu pattern).
3. Tap sub-component → roll → prose line ("Spark plugs are showing their
   age, but no sign of oil on them." / "Fluid is dark and smells burnt —
   worth a test drive." / "Looks fine to me.")
4. BACK out → **INSPECTION RESULTS** summary panel: every fault revealed
   this session as "Replace Spark Plugs"-style recommendations → they're in
   REPAIRS from then on.
- Pad: d-pad cycles component rects, A selects (H1284 synthesized-click
  pattern), B backs out.

## 7. Build slices (one commit each)

- **H-A — minimum lovable (the user's example, verbatim)**: INSPECT entry on
  SPECS beside X-RAY; component hit-rects (`componentRectsFor` sharing the
  drawXrayDrivetrain layout math); focus-zoom + sub-menu for ENGINE only;
  floor check; reveals via extended `inspectOwnCar`; results summary.
  DIAGNOSE untouched.
- **H-B**: all 8 components + full 40-id map; underside/jack rules; per-car
  per-sub daily latch + slot cost; DIAGNOSE button replaced.
- **H-C**: lift + borescope in TOOL_SHOP (+ junkyard gate id fix); lift
  bonuses; lift-override of the underside TD subset; Frame Rails rule.
- **H-D**: $120 PRO DIAGNOSTIC at the mechanic; TD hint lines from
  FAULT_EFFECTS.
- **H-E — polish**: pad component cycling, pulsing highlight, typewriter
  flavor text, drawn exhaust line.

## 8. Pre-existing bugs found during recon (fix alongside)

1. `timing_chain` has **no FAULT_EFFECTS entry** — the fault is symptomless
   (39 entries vs 40 pool ids). One-liner.
2. **Used-fault id reuse**: "Engine Rebuild Needed"/"Engine Replacement"
   carry id `trans_slip`, "Fluid Top-Off Needed" carries `oil_leak`
   (`usedCarFaults.ts:104,119,132,95,109`) — an id-keyed map sends engine
   rebuilds to TRANSMISSION, and these rows never tint the gearbox today.
   Give them their own ids (or per-row overrides).
3. `_lastInspectDay` is global across the garage, not per-car (§5).

## ► Decisions for sign-off

1. Anti-spam: slot cost + daily sub-latch (recommended), or an alternative
   from §5?
2. Lift-override of the 10 underside TD-only faults: yes (recommended)?
3. Two-Post Lift at $2,200 / Borescope $260: price feel OK?
4. Relocate the $120 scan to the mechanic as PRO DIAGNOSTIC, or delete the
   paid tier entirely?
5. Slice H-A scope OK to build first?
