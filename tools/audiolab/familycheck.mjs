/**
 * H1268: resolve EVERY catalog car to a recorded engine family and report the
 * distribution, so a mapping bug shows up as a number rather than as a car that
 * sounds wrong three hours into a playthrough.
 *
 * Checks:
 *   - every car resolves to a family that actually exists in the manifest
 *   - no family is assigned zero cars (a family nobody hears is ~0.6 MB of
 *     deploy paid for nothing)
 *   - no family swallows an implausible share of the catalog
 *   - cars left on the procedural voice are only the ones we MEANT to leave
 *   - each family's cars sit in a sane redline/displacement spread, since
 *     sampleEngine clamps playbackRate to 0.66..1.5 and cannot stretch further
 *
 * Bundle first:
 *   npx esbuild tools/audiolab/famentry.ts --bundle --alias:@=./src --format=esm \
 *     --outfile=tools/audiolab/famentry.mjs
 * Then: node tools/audiolab/familycheck.mjs
 */

import fs from 'node:fs';

const M = await import('./famentry.mjs');
const { CAR_CATALOG, GT4_SPECS, resolveEngineFamily, carCountry, carLayout, carDisplacementCc } = M;

const manifest = JSON.parse(fs.readFileSync('public/audio/engines/manifest.json', 'utf8'));
const known = new Set(Object.keys(manifest.families ?? {}));

let fail = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) fail++;
};

const cars = Object.entries(CAR_CATALOG);
const byFamily = new Map();
const unmapped = [];
const bogus = [];

for (const [id, car] of cars) {
  const fam = resolveEngineFamily({
    id, name: car.name, eType: car.eType, asp: car.asp,
    hp: car.hp, isBike: car.isBike, redline: car.redline, modelYear: car.modelYear,
  });
  if (fam == null) { unmapped.push([id, car]); continue; }
  if (!known.has(fam)) { bogus.push([id, car.name, fam]); continue; }
  if (!byFamily.has(fam)) byFamily.set(fam, []);
  byFamily.get(fam).push(car);
}

console.log(`${cars.length} catalog cars, ${known.size} families in the manifest\n`);

check('every resolved family exists in the manifest', bogus.length === 0,
  bogus.length ? bogus.slice(0, 8).map((b) => `${b[1]} -> ${b[2]}`).join('; ') : '');

// STATIC check, not a coverage one. The test above only sees families some car
// actually reaches TODAY; a family named in a rule that no current car happens
// to hit is invisible to it, and will fail SILENTLY the day a car does hit it
// (requestFamily no-ops on an unknown key and familySampleReady never goes
// true, so the car just quietly keeps the synth). H1268b removed three such
// dangling names and an audit found eleven more, so it is worth a real check:
// scan the resolver source for family-shaped literals and demand each ships.
{
  const src = fs.readFileSync('src/config/cars/engineFamily.ts', 'utf8');
  const FAM = /'((?:bike|boxer|bus|diesel|rotary|truck|v6|v8|v10|v12|i4|i6)_[a-z0-9_.]+)'/g;
  const named = new Set([...src.matchAll(FAM)].map((m) => m[1]));
  const dangling = [...named].filter((n) => !known.has(n));
  check('no rule names a family that is not shipped', dangling.length === 0,
    dangling.length ? dangling.join(', ') : `${named.size} names, all shipped`);
}

// Distribution, biggest first.
const rows = [...byFamily.entries()].sort((a, b) => b[1].length - a[1].length);
console.log('\n--- assignment ---');
for (const [fam, list] of rows) {
  const rl = list.map((c) => c.redline).sort((a, b) => a - b);
  const cc = list.map((c) => carDisplacementCc(c.name)).filter((v) => v > 0).sort((a, b) => a - b);
  const span = cc.length ? (cc[cc.length - 1] / Math.max(1, cc[0])).toFixed(1) + 'x' : '-';
  console.log(
    `  ${fam.padEnd(24)} ${String(list.length).padStart(3)} cars`
    + `  rpm ${String(rl[0]).padStart(5)}-${String(rl[rl.length - 1]).padEnd(5)}`
    + `  cc ${(cc[0] ?? 0)}-${cc[cc.length - 1] ?? 0} (${span})`
    + `   e.g. ${list[0].name}`,
  );
}

