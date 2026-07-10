// H1105 camera-jerk probe: replicates ON-SCREEN motion during a side-to-side
// steering reversal — the user's "strange, offputting motion... may be a jerky
// camera" report. Simulates the physics + the FULL camera pipeline
// (tickPVelAngleFilter → selectCamTarget → tickPCamAngle) + the H1097 body-sway
// visual, then reports what the EYE sees:
//   camRateDegS   world-rotation speed (deg/s) — spikes/sign-flips = world jerk
//   spriteRotDeg  pAngle − pCamAngle — how much the car sprite twists IN FRAME
//   swayPx        body sway offset in SCREEN px (world 1.2px × zoom 2.93)
// Usage: node tools/physlab/camjerk.mjs <label> [steerMag=0.5]
import {
  createPhase0BIntegratorState,
  tickPhase0BIntegrator,
  buildPhase0BCarSpec,
  computeCarTurnRate,
  computeDesiredYawRate,
  computeMassDamp,
  computeEffectiveSteerInput,
  tickPVelAngleFilter,
  selectCamTarget,
  tickPCamAngle,
  CAM_SLIP_FULL,
  CAR_CATALOG,
  GT4_SPECS,
  SCALE_MS,
  MPH_PER_MS,
} from './physlab.mjs';

const label = process.argv[2] ?? 'run';
const MAG = Number(process.argv[3] ?? 0.5) || 0.5;
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
const v0 = (60 / MPH_PER_MS) * SCALE_MS;
const state = createPhase0BIntegratorState(5000, 5000, 0, v0);
let gear = 1;
for (let g = 1; g <= car.gears; g++) if (car.gearSpeeds[g] < v0) gear = Math.min(car.gears, g + 1);
state.pGear = gear;
state.pRpm = 4000;

function tick(steerAxis) {
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
    gas: true, brake: false, brakeAmount: 0, isThrottle: true,
    onGrass: false, hasTrailer: false,
    steerSlow: false, engineStallActive: false, steerPull: 0,
  });
  tickPhase0BIntegrator(state, {
    gas: true, brake: false, ebrk: false,
    steerAxis, brakeAmount: 0, gasAmount: 1,
    pAngVel, sensSlider: 1.0, spdFactor,
    isManual: false, isWelded: false, supercharged: false,
    dt, onGrass: false, onDirt: false,
    faults,
    worldW: 100000, worldH: 100000,
    collide: () => false,
    isSemiWithTrailer: false,
  }, spec, settings);
}

// camera + sway state (mirrors gameLoop wiring)
let velFilt = 0, cam = 0;
let bodyRoll = 0, prevAngle = 0, prevSpeed = state.pSpeed;
const ZOOM = 2.93, SWAY_LAT = 1.2, LEAN_RATE = 10, LAT_REF = 40;
const rows = [];
let prevCam = 0;
for (let i = 0; i < 180; i++) {
  const t = i * dt;
  tick(t < 1.0 ? MAG : -MAG);
  const velAngle = Math.atan2(state.pVy, state.pVx);
  const slipT = Math.min(1, Math.abs(state.pSlipAngle) / CAM_SLIP_FULL);
  velFilt = tickPVelAngleFilter(velFilt, velAngle, slipT, dt);
  const target = selectCamTarget(state.pAngle, velFilt, state.pSpeed, false, slipT);
  prevCam = cam;
  cam = tickPCamAngle(cam, target, slipT, dt);
  // body sway (bodyLean.ts sim)
  let dA = state.pAngle - prevAngle;
  if (dA > Math.PI) dA -= 2 * Math.PI; else if (dA < -Math.PI) dA += 2 * Math.PI;
  const latAccel = state.pSpeed * (dA / dt);
  prevAngle = state.pAngle; prevSpeed = state.pSpeed;
  const rollT = Math.max(-1, Math.min(1, latAccel / LAT_REF));
  bodyRoll += (rollT - bodyRoll) * Math.min(1, dt * LEAN_RATE);
  rows.push({
    t,
    camRateDegS: ((cam - prevCam) / dt) * 180 / Math.PI,
    spriteRotDeg: (state.pAngle - cam) * 180 / Math.PI,
    swayPx: -bodyRoll * SWAY_LAT * ZOOM,
  });
}
// jerk metrics AFTER the flip (t in 1.0..3.0): sign reversals + peak rates
const post = rows.filter((r) => r.t >= 1.0);
let camFlips = 0, swayFlips = 0;
let peakCamRate = 0, peakSwayDelta = 0, peakSpriteRot = 0;
for (let i = 1; i < post.length; i++) {
  const a = post[i - 1], b = post[i];
  if (Math.sign(a.camRateDegS) !== Math.sign(b.camRateDegS) && Math.abs(b.camRateDegS) > 2) camFlips++;
  const sd = Math.abs(b.swayPx - a.swayPx);
  if (sd > peakSwayDelta) peakSwayDelta = sd;
  const swayVel = b.swayPx - a.swayPx, swayVelPrev = a.swayPx - (post[i - 2]?.swayPx ?? a.swayPx);
  if (i >= 2 && Math.sign(swayVel) !== Math.sign(swayVelPrev) && Math.abs(swayVel) > 0.05) swayFlips++;
  if (Math.abs(b.camRateDegS) > Math.abs(peakCamRate)) peakCamRate = b.camRateDegS;
  if (Math.abs(b.spriteRotDeg) > Math.abs(peakSpriteRot)) peakSpriteRot = b.spriteRotDeg;
}
console.log(JSON.stringify({
  label, steerMag: MAG,
  peakCamRateDegS: +peakCamRate.toFixed(1),
  camRateSignFlipsPostFlip: camFlips,
  peakSpriteRotInFrameDeg: +peakSpriteRot.toFixed(2),
  totalSwaySwingPx: +(Math.max(...rows.map(r=>r.swayPx)) - Math.min(...rows.map(r=>r.swayPx))).toFixed(2),
  peakSwayDeltaPxPerFrame: +peakSwayDelta.toFixed(3),
  swayVelocitySignFlips: swayFlips,
  camRateTrace10hz: rows.filter((_, i) => i % 6 === 0).map((r) => +r.camRateDegS.toFixed(1)),
  spriteRotTrace10hz: rows.filter((_, i) => i % 6 === 0).map((r) => +r.spriteRotDeg.toFixed(1)),
  swayTrace10hz: rows.filter((_, i) => i % 6 === 0).map((r) => +r.swayPx.toFixed(2)),
}, null, 1));
