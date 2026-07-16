// H1161 standing-start probe — measures 0-100 km/h (and 0-60 mph) through
// the PER-CAR accel chain, i.e. the exact accelOverride gameLoop feeds
// advancePSpeed (power · torqueMult · gearMult), replicating sim/race.ts
// advanceOpponentSpeed frame order. launch.mjs predates this and measures
// the flat legacy ACCEL=155 chain instead — use THIS probe for per-car
// acceleration A/B runs.
// Usage: node tools/physlab/accel.mjs [carRegex ...]
//   node tools/physlab/accel.mjs Ambulance "Box Truck" "Police Cruiser"
//   node tools/physlab/accel.mjs            (default: the non-GT4 fleet)
import {
  CAR_CATALOG,
  GT4_SPECS,
  SCALE_MS,
  advancePSpeed,
  tickGearAndRpm,
  getTorqueAtRPM,
  NON_GT4_ACCEL_MULT,
  createPlayerState,
  createInputState,
} from './physlab.mjs';

const args = process.argv.slice(2);
const patterns = args.length > 0
  ? args
  : ['Ambulance', 'Box Truck', 'Tow Truck', 'Police Cruiser', 'Semi Truck',
    'Fat Boy', 'Road King', 'Ninja 250', 'ZX-6R', 'NSX \\D*`?90|NSX `90'];

// = gameLoop _arcadeAccelTerm's power (incl. the H1161 multiplier).
function powerBase(car) {
  const spec = GT4_SPECS[car.name];
  const peakTq = spec && spec.pTq > 0 ? spec.pTq : car.hp * 0.12;
  const tqPerKg = peakTq / Math.max(400, car.kg);
  const fwI = spec?.fwI ?? 100;
  const drv = car.drv;
  const propI = spec
    ? (drv === 'FF' ? spec.pIF : drv === '4WD' ? (spec.pIF + spec.pIR) / 2 : spec.pIR)
    : 50;
  const fwFactor = 100 / Math.max(50, fwI);
  const propFactor = 50 / Math.max(10, propI);
  const combinedRevResponse = Math.min(1.3, Math.max(0.6, (fwFactor + propFactor) / 2));
  const accelBase = (car.isBike
    ? (car.hp / car.kg) * 18
    : tqPerKg * 200 * combinedRevResponse)
    * (NON_GT4_ACCEL_MULT[car.name] ?? 1);
  return accelBase * SCALE_MS;
}

// = gameLoop _gearMult / sim/race.ts gearMultOf.
function gearMultOf(car, prevGear) {
  const gs = car.gearSpeeds;
  if (gs[car.gears] > 0 && gs[prevGear] > 0) {
    return 1.0 + (gs[car.gears] / gs[prevGear] - 1) * 0.1;
  }
  return 1.0 + 0.6 * (1 - prevGear / car.gears);
}

const KMH100 = (100 / 3.6) * SCALE_MS; // 100 km/h in wpx/s
const MPH60 = (60 * 0.44704) * SCALE_MS; // 60 mph in wpx/s
const dt = 1 / 60;

function measure(car) {
  const sim = createPlayerState();
  const input = createInputState();
  input.gas = true; input.gasAmount = 1;
  sim.pSpeed = 0; sim.pRpm = car.idleRPM ?? 900; sim.prevGear = 1;
  sim.gearShiftTimer = 0; sim.manualGearTimer = 0; sim.manualGear = null;
  sim.fuel = 100; sim.pRevIntent = false;
  let t100 = null, t60 = null;
  for (let t = 0; t < 90; t += dt) {
    tickGearAndRpm(sim, car, true, dt);
    const torqueMult = getTorqueAtRPM(car.tcRPMs, car.tcNorm, sim.pRpm);
    const gearMult = gearMultOf(car, sim.prevGear);
    const accelTerm = powerBase(car) * torqueMult * gearMult;
    advancePSpeed(
      sim, input, dt, true,
      car.redline, torqueMult, gearMult, car.topSpeed,
      car.engineBrake ?? 0, car.rollingFriction ?? 0,
      car.aeroFactor ?? 0, car.brakePower,
      1, 1, 1, accelTerm,
    );
    if (t60 === null && sim.pSpeed >= MPH60) t60 = t;
    if (t100 === null && sim.pSpeed >= KMH100) t100 = t;
    if (t100 !== null && t60 !== null) break;
  }
  return { t100, t60 };
}

for (const pat of patterns) {
  const rx = new RegExp(pat, 'i');
  const car = Object.values(CAR_CATALOG).find((c) => rx.test(c.name));
  if (!car) { console.log(`${pat}: NO MATCH`); continue; }
  const { t100, t60 } = measure(car);
  const mult = NON_GT4_ACCEL_MULT[car.name] ?? 1;
  console.log(
    `${car.name.padEnd(38)} 0-100: ${t100 === null ? '>90s' : t100.toFixed(1) + 's'}`
    + `  0-60mph: ${t60 === null ? '>90s' : t60.toFixed(1) + 's'}`
    + `  (mult x${mult})`,
  );
}
