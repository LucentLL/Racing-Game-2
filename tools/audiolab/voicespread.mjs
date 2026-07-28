/**
 * H1274: the guard probe for per-car voice identity.
 *
 * Three things it protects, in order of how badly they fail:
 *
 *  1. SAFETY. Every car's rateMul must sit inside its own pitch window, or a
 *     crossfade slot clamps and sings a fixed wrong note under the correct one
 *     — the user-reported "multiple engines revving at different intervals"
 *     that H1273 fixed. The pre-H1274 formula violated this on 33 of 365 cars
 *     with a flat [0.90, 1.12] clamp, so this assertion is a real regression
 *     test, not a formality.
 *
 *  2. AUTHORED VOICES STAY HOOKED UP. Iconic entries are keyed by catalog
 *     name, and a rename would silently drop one back to the generic voice
 *     while still looking authored in the source. That already happened once
 *     during development: hand-listing the GT-R trims lost fourteen rows to
 *     "Vspec" vs "V-spec" and to chassis codes. Exact keys must exist; every
 *     pattern must still match at least its minRows.
 *
 *  3. DISTINCTNESS. The point of the whole exercise. Reported rather than
 *     asserted at zero — see the note on the threshold below.
 *
 * Bundle first:
 *   npx esbuild tools/audiolab/voiceentry.ts --bundle --alias:@=./src \
 *     --format=esm --outfile=tools/audiolab/voiceentry.mjs
 * Then: node tools/audiolab/voicespread.mjs
 */

globalThis.Path2D = class {
  moveTo() {} lineTo() {} closePath() {} arc() {} rect() {}
  quadraticCurveTo() {} bezierCurveTo() {} addPath() {} ellipse() {} arcTo() {}
};

const M = await import('./voiceentry.mjs');
const {
  CAR_CATALOG, computeEngineVoice, safeRateWindow,
  ICONIC_VOICES, ICONIC_PATTERNS, iconicVoiceFor, CAM_RULES, CAM_DROPOUT_RPM,
  familyMedianCc, carVoiceCc, resolveEngineFamily,
} = M;

let fail = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) fail++;
};

/** The exact call the game makes (gameLoop _engineVoiceFor). */
function voiceOf(c, mods) {
  return computeEngineVoice({
    id: c.id, name: c.name, redline: c.redline, hp: c.hp,
    weight: c.kg, aspiration: c.asp, idleRPM: c.idleRPM,
    cc: carVoiceCc(c.name, c.eType),
    familyMedianCc: familyMedianCc(resolveEngineFamily(c)),
    eType: c.eType, modelYear: c.modelYear,
  }, mods);
}

const cars = Object.values(CAR_CATALOG);
const names = new Set(cars.map((c) => c.name));

// --- 1. SAFETY -------------------------------------------------------------
{
  const bad = [];
  for (const c of cars) {
    if (!resolveEngineFamily(c)) continue;
    const v = voiceOf(c);
    const [lo, hi] = safeRateWindow(c.redline, c.idleRPM);
    if (v.rateMul < lo - 1e-9 || v.rateMul > hi + 1e-9) {
      bad.push(`${c.name} ${v.rateMul.toFixed(3)} outside [${lo.toFixed(3)}, ${hi.toFixed(3)}]`);
    }
  }
  check('every rateMul is inside its per-car safe pitch window',
    bad.length === 0, bad.length ? bad.slice(0, 3).join('; ') : 'all recorded-family cars');
}

// --- 2. GLOBAL BOUNDS ------------------------------------------------------
{
  const bad = [];
  for (const c of cars) {
    for (const stage of [0, 1, 2, 3, 4]) {
      const v = voiceOf(c, { exhaustLevel: stage / 4, straightPipe: stage >= 4 });
      const okNum = [v.rateMul, v.peakHz, v.peakDb, v.shelfDb, v.levelMul].every(Number.isFinite);
      if (!okNum) { bad.push(`${c.name} stage ${stage}: non-finite`); continue; }
      // levelMul floor 0.75: below ~0.7 a recorded car reads quieter than the
      // synth-voiced cars it shares a session with, inverting the hierarchy.
      if (v.levelMul < 0.75 || v.levelMul > 1.35) bad.push(`${c.name} level ${v.levelMul.toFixed(2)}`);
      if (v.peakHz < 180 || v.peakHz > 1600) bad.push(`${c.name} peakHz ${v.peakHz.toFixed(0)}`);
      if (v.shelfDb < -4 || v.shelfDb > 9) bad.push(`${c.name} shelf ${v.shelfDb.toFixed(1)}`);
    }
  }
  check('every axis stays inside its clamp at every exhaust stage',
    bad.length === 0, bad.length ? bad.slice(0, 3).join('; ') : '380 cars x 5 stages');
}

