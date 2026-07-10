// H1107 repro probe for the user's bug: "hold full lock + gas for a WHILE,
// flip to full lock the other way -> car goes perfectly straight despite the
// wheel; then gas off -> car still accelerates."
// Replicates the REAL gameLoop order per substep (gameLoop.ts:3057-3088):
//   1. advancePSpeed (arcade scalar owns longitudinal)
//   2. snapshot scalar pSpeed
//   3. tickPhase0BIntegrator (owns lateral/yaw/heading/position)
//   4. restore pSpeed = scalar
// Phases: A) full lock LEFT + gas holdSec, B) full lock RIGHT + gas 5s,
//         C) full lock RIGHT + gas OFF 5s.
// Usage: node tools/physlab/fullcircle.mjs <label> [holdSec=10]
import {
  createPhase0BIntegratorState,
  tickPhase0BIntegrator,
  buildPhase0BCarSpec,
  computeCarTurnRate,
  computeDesiredYawRate,
  computeMassDamp,
  computeEffectiveSteerInput,
  advancePSpeed,
  CAR_CATALOG,
  GT4_SPECS,
  SCALE_MS,
  MPH_PER_MS,
} from './physlab.mjs';

const label = process.argv[2] ?? 'run';
const HOLD = Number(process.argv[3] ?? 10) || 10;
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
const v0 = (30 / MPH_PER_MS) * SCALE_MS; // rolling start 30 mph
const state = createPhase0BIntegratorState(5000, 5000, 0, v0);
state.pGear = 2;
state.pRpm = 4000;
// fields advancePSpeed / gear logic touch that the integrator state may lack
state.fuel = 1;
state.revLimiter = false;
state.pRevIntent = false;
state.manualGear = null;

function step(steerAxis, gas) {
  const input = {
    gas, brake: false, ebrk: false,
    steerAxis, gasAmount: gas ? 1 : 0, brakeAmount: 0,
    steerLeft: false, steerRight: false,
  };
  // 1. arcade scalar advance (legacy ACCEL chain; pRpm pinned mid-range)
  advancePSpeed(
    state, input, dt, true,
    car.redline, 1, 1,
    spec.topSpeed,
    car.engineBrake ?? 0, car.rollingFriction ?? 0,
    car.aeroFactor ?? 0, car.brakePower,
    1, 1, 1,
    undefined,
  );
  // 2. snapshot
  const scalar = state.pSpeed;
  // 3. integrator tick
  const absSpd = Math.abs(state.pSpeed);
  const massDamp = computeMassDamp(spec.mass, null);
  const speedRatio = Math.min(1, absSpd / spec.topSpeed);
  const spdFactor = Math.min(1, absSpd / 10);
  const steerInputEff = computeEffectiveSteerInput(steerAxis, spec.isBike, 1.0);
  const pAngVel = computeDesiredYawRate({
    steerInputEff, steerInput: steerAxis,
    pDrifting: state.pDrifting, pSpeed: state.pSpeed, slipAngle: state.pSlipAngle,
    turnRate, drivetrain: spec.drivetrain,
    speedRatio, spdFactor, massDamp, absSpd,
    gas, brake: false, brakeAmount: 0, isThrottle: gas && absSpd > 3,
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
  // 4. restore (arcade owns scalar pSpeed)
  state.pSpeed = scalar;
}

const phases = [
  { name: 'A_lockLeft_gas', frames: Math.round(HOLD * 60), steer: 1, gas: true },
  { name: 'B_lockRight_gas', frames: 300, steer: -1, gas: true },
  { name: 'C_lockRight_NOgas', frames: 300, steer: -1, gas: false },
];
const samples = [];
let prevAngle = 0, t = 0;
for (const ph of phases) {
  for (let i = 0; i < ph.frames; i++) {
    step(ph.steer, ph.gas);
    let dA = state.pAngle - prevAngle;
    if (dA > Math.PI) dA -= 2 * Math.PI; else if (dA < -Math.PI) dA += 2 * Math.PI;
    prevAngle = state.pAngle;
    t += dt;
    if (i % 30 === 29) { // 0.5 s samples
      samples.push({
        ph: ph.name, t: +t.toFixed(1),
        pSpeed: +state.pSpeed.toFixed(1),
        vMag: +Math.hypot(state.pVx, state.pVy).toFixed(1),
        yawDegS: +((dA / dt) * 180 / Math.PI).toFixed(1),
        slipDeg: +((state.pSlipAngle ?? 0) * 180 / Math.PI).toFixed(1),
        drift: !!state.pDrifting,
        nan: [state.pSpeed, state.pVx, state.pVy, state.pYawRate, state.pAngle].some((v) => !isFinite(v)),
      });
    }
  }
}
console.log(JSON.stringify({ label, holdSec: HOLD, samples }, null, 1));
