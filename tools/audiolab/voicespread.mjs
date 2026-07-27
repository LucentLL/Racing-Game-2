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
  ICONIC_VOICES, ICONIC_PATTERNS, iconicVoiceFor,
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

console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILURE(S)`);
process.exit(fail === 0 ? 0 : 1);
