// H1250: does the tyre grip-utilisation signal actually do what the user asked?
//
//   "I don't feel or hear feedback from the tires when going through turns.
//    Low speed and high speed sound/feel the same. The tires should screech
//    when approaching grip limit before sliding."
//
// Three things have to be true, and this measures all three against the REAL
// Phase 0B physics (same gameLoop order fullcircle.mjs replicates):
//   1. SPEED DISCRIMINATION — the same steering input at higher speed must
//      produce a materially higher reading. (The whole complaint.)
//   2. PRE-LIMIT — the scrub threshold must be crossed BEFORE the car is
//      sliding, not after.
//   3. QUIET WHEN STRAIGHT / SLOW — no screech cruising in a straight line or
//      shuffling around the pits.
//
// Usage: node tools/physlab/tirescrub.mjs [carRegex]
import {
  createPhase0BIntegratorState,
  tickPhase0BIntegrator,
  buildPhase0BCarSpec,
  computeCarTurnRate,
  computeDesiredYawRate,
  computeMassDamp,
  computeEffectiveSteerInput,
  advancePSpeed,
  createTireLoadState,
  tickTireLoad,
  CAR_CATALOG,
  GT4_SPECS,
  SCALE_MS,
  WPX_PER_M,
  MPH_PER_MS,
} from './physlab.mjs';

const CARRX = new RegExp(process.argv[2] ?? 'RX-7 GT-Limited', 'i');
const car = Object.values(CAR_CATALOG).find((c) => CARRX.test(c.name))
  ?? Object.values(CAR_CATALOG)[0];
const spec = buildPhase0BCarSpec(car);
const turnRate = computeCarTurnRate(car, GT4_SPECS[car.name]);
const settings = {
  bicycleModel: true, dynPhysics0B: true,
  suspension: true, chassisI: true, downforce: true, lsd: true, tyreData: true,
  physDriftEnterThresh: 0, physMuBase: 0, physMassMomentum: 0, physMomentumCoef: 0,
  physBrakeDrift: 1, physArcadeAssist: 0.3,
  supercharger: true,
};
const faults = {
  accelMult: 1, brakeMult: 1, gripMult: 1, fuelMult: 1,
  steerPull: 0, steerSlow: false, engineStallActive: false,
  shiftMult: 1, rpmFlutter: false,
};
const dt = 1 / 60;
const SCRUB_START = 0.72;   // must match tireGrain

/** Hold a steady steering input at a target speed; return peak/steady grip use. */
function corner(mph, steer, secs = 4) {
  const v = (mph / MPH_PER_MS) * SCALE_MS;
  const st = createPhase0BIntegratorState(5000, 5000, 0, v);
  st.pGear = 3; st.pRpm = 4000; st.fuel = 1;
  const tl = createTireLoadState();
  let peak = 0, last = 0, maxSlip = 0, aLatPeak = 0;
  let prevAngle = NaN;
  const n = Math.round(secs / dt);
  for (let i = 0; i < n; i++) {
    // Hold speed (this probe is about lateral load, not acceleration).
    st.pSpeed = v;
    // Same call shape fullcircle.mjs uses — the integrator takes a fully
    // populated inputs object, not positional physics args.
    const absSpd = Math.abs(st.pSpeed);
    const massDamp = computeMassDamp(spec.mass, null);
    const speedRatio = Math.min(1, absSpd / spec.topSpeed);
    const spdFactor = Math.min(1, absSpd / 10);
    const steerInputEff = computeEffectiveSteerInput(steer, spec.isBike, 1.0);
    const pAngVel = computeDesiredYawRate({
      steerInputEff, steerInput: steer,
      pDrifting: st.pDrifting, pSpeed: st.pSpeed, slipAngle: st.pSlipAngle,
      turnRate, drivetrain: spec.drivetrain,
      speedRatio, spdFactor, massDamp, absSpd,
      gas: false, brake: false, brakeAmount: 0, isThrottle: false,
      onGrass: false, hasTrailer: false,
      steerSlow: false, engineStallActive: false, steerPull: 0,
    });
    tickPhase0BIntegrator(st, {
      gas: false, brake: false, ebrk: false,
      steerAxis: steer, brakeAmount: 0, gasAmount: 0,
      pAngVel, sensSlider: 1.0, spdFactor,
      isManual: false, isWelded: false, supercharged: false,
      dt, onGrass: false, onDirt: false,
      faults,
      worldW: 100000, worldH: 100000,
      collide: () => false,
      isSemiWithTrailer: false,
    }, spec, settings);
    st.pSpeed = v;
    const g = tickTireLoad(tl, st.pAngle, st.pSpeed, st.pSlipAngle ?? 0, 1, dt);
    // Raw lateral acceleration (m/s^2), for CALIBRATION — the ceiling in
    // tireLoad has to match what this arcade physics actually produces, not a
    // real-world 0.92 g, or the signal pins and stops discriminating.
    if (!Number.isNaN(prevAngle)) {
      let d = st.pAngle - prevAngle;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      const aLat = Math.abs((Math.abs(st.pSpeed) * (d / dt)) / WPX_PER_M);
      if (i > n * 0.35) aLatPeak = Math.max(aLatPeak, aLat);
    }
    prevAngle = st.pAngle;
    if (i > n * 0.35) {   // let the transient settle
      peak = Math.max(peak, g);
      last = g;
    }
    maxSlip = Math.max(maxSlip, Math.abs(st.pSlipAngle ?? 0));
  }
  return { peak, last, maxSlip, aLatPeak };
}

