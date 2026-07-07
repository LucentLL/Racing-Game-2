// Feel-metrics harness: headless Phase 0B scenarios with release-edge metrics.
// Build the bundle first (from repo root):
//   npx esbuild tools/physlab/entry.ts --bundle --alias:@=./src --format=esm --outfile=tools/physlab/physlab.mjs
// Then: node tools/physlab/feelmetrics.mjs <label>
//   -> writes tools/physlab/feel_<label>.json and prints the summary.
// Rebuild the bundle after EVERY physics source edit — it captures repo
// state at build time. Baseline reference: feel_before/after in H1059.
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
import fs from 'fs';

const label = process.argv[2] ?? 'run';

const car = Object.values(CAR_CATALOG).find((c) => /RX-7 GT-Limited/i.test(c.name))
  ?? Object.values(CAR_CATALOG).find((c) => !c.isBike && c.drv === 'FR' && c.kg >= 1100 && c.kg <= 1300 && GT4_SPECS[c.name]);
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

function tick(state, steerAxis, gas, ebrk = false) {
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
    gas, brake: false, ebrk,
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

const deg = (r) => r * 180 / Math.PI;
const mphOf = (s) => s.pSpeed / SCALE_MS * MPH_PER_MS;

// Run a phase list [{steer, gas, ebrk, frames}], sampling every frame.
function run(mph, phases) {
  const state = makeState(mph);
  const samples = [];
  let t = 0;
  for (const ph of phases) {
    for (let i = 0; i < ph.frames; i++) {
      tick(state, ph.steer, ph.gas, ph.ebrk ?? false);
      t += dt;
      samples.push({
        t, phase: ph.name,
        mph: mphOf(state),
        yaw: state.pYawRate,
        slip: deg(state.pSlipAngle),
        heading: state.pAngle,
        velAngle: state.pVelAngle,
        camAngle: state.pCamAngle,
        drifting: state.pDrifting,
      });
    }
  }
  return samples;
}

// Release-edge metrics: from the first frame of `releasePhase`, measure slip decay.
function releaseMetrics(samples, releasePhase) {
  const idx = samples.findIndex((s) => s.phase === releasePhase);
  if (idx < 0) return null;
  const rel = samples.slice(idx);
  const slip0 = rel[0].slip;
  const sign0 = Math.sign(slip0 || 1);
  const target = Math.abs(slip0) / Math.E;
  let tau = null, settle = null, overshoot = 0;
  for (const s of rel) {
    const dtRel = s.t - rel[0].t;
    if (tau === null && Math.abs(s.slip) <= target) tau = dtRel;
    if (settle === null && Math.abs(s.slip) <= 0.3) settle = dtRel;
    if (Math.sign(s.slip) === -sign0) overshoot = Math.max(overshoot, Math.abs(s.slip));
  }
  const yaw0 = rel[0].yaw;
  let yawTau = null;
  for (const s of rel) {
    if (yawTau === null && Math.abs(s.yaw) <= Math.abs(yaw0) / Math.E) { yawTau = s.t - rel[0].t; break; }
  }
  // Camera: sprite-vs-camera offset once yaw is dead (<0.1 rad/s) —
  // this residual angle is what the player SEES unwind after release.
  const wrap = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
  let residualCamOffsetDeg = null;
  for (const s of rel) {
    if (Math.abs(s.yaw) < 0.1) { residualCamOffsetDeg = +Math.abs(deg(wrap(s.heading - s.camAngle))).toFixed(2); break; }
  }
  return {
    residualCamOffsetDeg,
    slipAtRelease: +slip0.toFixed(2),
    slipTau_s: tau === null ? '>window' : +tau.toFixed(3),
    settleTo0p3deg_s: settle === null ? '>window' : +settle.toFixed(3),
    overshootDeg: +overshoot.toFixed(2),
    yawAtRelease: +yaw0.toFixed(3),
    yawTau_s: yawTau === null ? '>window' : +yawTau.toFixed(3),
  };
}

function steadyMetrics(samples, phaseName) {
  const ph = samples.filter((s) => s.phase === phaseName);
  const last = ph[ph.length - 1];
  const wrap = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
  return {
    yawRate: +last.yaw.toFixed(4),
    slipDeg: +last.slip.toFixed(2),
    mph: +last.mph.toFixed(1),
    drifting: last.drifting,
    camOffsetDeg: +Math.abs(deg(wrap(last.heading - last.camAngle))).toFixed(2),
  };
}

const S = 60; // frames per second
const out = { label, car: car.name, scenarios: {} };

// A: gentle corner @60mph, steer 0.5 3s, release 2s
{
  const s = run(60, [
    { name: 'settle', steer: 0, gas: true, frames: S },
    { name: 'steer', steer: 0.5, gas: true, frames: 3 * S },
    { name: 'release', steer: 0, gas: true, frames: 2 * S },
  ]);
  out.scenarios.A_gentle60 = {
    steady: steadyMetrics(s, 'steer'),
    release: releaseMetrics(s, 'release'),
  };
}

// B: full lock @60mph, steer 1.0 2s, release 2s
{
  const s = run(60, [
    { name: 'settle', steer: 0, gas: true, frames: S },
    { name: 'steer', steer: 1.0, gas: true, frames: 2 * S },
    { name: 'release', steer: 0, gas: true, frames: 2 * S },
  ]);
  out.scenarios.B_fulllock60 = {
    steady: steadyMetrics(s, 'steer'),
    release: releaseMetrics(s, 'release'),
  };
}

// C: e-brake slide @40mph then hands-off (assist catch behavior at big slip)
{
  const s = run(40, [
    { name: 'settle', steer: 0, gas: true, frames: S },
    { name: 'pull', steer: 1.0, gas: false, ebrk: true, frames: Math.round(0.5 * S) },
    { name: 'handsoff', steer: 0, gas: false, frames: 3 * S },
  ]);
  out.scenarios.C_ebrakeSlide40 = {
    peak: { slipDeg: +Math.max(...s.map((x) => Math.abs(x.slip))).toFixed(2) },
    release: releaseMetrics(s, 'handsoff'),
    drifted: s.some((x) => x.drifting),
  };
}

// D: straight line 60mph gas 5s (longitudinal sanity — pSpeed trace)
{
  const s = run(60, [{ name: 'straight', steer: 0, gas: true, frames: 5 * S }]);
  const first = s[0], last = s[s.length - 1];
  out.scenarios.D_straight = {
    mphStart: +first.mph.toFixed(2), mphEnd: +last.mph.toFixed(2),
    maxAbsSlip: +Math.max(...s.map((x) => Math.abs(x.slip))).toFixed(3),
  };
}

// E: flick @60mph: +1.0 0.5s -> -1.0 0.5s -> 0
{
  const s = run(60, [
    { name: 'settle', steer: 0, gas: true, frames: S },
    { name: 'left', steer: 1.0, gas: true, frames: Math.round(0.5 * S) },
    { name: 'right', steer: -1.0, gas: true, frames: Math.round(0.5 * S) },
    { name: 'release', steer: 0, gas: true, frames: 2 * S },
  ]);
  out.scenarios.E_flick60 = {
    peakSlip: +Math.max(...s.map((x) => Math.abs(x.slip))).toFixed(2),
    release: releaseMetrics(s, 'release'),
    drifted: s.some((x) => x.drifting),
  };
}

fs.writeFileSync(new URL(`./feel_${label}.json`, import.meta.url), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