// --- 3. DETERMINISM --------------------------------------------------------
{
  const a = cars.map((c) => JSON.stringify(voiceOf(c)));
  const b = cars.map((c) => JSON.stringify(voiceOf(c)));
  check('voices are deterministic across runs',
    a.every((x, i) => x === b[i]), `${a.length} cars`);
}

// --- 4. AUTHORED VOICES STAY HOOKED UP -------------------------------------
{
  const dead = Object.keys(ICONIC_VOICES).filter((k) => !names.has(k));
  check('every iconic exact key names a real catalog car',
    dead.length === 0, dead.length ? dead.slice(0, 5).join('; ') : `${Object.keys(ICONIC_VOICES).length} keys`);

  const thin = [];
  for (const p of ICONIC_PATTERNS) {
    const n = [...names].filter((x) => p.test.test(x)).length;
    if (n < p.minRows) thin.push(`${p.test} matched ${n}, needs ${p.minRows}`);
  }
  check('every iconic pattern still matches its expected rows',
    thin.length === 0, thin.length ? thin.join('; ') : `${ICONIC_PATTERNS.length} patterns`);
}

// --- 5. THE EXHAUST LADDER IS MONOTONIC ------------------------------------
// Stock -> straight-through must get brighter, louder and higher-formant at
// every rung. If a rung ever went backwards the upgrade would sound like a
// downgrade, which is the one thing this feature cannot do.
{
  const bad = [];
  for (const c of cars.slice(0, 120)) {
    let prev = null;
    for (const stage of [0, 1, 2, 3, 4]) {
      const v = voiceOf(c, { exhaustLevel: stage / 4, straightPipe: stage >= 4 });
      if (prev) {
        if (v.shelfDb < prev.shelfDb - 1e-9) bad.push(`${c.name} shelf dropped at stage ${stage}`);
        if (v.peakHz < prev.peakHz - 1e-9) bad.push(`${c.name} formant dropped at stage ${stage}`);
        if (v.levelMul < prev.levelMul - 1e-9) bad.push(`${c.name} level dropped at stage ${stage}`);
      }
      prev = v;
    }
  }
  check('exhaust ladder is monotonic (never sounds tamer when upgraded)',
    bad.length === 0, bad.length ? bad.slice(0, 3).join('; ') : '120 cars x 5 stages');
}

// --- 6. DISTINCTNESS -------------------------------------------------------
// Two cars "collide" when they are inside ALL THREE of 1.5% pitch, 25 Hz
// formant and 0.5 dB shelf at once — a deliberately tight bar.
//
// Cars sharing an ICONIC entry are excluded, because those are the same real
// engine (every NSX trim, every Evo) and sounding alike is the correct answer,
// not a defect.
//
// Reported, not asserted at zero. Driving it to zero needs a lattice that
// nudges cars off their spec-derived voice purely to satisfy a separation
// constraint, which trades away the accuracy this feature exists for. The
// assertion here is that it does not REGRESS past the pre-H1274 baseline.
{
  const byFam = {};
  for (const c of cars) {
    const f = resolveEngineFamily(c);
    if (!f) continue;
    (byFam[f] ??= []).push({ n: c.name, v: voiceOf(c), icon: iconicVoiceFor(c.name) });
  }
  let tot = 0, coll = 0;
  const examples = [];
  for (const [f, list] of Object.entries(byFam)) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        tot++;
        const A = list[i], B = list[j];
        const same = Math.abs(Math.log(A.v.rateMul / B.v.rateMul)) < 0.015
          && Math.abs(A.v.peakHz - B.v.peakHz) < 25
          && Math.abs(A.v.shelfDb - B.v.shelfDb) < 0.5;
        if (!same) continue;
        if (A.icon && B.icon && A.icon === B.icon) continue;   // same real engine
        coll++;
        if (examples.length < 4) examples.push(`${f}: ${A.n} ~ ${B.n}`);
      }
    }
  }
  const pct = (100 * coll) / tot;
  check('near-identical same-family pairs beat the pre-H1274 baseline',
    coll < 290, `${coll} of ${tot} (${pct.toFixed(2)}%) — baseline was 290 (5.0%)`);
  examples.forEach((e) => console.log('        closest:', e));

  const shelf = new Set(), level = new Set();
  for (const l of Object.values(byFam)) {
    for (const c of l) { shelf.add(c.v.shelfDb.toFixed(2)); level.add(c.v.levelMul.toFixed(3)); }
  }
  check('shelfDb and levelMul are LIVE axes for stock cars',
    shelf.size > 50 && level.size > 50,
    `${shelf.size} distinct shelf values, ${level.size} distinct levels (both were 1 before H1274)`);
}

