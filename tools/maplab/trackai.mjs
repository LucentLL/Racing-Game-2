// H1244: drive the path-following AI around every real circuit offline and
// check the lap times are believable.
//
// This is the meaningful test of the corner model. The AI rides the centerline
// on rails, so it cannot leave the track by construction — what CAN be wrong is
// the pace: no corner model at all gives absurdly fast laps (the car takes
// Monza's Parabolica at 300 km/h), and an over-tight one gives a crawl.
//
// Usage: node tools/maplab/trackai.mjs [carRegex]
import {
  REAL_TRACKS, buildTrackPath, advanceTrackAI, cornerSpeedCap,
  advanceOppPhysics, CAR_CATALOG, TILE, WPX_PER_M,
} from './maplab.mjs';

const CARRX = new RegExp(process.argv[2] ?? 'Skyline|Supra|NSX|RX-7', 'i');
const car = Object.values(CAR_CATALOG).find((c) => CARRX.test(c.name))
  ?? Object.values(CAR_CATALOG)[0];

console.log(`car: ${car.name}  (${car.hp} hp, top ${car.topSpeed})\n`);

// Real-world reference lap times (s) for a quick road car — NOT an F1 car.
// Used only as a sanity band: within 2x either way of a fast road-car lap.
const REF = {
  monza: [95, 220],
  spa: [130, 300],
  watkins: [95, 230],
  laguna: [70, 170],
};

let fail = 0;
const check = (l, ok, d) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}${d ? '  ' + d : ''}`); if (!ok) fail++; };

for (const t of REAL_TRACKS) {
  const path = buildTrackPath(t.points, TILE);
  if (!path) { check(`${t.id}: path builds`, false); continue; }

  const lengthM = path.total / WPX_PER_M;
  check(`${t.id}: path length matches the real circuit`,
    Math.abs(lengthM - t.lengthM) / t.lengthM < 0.05,
    `${lengthM.toFixed(0)} m vs published ${t.lengthM} m`);

  const ai = { s: 0, lane: 0, skill: 1.0, lap: 0 };
  const phys = { speed: 0, rpm: 900, gear: 1, shiftTimer: 0 };
  const dt = 1 / 60;
  let tSec = 0;
  const lapTimes = [];
  let lastLap = 0;
  let vMin = Infinity, vMax = 0;
  let capped = 0, frames = 0;

  while (tSec < 900 && lapTimes.length < 3) {
    advanceOppPhysics(phys, car, dt);
    const straightCap = car.topSpeed * (0.82 + 0.18 * ai.skill);
    const cap = Math.min(straightCap, cornerSpeedCap(path, ai.s, ai.skill));
    if (phys.speed > cap) { phys.speed = cap; capped++; }
    advanceTrackAI(ai, path, phys.speed, dt);
    frames++;
    tSec += dt;
    const kmh = (phys.speed / WPX_PER_M) * 3.6;
    if (tSec > 20) { // let it get up to speed before sampling
      vMin = Math.min(vMin, kmh);
      vMax = Math.max(vMax, kmh);
    }
    if (ai.lap > lapTimes.length) {
      lapTimes.push(tSec - lastLap);
      lastLap = tSec;
    }
  }

  const best = lapTimes.length ? Math.min(...lapTimes) : Infinity;
  const [lo, hi] = REF[t.id] ?? [40, 400];
  check(`${t.id}: completes laps`, lapTimes.length >= 2, `laps=${lapTimes.length}`);
  check(`${t.id}: lap time is believable`, best >= lo && best <= hi,
    `best ${best.toFixed(1)}s (band ${lo}-${hi}s) laps=[${lapTimes.map((x) => x.toFixed(1)).join(', ')}]`);
  // If the corner model never binds, the AI is just flat out everywhere.
  check(`${t.id}: the corner model actually binds`, capped / frames > 0.05,
    `capped ${(100 * capped / frames).toFixed(0)}% of frames, speed ${vMin.toFixed(0)}-${vMax.toFixed(0)} km/h`);
  // And it must not be pinned so low that the car crawls.
  check(`${t.id}: still reaches a real speed on the straights`, vMax > 120,
    `max ${vMax.toFixed(0)} km/h`);
  console.log('');
}

console.log(fail === 0 ? 'ALL PASS' : `${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
