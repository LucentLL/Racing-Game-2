// H1280 probe: redline bounce after a manual shift bump in AUTO mode.
// User bug: "when letting auto-shift assist work the cars bounce on
// redline painfully long" — a knob/e/q bump held the gear 4s, and once
// speed hit the held gear's top the H1068 limiter zeroed drive force,
// making the old 1.75x safety-upshift threshold unreachable. The car
// chattered at redline until the hold expired.
//
// Scenario per case: cruise below the held gear's top, bump into the
// hold, full gas. Speed integrates with a flat accel that arcadeUpdate-
// style hard-cuts to zero while player.revLimiter is set. Reports how
// long the limiter chattered and when the next gear arrived.
//
//   HEALTHY (shiftMult=1): expect bounce ~0s — upshift the tick the
//     held gear pegs its top (same instant pure-auto would shift).
//   FAULTED (shiftMult=3, trans_slip): expect the lazy bounce to
//     persist until the 4s hold expires — the bounce IS the fault.
//   MANUAL MODE: expect bounce forever (H1068 drag-race behavior).
//
// Usage: node tools/physlab/shiftbounce.mjs
import { tickGearAndRpm, CAR_CATALOG, createPlayerState } from './physlab.mjs';

const car = Object.values(CAR_CATALOG).find((c) => /NSX/i.test(c.name))
  ?? Object.values(CAR_CATALOG)[0];
const GS = car.gearSpeeds;
const dt = 1 / 60;

function run({ shiftMult, manualMode, label }) {
  const p = createPlayerState(0, 0);
  // Start mid-2nd-gear, then bump the hold to 2nd (doManualShift shape:
  // manualGear from live gear, timer refreshed to 4s).
  p.pSpeed = GS[2] * 0.85;
  p.pRpm = car.idleRPM;
  p.prevGear = 2;
  p.manualGear = 2;
  p.manualGearTimer = 4;
  if (manualMode) p.manualGearTimer = 0; // persistent mode ignores the timer

  let t = 0;
  let bounceS = 0;        // total time revLimiter held the power cut
  let shiftedAt = null;   // sim time the transmission left the held gear
  const ACCEL = 30;       // flat wpx/s^2, plenty to peg 2nd quickly
  while (t < 6) {
    tickGearAndRpm(p, car, true, dt, false, shiftMult, manualMode);
    if (p.revLimiter) bounceS += dt;
    if (shiftedAt === null && p.prevGear > 2) shiftedAt = t;
    // arcadeUpdate H1068: revLimiter is a hard cut; light drag while cut
    p.pSpeed += (p.revLimiter ? -2 : ACCEL) * dt;
    t += dt;
  }
  const shifted = shiftedAt === null ? 'never' : shiftedAt.toFixed(2) + 's';
  console.log(
    `${label.padEnd(26)} bounce=${bounceS.toFixed(2)}s  3rd@${shifted}` +
    `  finalGear=${p.prevGear}  rpm=${Math.round(p.pRpm)}/${car.redline}`,
  );
  return { bounceS, shiftedAt };
}

console.log(`car: ${car.name}  GS[2]=${GS[2].toFixed(1)}  gears=${car.gears}`);
const healthy = run({ shiftMult: 1, manualMode: false, label: 'AUTO healthy' });
const faulted = run({ shiftMult: 3, manualMode: false, label: 'AUTO trans_slip (x3)' });
const manual = run({ shiftMult: 1, manualMode: true, label: 'MANUAL held 2nd' });

let fail = 0;
if (healthy.bounceS > 0.05) { console.error('FAIL: healthy auto still bounces'); fail = 1; }
if (healthy.shiftedAt === null) { console.error('FAIL: healthy auto never upshifted'); fail = 1; }
if (faulted.bounceS < 0.5) { console.error('FAIL: faulted box lost its lazy bounce'); fail = 1; }
if (faulted.shiftedAt === null) { console.error('FAIL: faulted box never rescued by hold expiry'); fail = 1; }
if (manual.shiftedAt !== null) { console.error('FAIL: manual mode auto-shifted'); fail = 1; }
if (manual.bounceS < 3) { console.error('FAIL: manual mode limiter not holding'); fail = 1; }
console.log(fail ? 'PROBE FAIL' : 'PROBE OK');
process.exit(fail);
