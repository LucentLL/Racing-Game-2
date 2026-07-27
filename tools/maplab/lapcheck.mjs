/**
 * H1269: drive a synthetic car around every real circuit and assert the lap
 * counter cannot be cheated.
 *
 * The user's report was that driving back and forth on the start/finish line
 * counts a lap without completing one. That is a SIM bug, and unlike the render
 * work it cannot be verified by looking at a picture — so this reproduces the
 * exploit against the real geometry, on the real predicate, and fails if it
 * still pays out.
 *
 * Bundle first (entry.ts re-exports _lapInternals):
 *   npx esbuild tools/maplab/entry.ts --bundle --alias:@=./src --format=esm \
 *     --outfile=tools/maplab/maplab.mjs
 * Then: node tools/maplab/lapcheck.mjs
 */

if (typeof globalThis.Path2D === 'undefined') {
  globalThis.Path2D = class Path2D {
    moveTo() {} lineTo() {} closePath() {} arc() {} rect() {} quadraticCurveTo() {}
    bezierCurveTo() {} addPath() {} ellipse() {} arcTo() {}
  };
}

const M = await import('./maplab.mjs');
const {
  listMaps, getMapDef, setActiveMapId, rebuildRenderEntries,
  trackPathFor, startLineOn, poseAt, WPX_PER_M, _lapInternals,
} = M;
const { tickLapCursor, resetLapCursor } = _lapInternals;

let fail = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) fail++;
};

/** A minimal TrackRaceRun, enough for the cursor. */
const newRun = () => ({ lap: 0 });

/**
 * Walk the car along the centerline from arc `s0` by `dist` world px, feeding
 * the cursor one frame at a time at `step` px per frame. Returns laps credited.
 * `dir` -1 walks backwards. Positions come from poseAt, i.e. the car is exactly
 * on the racing line — the friendliest possible case for the cursor.
 */
function drive(run, path, lineS, s0, dist, step, dir = 1) {
  const dt = 1 / 60;
  let s = s0;
  let laps = 0;
  const n = Math.max(1, Math.round(dist / step));
  for (let i = 0; i < n; i++) {
    s += dir * step;
    const p = poseAt(path, s, 0);
    // speed is used only by the teleport guard; give it the honest value.
    if (tickLapCursor(run, path, lineS, p.x, p.y, step / dt, dt)) laps++;
  }
  return { laps, s };
}

for (const def of listMaps()) {
  const spec = def.race;
  if (!spec || spec.kind !== 'lap') continue;
  setActiveMapId(def.id);
  rebuildRenderEntries();
  const path = trackPathFor(def);
  if (!path) { check(`${def.id}: has a path`, false); continue; }
  const { s: lineS } = startLineOn(path, def, spec);
  const lapM = (path.total / WPX_PER_M).toFixed(0);
  const STEP = 12;   // world px per frame ~ 170 km/h

  // --- 1. THE REPORTED EXPLOIT ------------------------------------------
  // Start just before the line, then shuffle forward over it and back, ten
  // times. The old gate (leave a 198 px circle, re-enter a 90 px one) paid a
  // lap for every ~34 m of this.
  {
    const run = newRun();
    resetLapCursor(run);
    let s = lineS - 60;
    let laps = 0;
    // Seed the cursor where the car actually is.
    drive(run, path, lineS, s, 0, STEP);
    for (let i = 0; i < 10; i++) {
      let r = drive(run, path, lineS, s, 220, STEP, +1);   // 220 px ≈ 35 m over
      laps += r.laps; s = r.s;
      r = drive(run, path, lineS, s, 220, STEP, -1);       // and back
      laps += r.laps; s = r.s;
    }
    check(`${def.id}: back-and-forth over the line scores NOTHING`,
      laps === 0 && run.lap === 0,
      `10 shuffles -> ${run.lap} lap(s)`);
  }

  // --- 2. A REAL LAP STILL COUNTS ---------------------------------------
  {
    const run = newRun();
    resetLapCursor(run);
    drive(run, path, lineS, lineS + 30, 0, STEP);
    const r = drive(run, path, lineS, lineS + 30, path.total, STEP, +1);
    check(`${def.id}: one honest lap counts exactly once`,
      r.laps === 1 && run.lap === 1, `${lapM} m -> ${run.lap} lap(s)`);
  }

  // --- 3. THREE LAPS COUNT AS THREE -------------------------------------
  {
    const run = newRun();
    resetLapCursor(run);
    drive(run, path, lineS, lineS + 30, 0, STEP);
    const r = drive(run, path, lineS, lineS + 30, path.total * 3, STEP, +1);
    check(`${def.id}: three laps count as three`,
      r.laps === 3 && run.lap === 3, `-> ${run.lap}`);
  }

  // --- 4. A SHORTCUT IS REFUSED -----------------------------------------
  // Cross the line having covered only half the lap. The cursor rides the
  // centerline, so this is what cutting the infield looks like to it: the
  // position jumps, the guard eats the jump, and the distance test refuses.
  {
    const run = newRun();
    resetLapCursor(run);
    drive(run, path, lineS, lineS + 30, 0, STEP);
    // Go half a lap forward, teleport across the middle back to just before the
    // line, then cross it.
    let r = drive(run, path, lineS, lineS + 30, path.total * 0.5, STEP, +1);
    const jump = poseAt(path, lineS - 40, 0);
    tickLapCursor(run, path, lineS, jump.x, jump.y, 0, 1 / 60);   // the cut
    r = drive(run, path, lineS, lineS - 40, 200, STEP, +1);
    check(`${def.id}: crossing the line after a shortcut is refused`,
      run.lap === 0, `-> ${run.lap} lap(s)`);
  }

  // --- 5. REVERSING PAST THE LINE MID-RACE DOES NOT PAY -----------------
  // Complete a real lap, then reverse back over the line and forward again.
  // Without the distance term this hands out a free second lap.
  {
    const run = newRun();
    resetLapCursor(run);
    drive(run, path, lineS, lineS + 30, 0, STEP);
    let r = drive(run, path, lineS, lineS + 30, path.total, STEP, +1);
    const afterOne = run.lap;
    r = drive(run, path, lineS, r.s, 300, STEP, -1);   // back over the line
    r = drive(run, path, lineS, r.s, 300, STEP, +1);   // and forward again
    check(`${def.id}: reversing over the line then re-crossing pays nothing`,
      run.lap === afterOne, `lap ${afterOne} -> ${run.lap}`);
  }

  console.log(`      (${def.name}: ${lapM} m lap, line at s=${lineS.toFixed(0)})`);
}

// --- 6. THE SPEC NOW CARRIES A LAP COUNT -------------------------------
for (const def of listMaps()) {
  if (!def.race || !def.race.solo) continue;
  const laps = def.race.laps;
  check(`${def.id}: grid race has a lap target`,
    typeof laps === 'number' && laps >= 2 && laps <= 6, `laps=${laps}`);
}

console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILURE(S)`);
process.exit(fail === 0 ? 0 : 1);
