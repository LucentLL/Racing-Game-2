/**
 * H1304: the INSPECT component map — WHAT a component is made of, which
 * hidden faults each sub-component can surface, and what the player's tools
 * let them actually reach.
 *
 * This data used to live in the garage overlay (H1299). It moved here so the
 * SIM side can answer the question the X-ray now needs answered:
 *
 *   "has this component actually been inspected, and did that inspection
 *    miss anything it should have caught?"
 *
 * Keeping ONE authority matters — the overlay walks this map to paint and
 * hit-test the sub buttons, and inspectOwnCar walks the SAME map to decide
 * whether a component has earned its condition color. If they were two
 * lists they would drift, and the X-ray would start lying again.
 *
 * See docs/INSPECT_SPEC.md §3 (sub-component map) and §4 (the roll).
 */

import type { XrayComponentId } from '@/render/carBody/xrayDrivetrain';
import type { PreFault } from '@/ui/modals/inspection';
import type { LifeState } from '@/state/life';
import { ensureToolbox } from '@/sim/toolbox';

/** H1300 (spec §4): the underside-VISUAL subset of TEST_DRIVE_ONLY —
 *  inspectable parked ONLY with the car on the Two-Post Lift (torn boots
 *  and scored rotors are visible on a lift). Powertrain/sensor TD ids
 *  deliberately stay drive-only so test drives keep their value. */
export const LIFT_VISIBLE_TD_IDS: readonly string[] = [
  'strut_wear', 'strut_bushings', 'control_arm_bush', 'control_arm_rust',
  'ball_joint', 'bushing_clunk', 'air_susp_leak', 'ps_leak',
  'rotor_warp', 'sport_brake_wear',
];

export interface InspectSub {
  key: string; label: string; ids: readonly string[];
  underside?: boolean; liftOnly?: boolean;
  /** H1300: borescope bonus applies (engine internals). */
  scope?: boolean;
  /** H1300: needs the wheel off — impact wrench (or lift) required for a
   *  real look; without either the roll is capped low. */
  wheelOff?: boolean;
  found: string; clean: string;
}

/** H1299: the FULL sub-component map (docs/INSPECT_SPEC.md §3) — every
 *  FAULT_POOLS id reachable somewhere. `ids` = hidden-fault ids a sub can
 *  reveal; [] = flavor-only (checking things that turn out fine IS the
 *  fiction). `underside` takes the jack penalty; `liftOnly` (frame rails)
 *  refuses without the Two-Post Lift. Test-drive-only ids hint instead
 *  of revealing (inspectFaultIds enforces the invariant). */
