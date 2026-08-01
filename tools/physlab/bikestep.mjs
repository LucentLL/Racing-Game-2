// H1294 bike step-steer probe — measures the REAL bike steering chain
// (advanceBikeHeadingAndPosition + tickBikeCameraAngle), which bikes always
// run (they are never Phase-0B eligible), so the integrator probes can't
// see them. Answers the user report "bikes feel very unresponsive and hard
// to control" with numbers instead of blind tuning:
//
//   - t50 heading / t50 trajectory: seconds from the steer step until the
//     chassis yaw rate / the VELOCITY-vector turn rate (what the player
//     sees as "the bike turning") reaches 50% of its steady value.
//   - steady slip: heading - velocity direction once settled. The H822
//     momentum-resist divides the grip velocity-alignment by
//     (1 + speedRatio^2 * 6), so pre-fix this grows with speed and the
//     bike travels straight long after the chassis has turned.
//   - camera lag: heading - camera angle (the camera tracks bikeVelAngle,
//     so big slip = the WORLD doesn't rotate when you steer).
//
// Scenarios: Ninja 250 (light, turnRate 3.8) at 30/60/90% of top speed,
// half-stick and full-stick steps, momentumCoef 6 (live default) vs 0
// (A/B without source edits — it's a function parameter). slideAlign
// verifies the drift-state alignment rate is untouched by any grip fix.
// Usage: node tools/physlab/bikestep.mjs
import {
  CAR_CATALOG, advanceBikeHeadingAndPosition, tickBikeCameraAngle,
  createPlayerState, createInputState, SCALE_MS,
} from './physlab.mjs';

const dt = 1 / 60;
const deg = (r) => (r * 180) / Math.PI;
// phase0BCatalogAdapter's bike bracket: kg > 250 → 3.2 (Harleys), else 3.8.
const bikeTurnRate = (car) => (car.kg > 250 ? 3.2 : 3.8);

function stepRun(car, spdFrac, steerTo, momentumCoef, secs = 8) {
  const p = createPlayerState();
  const input = createInputState();
  const spd = car.topSpeed * spdFrac;
  p.pSpeed = spd; p.pAngle = 0; p.pCamAngle = 0;
  p.bikeVelAngle = 0; p.bikeVelAngleInit = true;
  p.drifting = false; p.bikeEbrakeTimer = 0; p.bikeEbrakeCooldown = 0;
  const tr = bikeTurnRate(car);
  let prevA = 0, prevV = 0;
  const yawRates = [], velRates = [], slips = [], camLags = [];
  const series = [];
  for (let t = 0; t < secs; t += dt) {
    input.steerAxis = t >= 1 ? steerTo : 0;
    p.pSpeed = spd; // pin speed: isolate the steering chain
    advanceBikeHeadingAndPosition(p, input, dt, tr, car.topSpeed, 1, car.kg, false, false, momentumCoef, 0.0003);
    tickBikeCameraAngle(p, dt);
    const yawRate = (p.pAngle - prevA) / dt; prevA = p.pAngle;
    const velRate = (p.bikeVelAngle - prevV) / dt; prevV = p.bikeVelAngle;
    series.push({ t, yawRate, velRate });
    if (t > secs - 1) { // last second = steady state
      yawRates.push(yawRate); velRates.push(velRate);
      slips.push(p.pAngle - p.bikeVelAngle);
      camLags.push(p.pAngle - p.pCamAngle);
    }
  }
  const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  const steadyYaw = mean(yawRates);
  const steadyVel = mean(velRates);
  const t50 = (key, steady) => {
    for (const s of series) if (s.t >= 1 && s[key] >= steady * 0.5) return +(s.t - 1).toFixed(2);
    return null;
  };
  return {
    steadyYawDegS: +deg(steadyYaw).toFixed(1),
    t50heading: t50('yawRate', steadyYaw),
    t50trajectory: t50('velRate', steadyVel),
    steadySlipDeg: +deg(mean(slips)).toFixed(1),
    camLagDeg: +deg(mean(camLags)).toFixed(1),
  };
}

// Drift-state alignment half-life: offset velocity from heading by 0.3 rad
// with drifting latched (steer 0 so the drift branch adds ~no yaw of its
// own beyond slipForce) and measure how long the gap takes to halve.
function slideAlign(car, spdFrac, momentumCoef) {
  const p = createPlayerState();
  const input = createInputState();
  const spd = car.topSpeed * spdFrac;
  p.pSpeed = spd; p.pAngle = 0.3; p.pCamAngle = 0;
  p.bikeVelAngle = 0; p.bikeVelAngleInit = true;
  p.drifting = true; p.bikeEbrakeTimer = 0.6;
  const tr = bikeTurnRate(car);
  for (let t = 0; t < 6; t += dt) {
    input.steerAxis = 0; input.ebrk = false;
    p.pSpeed = spd;
    advanceBikeHeadingAndPosition(p, input, dt, tr, car.topSpeed, 1, car.kg, false, false, momentumCoef, 0.0003);
    let gap = p.pAngle - p.bikeVelAngle;
    while (gap > Math.PI) gap -= Math.PI * 2;
    if (Math.abs(gap) <= 0.15) return +t.toFixed(2);
  }
  return null;
}

const ninja = Object.values(CAR_CATALOG).find((c) => /Ninja 250/i.test(c.name));
const out = { car: ninja.name, topKmh: +((ninja.topSpeed / SCALE_MS) * 3.6).toFixed(0), scenarios: {} };
for (const coef of [6, 0]) {
  for (const frac of [0.3, 0.6, 0.9]) {
    for (const steer of [0.5, 1.0]) {
      out.scenarios[`coef${coef}_spd${frac}_steer${steer}`] = stepRun(ninja, frac, steer, coef);
    }
  }
  out.scenarios[`coef${coef}_slideAlignHalfLife_spd0.6`] = slideAlign(ninja, 0.6, coef);
}
console.log(JSON.stringify(out, null, 2));