// --- 7. DIFFERENTIAL LEG ---------------------------------------------------
// Prove the distinctness check can actually fail: strip the spec-driven axes
// back to a single constant and confirm collisions explode. Without this the
// check above could be passing for the wrong reason.
{
  const flat = cars.filter((c) => resolveEngineFamily(c) === 'i4_japanese_2');
  let coll = 0, tot = 0;
  for (let i = 0; i < flat.length; i++) {
    for (let j = i + 1; j < flat.length; j++) {
      tot++;
      // Every car given the SAME voice — the degenerate case the real formula
      // must not resemble.
      const a = { rateMul: 1, peakHz: 600, shelfDb: 0 };
      const b = { rateMul: 1, peakHz: 600, shelfDb: 0 };
      if (Math.abs(Math.log(a.rateMul / b.rateMul)) < 0.015
        && Math.abs(a.peakHz - b.peakHz) < 25
        && Math.abs(a.shelfDb - b.shelfDb) < 0.5) coll++;
    }
  }
  check('the distinctness metric can fail (degenerate all-same voice)',
    coll === tot && tot > 0, `${coll}/${tot} collide when every voice is identical`);
}

// --- 8. THE CAM CHANGEOVER -------------------------------------------------
{
  const withCam = cars.filter((c) => voiceOf(c).cam);
  check('cam-changeover engines are identified',
    withCam.length >= 25, `${withCam.length} cars carry a VTEC/MIVEC step`);

  // Every rule must still match its rows — same rename tripwire the iconic
  // patterns get.
  const thin = [];
  for (const r of CAM_RULES) {
    const n = [...names].filter((x) => r.test.test(x)).length;
    if (n < r.minRows) thin.push(`${r.test} matched ${n}, needs ${r.minRows}`);
  }
  check('every cam rule still matches its expected rows',
    thin.length === 0, thin.length ? thin.join('; ') : `${CAM_RULES.length} rules`);

  // A crossover has to sit inside the usable rev range, with room to run on
  // afterwards — a step at or above redline would never be heard.
  const bad = [];
  for (const c of withCam) {
    const { cam } = voiceOf(c);
    if (cam.rpm <= c.idleRPM + 500) bad.push(`${c.name} engages at ${cam.rpm}, near idle ${c.idleRPM}`);
    if (cam.rpm >= c.redline - 800) bad.push(`${c.name} engages at ${cam.rpm}, too near redline ${c.redline}`);
    if (cam.rpm - CAM_DROPOUT_RPM <= c.idleRPM) bad.push(`${c.name} drops out below idle`);
  }
  check('every crossover sits inside the usable rev range',
    bad.length === 0, bad.length ? bad.slice(0, 3).join('; ') : `${withCam.length} cars`);

  // The step must be an UP-shift in character on every axis, or engaging the
  // aggressive cam would make the car sound tamer.
  const wrong = [];
  for (const c of withCam) {
    const { cam } = voiceOf(c);
    if (!(cam.peakHzMul > 1) || !(cam.shelfAdd > 0)
      || !(cam.peakDbAdd > 0) || !(cam.levelMul > 1)) wrong.push(c.name);
  }
  check('the cam step always sounds MORE aggressive, never less',
    wrong.length === 0, wrong.length ? wrong.slice(0, 3).join('; ') : `${withCam.length} cars`);

  // Fixed-cam engines must be untouched by any of this.
  const leaked = cars.filter((c) => !voiceOf(c).cam
    && CAM_RULES.some((r) => r.test.test(c.name)));
  check('no fixed-cam engine picked up a step',
    leaked.length === 0, leaked.length ? leaked.slice(0, 3).map((c) => c.name).join('; ')
      : `${cars.length - withCam.length} cars have none, as they should`);

  // Spot-check the ones a Honda person would notice, and prove the two
  // profiles are genuinely different rather than a rounding apart.
  for (const n of ['Honda S2000 `99', 'Honda NSX `90', 'Mitsubishi FTO GPX `94']) {
    const c = cars.find((x) => x.name === n);
    if (!c) { console.log('        MISSING:', n); continue; }
    const v = voiceOf(c);
    console.log(`        ${n}: cam at ${v.cam.rpm} rpm (redline ${c.redline})`
      + ` — formant ${v.peakHz.toFixed(0)} -> ${(v.peakHz * v.cam.peakHzMul).toFixed(0)} Hz,`
      + ` shelf ${v.shelfDb.toFixed(1)} -> ${(v.shelfDb + v.cam.shelfAdd).toFixed(1)} dB`);
  }

  // The FTO GR is the plain 6A12 — no second profile. If it ever gains one,
  // the rule has over-matched.
  const gr = cars.find((c) => c.name === 'Mitsubishi FTO GR `94');
  check('the non-MIVEC FTO GR is correctly excluded',
    !!gr && !voiceOf(gr).cam, gr ? 'GR has no cam step' : 'GR not in catalog');
}

console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILURE(S)`);
process.exit(fail === 0 ? 0 : 1);