export const INSPECT_SUBS: Record<XrayComponentId, ReadonlyArray<InspectSub>> = {
  engine: [
    { key: 'plugs', label: 'SPARK PLUGS', ids: ['spark_plugs'],
      found: 'Spark plugs are showing their age — these need replacing.',
      clean: 'Plugs look healthy, no oil on the threads.' },
    { key: 'headgasket', label: 'HEAD GASKET', ids: [], scope: true,
      found: '', clean: 'No seepage at the head mating surface. Looks sound.' },
    { key: 'throttle', label: 'THROTTLE BODY', ids: [], scope: true,
      found: '', clean: 'Throttle plate is a little sooty but moves freely.' },
    { key: 'intake', label: 'INTAKE MANIFOLD', ids: ['intake_manifold', 'carbon_buildup'], scope: true,
      found: 'The intake shows real problems — get this seen to.',
      clean: 'Intake looks okay from the outside.' },
    { key: 'timing', label: 'TIMING COVER', ids: ['timing_belt', 'timing_chain'], scope: true,
      found: 'The timing gear is past due — get it done before it lets go.',
      clean: 'Belt and tensioner look serviceable.' },
    { key: 'valvecover', label: 'VALVE COVER', ids: ['valve_cover_gasket'],
      found: 'Oil seep along the valve cover gasket — needs a reseal.',
      clean: 'Cover is clean and dry.' },
    { key: 'oilpan', label: 'OIL PAN', ids: ['oil_leak', 'oil_pan_gasket'], underside: true,
      found: 'Oil weeping around the pan — found the leak.',
      clean: 'Pan is dry, as far as you can see from under the jack.' },
    { key: 'sensors', label: 'SENSORS & WIRING', ids: ['o2_sensor', 'cam_sensor', 'electrical_sensor'],
      found: 'A sensor connector crumbles in your fingers.',
      clean: 'Wiring looks intact from here.' },
    { key: 'battery', label: 'BATTERY & ALTERNATOR', ids: ['alternator', 'battery_drain'],
      found: 'The charging system is on its way out.',
      clean: 'Battery terminals are clean; belt spins the alternator fine.' },
  ],
  transmission: [
    { key: 'transpan', label: 'FLUID & PAN', ids: ['trans_hesitation', 'trans_slip'], underside: true,
      found: 'The transmission needs real work.',
      clean: 'Fluid level looks right from the dipstick.' },
    { key: 'clutch', label: 'CLUTCH & LINKAGE', ids: [],
      found: '', clean: 'Linkage moves cleanly through the gates.' },
    { key: 'mounts', label: 'MOUNTS', ids: [],
      found: '', clean: 'Mounts show normal cracking, nothing loose.' },
  ],
  driveline: [
    { key: 'propshaft', label: 'PROP SHAFT & U-JOINTS', ids: [],
      found: '', clean: 'No play in the U-joints.' },
    { key: 'diff', label: 'DIFFERENTIAL', ids: [], underside: true,
      found: '', clean: 'Diff housing is dry, no whine on the last drive.' },
    { key: 'cvboots', label: 'CV BOOTS', ids: [], underside: true,
      found: '', clean: 'Boots are intact, no grease sling.' },
  ],
  cooling: [
    { key: 'radcore', label: 'RADIATOR CORE', ids: ['cooling_fail'],
      found: 'The cooling system is failing — crusted fins and dried coolant.',
      clean: 'Core fins are straight, no crust.' },
    { key: 'hoses', label: 'HOSES & CLAMPS', ids: ['cooling_fail'],
      found: 'A hose is swollen and soft — cooling trouble.',
      clean: 'Hoses feel firm, clamps tight.' },
    { key: 'waterpump', label: 'WATER PUMP', ids: ['timing_belt'],
      found: 'Weep hole shows deposits — the pump (and belt) are due.',
      clean: 'No weeping at the pump.' },
    { key: 'overflow', label: 'OVERFLOW TANK', ids: [],
      found: '', clean: 'Coolant sits at the line, the right color.' },
  ],
  steering: [
    { key: 'tierods', label: 'TIE ROD ENDS', ids: [],
      found: '', clean: 'No play in the tie rod ends.' },
    { key: 'pslines', label: 'PS PUMP & LINES', ids: ['ps_leak'], underside: true,
      found: 'Power steering fluid tracks down the lines.',
      clean: "Lines are damp with road film but nothing's leaking." },
    { key: 'rackboots', label: 'RACK BOOTS', ids: [],
      found: '', clean: 'Rack boots are intact.' },
  ],
  suspension: [
    { key: 'struts', label: 'STRUTS & SHOCKS', ids: ['strut_wear', 'strut_bushings'], underside: true,
      found: 'A strut is leaking oil down its body.',
      clean: 'Struts look dry from this angle.' },
    { key: 'controlarms', label: 'CONTROL ARMS & BUSHINGS', ids: ['control_arm_bush', 'control_arm_rust', 'bushing_clunk'], underside: true,
      found: 'A bushing is cracked through.',
      clean: 'Bushings look whole from here.' },
    { key: 'balljoints', label: 'BALL JOINTS', ids: ['ball_joint'], underside: true,
      found: 'A ball joint boot is torn open.',
      clean: 'Joints feel tight with the wheel rocked.' },
    { key: 'springs', label: 'SPRINGS & AIR BAGS', ids: ['air_susp_leak'], underside: true,
      found: 'The air suspension is losing pressure somewhere.',
      clean: 'Springs sit even side to side.' },
    { key: 'endlinks', label: 'SWAY BAR END LINKS', ids: [], underside: true,
      found: '', clean: 'End links are snug.' },
  ],
  wheels: [
    // H1304: 'alignment' was the one FAULT_POOLS id with no sub anywhere, so
    // WHEELS could go green with a hidden alignment fault still on the car —
    // which falsifies the whole point of the color. Feathered tread is
    // exactly how you spot it, so it belongs on the tire check.
    { key: 'tires', label: 'TIRES', ids: ['tire_wear', 'alignment'],
      found: 'The tires are worn to the bars — replace them.',
      clean: 'Tread depth looks fine all round.' },
    { key: 'pads', label: 'BRAKE PADS', ids: ['sport_brake_wear'], wheelOff: true,
      found: 'Pads are down to the backing plates.',
      clean: 'Pad material looks adequate through the spokes.' },
    { key: 'rotors', label: 'ROTORS', ids: ['rotor_warp'], wheelOff: true,
      found: 'Rotors are scored and lipped.',
      clean: 'Rotor faces look smooth.' },
    { key: 'bearings', label: 'WHEEL BEARINGS', ids: [],
      found: '', clean: 'No growl or play at the bearings.' },
  ],
  body: [
    { key: 'paint', label: 'PAINT & TRIM', ids: ['paint_fade', 'paint_bubble', 'minor_rust'],
      found: 'The finish is going — bubbling and surface rust.',
      clean: 'Paint holds up under a close look.' },
    { key: 'panels', label: 'PANELS & BUMPERS', ids: ['panel_rust', 'bumper_crack', 'bumper_dent'],
      found: 'Panel damage and rot you missed before.',
      clean: 'Panels line up, no filler rings when you knock.' },
    { key: 'framerails', label: 'FRAME RAILS', ids: ['frame_rust'], liftOnly: true, underside: true,
      found: 'The frame rails are rotten — structural.',
      clean: 'Rails look solid where you can reach.' },
    { key: 'exhaust', label: 'EXHAUST', ids: ['exhaust_rust', 'exhaust_rot'], underside: true,
      found: 'The exhaust is rotting through.',
      clean: 'System is surface-rusty but solid when you tap it.' },
    { key: 'interior', label: 'INTERIOR & ELECTRONICS', ids: ['trim_rattle', 'display_failure', 'electrical_gremlin'],
      found: 'Something electrical is wrong in here.',
      clean: 'Switchgear all works; trim is tight.' },
  ],
};