// A family in the deploy that nobody drives is wasted bytes — the pack has
// recordings for cars this catalog does not contain (Italian V8s and V10s,
// 3-rotors, buses). `--prune` deletes them from public/ and the manifest;
// re-running scripts/importEnginePack.mjs brings them back if the rules change.
const unused = [...known].filter((f) => !byFamily.has(f));
if (process.argv.includes('--prune') && unused.length) {
  let freed = 0;
  for (const fam of unused) {
    const dir = `public/audio/engines/${manifest.families[fam]?.dir ?? fam}`;
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir)) freed += fs.statSync(`${dir}/${f}`).size;
      fs.rmSync(dir, { recursive: true, force: true });
    }
    delete manifest.families[fam];
  }
  fs.writeFileSync('public/audio/engines/manifest.json', JSON.stringify(manifest, null, 2) + '\n');
  console.log(`\nPRUNED ${unused.length} unused famil${unused.length === 1 ? 'y' : 'ies'}`
    + ` (${(freed / 1e6).toFixed(1)} MB): ${unused.join(', ')}`);
  console.log('re-run without --prune to verify');
  process.exit(0);
}
check('\nevery shipped family is used by at least one car',
  unused.length === 0,
  unused.length ? `${unused.join(', ')} — run with --prune` : '');

// No single family should dominate. Before H1268 one generic i4 recording
// carried 124 of 380 cars (33%) and the user's report was that they all sounded
// the same. The floor here is set by the pack, not by the rules: the catalog is
// 36% Japanese inline-four and the pack contains exactly TWO Japanese
// inline-four recordings, so ~20% is the best a truthful mapping can do without
// putting Hondas on German takes.
const biggest = rows[0];
check('no family carries more than 25% of the catalog',
  biggest && biggest[1].length <= cars.length * 0.25,
  biggest ? `${biggest[0]} has ${biggest[1].length} (${(100 * biggest[1].length / cars.length).toFixed(0)}%)` : '');

// NOT a redline check. The pack's own prefabs set maxRPMLimit to a uniform 7000
// on all 50 families: the recordings are REV-RANGE-RELATIVE, and sampleEngine
// matches that — bandRpm = idleRPM + frac*(redline-idleRPM), so playbackRate
// sits at 1.0 at every band's home RPM no matter what the car revs to. A 13500
// rpm bike and a 5000 rpm truck both track their own range fine.
//
// DISPLACEMENT is the real risk, because that is what the recording's timbre
// actually encodes and no amount of rate normalisation changes it. A 2x span is
// about the limit of "same class of engine".
for (const [fam, list] of rows) {
  const cc = list.map((c) => carDisplacementCc(c.name)).filter((v) => v > 0);
  if (cc.length < 2) continue;
  const ratio = Math.max(...cc) / Math.max(1, Math.min(...cc));
  if (ratio > 2.6) {
    check(`${fam}: displacement spread is one class of engine`, false,
      `${Math.min(...cc)}-${Math.max(...cc)} cc = ${ratio.toFixed(1)}x`);
  }
}

console.log('\n--- left on the procedural pulse voice ---');
const byReason = new Map();
for (const [, car] of unmapped) {
  const why = car.isBike
    ? (car.name.startsWith('Harley') ? 'Harley V-twin (no V-twin in the pack)' : 'bike, no displacement')
    : `no layout data (eType="${car.eType ?? ''}")`;
  if (!byReason.has(why)) byReason.set(why, []);
  byReason.get(why).push(car.name);
}
for (const [why, names] of byReason) {
  console.log(`  ${names.length.toString().padStart(3)}  ${why}`);
  console.log(`       ${names.slice(0, 6).join(', ')}${names.length > 6 ? ', …' : ''}`);
}
check('\nunmapped cars are only bikes-without-a-take and specless rows',
  [...byReason.keys()].every((k) => /Harley|no layout data|no displacement/.test(k)),
  `${unmapped.length} of ${cars.length}`);

console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILURE(S)`);
process.exit(fail === 0 ? 0 : 1);