let fail = 0;
const check = (l, ok, d) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}${d ? '  ' + d : ''}`); if (!ok) fail++; };

console.log(`car: ${car.name}\n`);
console.log('steady-state cornering, steer = 0.55:');
const rows = [];
for (const mph of [15, 30, 45, 60, 80, 100]) {
  const r = corner(mph, 0.55);
  rows.push({ mph, ...r });
  console.log(`  ${String(mph).padStart(3)} mph  gripUse ${r.last.toFixed(2)}`
    + `  aLat ${r.aLatPeak.toFixed(1)} m/s2  maxSlip ${(r.maxSlip * 57.3).toFixed(1)} deg`
    + `  ${r.last > SCRUB_START ? '<-- SCRUB' : ''}`);
}
console.log('');

// 1. Speed discrimination — the complaint. The thing that matters is not a
//    raw ratio but that the same steering input lands on OPPOSITE SIDES of the
//    audible threshold: silent when ambling, singing when pressing on.
const slow = rows.find((r) => r.mph === 15).last;
const fast = rows.find((r) => r.mph === 80).last;
check('same steering: silent slow, scrubbing fast',
  slow < SCRUB_START && fast > SCRUB_START,
  `15 mph ${slow.toFixed(2)} vs 80 mph ${fast.toFixed(2)} (threshold ${SCRUB_START})`);

// 2. Quiet when it should be.
check('a slow corner does NOT scrub', slow < SCRUB_START, `15 mph = ${slow.toFixed(2)}`);
const straight = corner(80, 0.0);
check('straight-line cruising is silent', straight.peak < 0.05,
  `80 mph straight = ${straight.peak.toFixed(3)}`);
const park = corner(8, 1.0);
check('parking-speed manoeuvring is silent', park.peak < 0.05,
  `8 mph full lock = ${park.peak.toFixed(3)}`);

// 3. Pre-limit: something in the range must cross the threshold while the car
//    is still gripping (slip well under the 8 deg saturation reference).
const preLimit = rows.filter((r) => r.last > SCRUB_START && r.maxSlip * 57.3 < 8);
check('the scrub fires BEFORE the car is sliding', preLimit.length > 0,
  preLimit.length
    ? `first at ${preLimit[0].mph} mph (slip ${(preLimit[0].maxSlip * 57.3).toFixed(1)} deg)`
    : 'never crossed while still gripping');

// 4. It must be a RAMP, not a switch — the volume curve needs range to work in.
const spread = new Set(rows.map((r) => Math.round(r.last * 10))).size;
check('the signal is progressive, not binary', spread >= 4,
  `${spread} distinct levels across the speed sweep`);

// 5. It must RISE MONOTONICALLY while the car is still gripping. The first
//    pass calibrated the ceiling to a real-world 0.92 g and pinned at its cap
//    from 45 mph up — every fast corner read identical, i.e. the original
//    complaint relocated rather than fixed.
//    Only the gripping rows count: past the limit the car slides WIDE, so
//    lateral g stops rising (100 mph pulls no more than 80 despite 16 deg of
//    slip). That is correct physics, and the louder drift branch owns the
//    sound by then anyway.
const gripping = rows.filter((r) => r.maxSlip * 57.3 < 8);
let monotonic = true;
for (let i = 1; i < gripping.length; i++) {
  if (gripping[i].last <= gripping[i - 1].last) monotonic = false;
}
check('grip use rises with speed across the gripping range', monotonic && gripping.length >= 4,
  gripping.map((r) => `${r.mph}:${r.last.toFixed(2)}`).join(' '));

// 6. And the "at the limit" reading should land near 1.0 where the car
//    actually starts sliding (slip ~5.7 deg, the H1108 scrub threshold).
const atLimit = rows.reduce((a, r) =>
  Math.abs(r.maxSlip * 57.3 - 5.7) < Math.abs(a.maxSlip * 57.3 - 5.7) ? r : a);
check('gripUse ~= 1.0 where the car begins to slide',
  atLimit.last > 0.85 && atLimit.last < 1.25,
  `${atLimit.mph} mph: slip ${(atLimit.maxSlip * 57.3).toFixed(1)} deg -> ${atLimit.last.toFixed(2)}`);

console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