/** Spec §2's canonical 1..8 order — used by the focus-view component
 *  switcher and anything else that walks components in a fixed sequence. */
export const INSPECT_ORDER: readonly XrayComponentId[] = [
  'engine', 'transmission', 'driveline', 'cooling',
  'steering', 'suspension', 'wheels', 'body',
];

/** Which inspection tools the player owns. Shapes both what they can reach
 *  and, therefore, what a miss actually means. */
export interface InspectTools { lift: boolean; impact: boolean; scope: boolean }

export function inspectToolsFor(life: LifeState): InspectTools {
  const box = ensureToolbox(life);
  const has = (id: string): boolean => box.some((t) => t.id === id && (t.qty ?? 1) > 0);
  return { lift: has('two_post_lift'), impact: has('impact_wrench'), scope: has('borescope') };
}

/** Can the player perform this sub-check at all right now? Frame rails
 *  refuse without a lift — so they are not part of "you checked everything
 *  you could", or BODY would be gray-locked behind a $2,200 purchase. */
export function isSubReachable(sub: InspectSub, tools: InspectTools): boolean {
  return !(sub.liftOnly && !tools.lift);
}

/** H1300: the test-drive-only ids THIS sub may reveal given the tools —
 *  mirrors the `allowTD` computation in the garage roll handler exactly. */
export function allowedTestDriveIds(sub: InspectSub, tools: InspectTools): readonly string[] {
  const liftReach = tools.lift && (sub.underside || sub.liftOnly);
  const wheelReach = (tools.impact || tools.lift) && sub.wheelOff;
  if (!liftReach && !wheelReach) return [];
  return sub.ids.filter((id) => LIFT_VISIBLE_TD_IDS.includes(id));
}

/** Could a stationary inspection of `comp` have surfaced this fault?
 *
 *  This is the guard that keeps the gray rule honest WITHOUT creating dead
 *  ends. A fault the player could never find while parked (the powertrain
 *  and sensor TEST-DRIVE-ONLY ids) must not hold a component gray forever —
 *  the UI already tells them "worth a test drive", and driving or a shop
 *  visit surfaces it. A fault they COULD have found and missed is exactly
 *  the "failed to accurately inspect" case, and DOES hold it gray. */
export function isFaultStationaryReachable(
  f: PreFault, comp: XrayComponentId, tools: InspectTools,
): boolean {
  for (const sub of INSPECT_SUBS[comp] ?? []) {
    if (!isSubReachable(sub, tools)) continue;
    if (!f.id || !sub.ids.includes(f.id)) continue;
    if (!f.testDriveOnly) return true;
    if (allowedTestDriveIds(sub, tools).includes(f.id)) return true;
  }
  return false;
}

/** Every component a fault id can be found under (ids are shared — a hidden
 *  timing_belt is reachable from both ENGINE and COOLING). */
export function componentsForFaultId(id: string): XrayComponentId[] {
  const out: XrayComponentId[] = [];
  for (const comp of INSPECT_ORDER) {
    if ((INSPECT_SUBS[comp] ?? []).some((s) => s.ids.includes(id))) out.push(comp);
  }
  return out;
}
