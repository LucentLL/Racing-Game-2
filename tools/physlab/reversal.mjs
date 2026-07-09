// H1101 reversal probe: steer FULL LEFT then FULL RIGHT at 60 mph — the user's
// "shifting the wheel left to right" maneuver that H1099 made oscillate ("rear
// warps left to right"). Reports the slip-angle trace through the reversal and
// an oscillation score (sign reversals of d(slip)/dt after the transition,
// i.e. how many times the rear swings back).
// Build the bundle first (captures repo state):
//   npx esbuild tools/physlab/entry.ts --bundle --alias:@=./src --format=esm --outfile=tools/physlab/physlab.mjs
// Then: node tools/physlab/reversal.mjs <label>
import {
  createPhase0BIntegratorState,
  tickPhase0BIntegrator,
  buildPhase0BCarSpec,
  computeCarTurnRate,
  computeDesiredYawRate,
  computeMassDamp,
  computeEffectiveSteerInput,
  CAR_CATALOG,
  GT4_SPECS,
  SCALE_MS,
  MPH_PER_MS,
} from './physlab.mjs';

const label = process.argv[2] ?? 'run';
const car = Object.values(CAR_CATALOG).find((c) => /RX-7 GT-Limited/i.test(c.name));
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

function makeState(mph) {
  const v0 = (mph / MPH_PER_MS) * SCALE_MS;
  const state = createPhase0BIntegratorState(5000, 5000, 0, v0);
  let gear = 1;
  for (let g = 1; g <= car.gears; g++) if (car.gearSpeeds[g] < v0) gear = Math.min(car.gears, g + 1);
  state.pGear = gear;
  state.pRpm = 4000;
  return state;
}

function tick(state, steerAxis, gas) {
  const absSpd = Math.abs(state.pSpeed);
  const massDamp = computeMassDamp(spec.mass, null);
  const speedRatio = Math.min(1, absSpd / spec.topSpeed);
  const spdFactor = Math.min(1, absSpd / 10);
  const steerInputEff = computeEffectiveSteerInput(steerAxis, spec.isBike, 1.0);
  const isThrottle = gas && absSpd > 3;
  const pAngVel = computeDesiredYawRate({
    steerInputEff, steerInput: steerAxis,
    pDrifting: state.pDrifting, pSpeed: state.pSpeed, slipAngle: state.pSlipAngle,
    turnRate, drivetrain: spec.drivetrain,
    speedRatio, spdFactor, massDamp, absSpd,
    gas, brake: false, brakeAmount: 0, isThrottle,
    onGrass: false, hasTrailer: false,
    steerSlow: false, engineStallActive: false, steerPull: 0,
  });
  tickPhase0BIntegrator(state, {
    gas, brake: false, ebrk: false,
    steerAxis, brakeAmount: 0, gasAmount: gas ? 1 : 0,
    pAngVel, sensSlider: 1.0, spdFactor,
    isManual: false, isWelded: false, supercharged: false,
    dt, onGrass: false, onDirt: false,
    faults,
    worldW: 100000, worldH: 100000,
    collide: () => false,
    isSemiWithTrailer: false,
  }, spec, settings);
}

// steer +1 for 1.0 s (settle into the left corner), flip to -1 at t=1.0 s,
// hold 2.0 s. Track slip through the reversal.
const st = makeState(60);
const slips = [];
const yaws = [];
for (let i = 0; i < 180; i++) {
  const t = i * dt;
  tick(st, t < 1.0 ? 1 : -1, true);
  slips.push(st.pSlipAngle * 180 / Math.PI);
  yaws.push(st.pYawRate);
}
// Oscillation score AFTER the flip (t>1.0s): local extrema of slip — a clean
// transition has ONE swing to the new steady value (0-1 extrema); a pendulum
// ping-pongs (3+).
const post = slips.slice(60);
let extrema = 0;
const marks = [];
for (let i = 1; i < post.length - 1; i++) {
  const a = post[i] - post[i - 1], b = post[i + 1] - post[i];
  if ((a > 0.02 && b < -0.02) || (a < -0.02 && b > 0.02)) { extrema++; marks.push({ t: (1 + i * dt).toFixed(2), slip: post[i].toFixed(2) }); }
}
const steadyL = slips[58].toFixed(2);
const steadyR = slips[176].toFixed(2);
console.log(JSON.stringify({
  label,
  steadyLeftSlipDeg: steadyL,
  steadyRightSlipDeg: steadyR,
  postFlipExtrema: extrema,
  extremaMarks: marks.slice(0, 8),
  trace10hz: slips.filter((_, i) => i % 6 === 0).map((v) => +v.toFixed(1)),
}, null, 1));
