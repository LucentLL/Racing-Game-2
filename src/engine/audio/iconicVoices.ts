/**
 * H1274: ICONIC VOICES — what the formula cannot know.
 *
 * The spec-driven axes in engineVoice derive character from data, which works
 * because specs really do predict sound. But they cannot know that a 427
 * side-oiler runs open side pipes, that an EJ20's unequal-length headers make
 * it burble, or that the Alfa 155's DTM V6 is one of the most famous noises in
 * motorsport. Those are facts about the world, so they are written down as
 * facts.
 *
 * Two rules keep this from rotting:
 *  - An entry exists only where the real car has a FAMOUS sound. This is not a
 *    place to hand-tune cars that merely need separating — that is the
 *    formula's job, and doing it here would decay into per-car guesswork.
 *  - Nothing here can escape the safety envelope. rateMulX is applied BEFORE
 *    the per-car clamp in computeEngineVoice, so a hand-authored pitch nudge is
 *    structurally unable to resurrect the H1273 wrong-note bug.
 *
 * Every character note is real-world knowledge, not measurement — nobody in
 * this loop can ear-test, so the user is the final judge of all of it.
 *
 * The biggest systematic correction is American V8s. The generic formant axis
 * reads power-to-weight, which put a Cobra 427 at 944 Hz and a Viper at 924 Hz:
 * "light and powerful" is exactly the wrong prior for a big lazy pushrod
 * engine, whose formant lives near 300 Hz. Every US entry pulls it down hard.
 */

export interface IconicVoice {
  /** Multiplies the formula's rateMul. The per-car safety clamp still applies
   *  afterwards, so this can never push a car outside its envelope. */
  rateMulX?: number;
  /** REPLACES the formula formant (Hz). The exhaust ladder still stacks. */
  peakHz?: number;
  /** REPLACES the formula formant emphasis (dB). */
  peakDb?: number;
  /** STOCK high-shelf, in dB — the rasp axis. Adds under the exhaust ladder. */
  shelfDb?: number;
  /** Multiplies the formula's levelMul. */
  levelMulX?: number;
}

/** Expand one voice across several catalog rows that share an engine. */
function fill(names: readonly string[], v: IconicVoice): Record<string, IconicVoice> {
  const out: Record<string, IconicVoice> = {};
  for (const n of names) out[n] = v;
  return out;
}

/**
 * Engine families spanning many trim levels get a PATTERN rather than a list of
 * exact names.
 *
 * Listing them by hand was the first attempt and it silently lost fourteen
 * rows: the catalog spells it "Vspec" where the obvious guess is "V-spec",
 * "IMPREZA Sedan WRX STi (GC) `94" carries a chassis code, and there are two
 * NSX Type S Zero years. Each of those would have quietly kept the generic
 * voice while looking authored in the source. A pattern cannot miss a trim,
 * and `minRows` turns a future catalog rename into a loud probe failure
 * instead of a silent regression.
 */
export interface IconicPattern {
  test: RegExp;
  /** Guard-probe tripwire: fail if fewer than this many catalog rows match. */
  minRows: number;
  voice: IconicVoice;
}

export const ICONIC_PATTERNS: readonly IconicPattern[] = [
  // RB26DETT — every GT-R road trim across R32/R33/R34 plus the NISMO cars.
  // Metallic raspy straight-six, cam gnash under twin-turbo whoosh. The rasp
  // rides shelfDb, which was a dead axis for every stock car before H1274.
  {
    test: /^Nissan SKYLINE GT-R |^NISMO (400R|Skyline GT-R|GT-R LM)/,
    minRows: 15,
    voice: { peakHz: 640, peakDb: 4.2, shelfDb: 1.5, levelMulX: 1.03 },
  },
  // C30A/C32B — VTEC V6 howl with titanium-rod smoothness. Honda and Acura
  // badges, every trim and year.
  {
    test: /NSX/,
    minRows: 12,
    voice: { peakHz: 900, peakDb: 3.8, shelfDb: 1.2, levelMulX: 1.02 },
  },
  // EJ20 — unequal-length headers give the offbeat boxer burble. The formant
  // drop carries most of it; the true warble needs an axis this system lacks.
  {
    test: /^Subaru (IMPREZA|LEGACY)/,
    minRows: 10,
    voice: { peakHz: 400, peakDb: 4.5, shelfDb: 0, levelMulX: 1.04 },
  },
  // 4G63 — gruff blocky midrange under a big-turbo whoosh.
  {
    test: /^Mitsubishi Lancer Evolution/,
    minRows: 9,
    voice: { peakHz: 540, peakDb: 4.2, shelfDb: 0.5, levelMulX: 1.02 },
  },
  // 13B-REW — smooth high rotary brap, hushed sequential turbos, and none of
  // the roughness a piston engine carries. FD plus the turbo FC rows.
  {
    test: /^Mazda RX-7 (Type|GT-Limited|GT-X|INFINI)/,
    minRows: 10,
    voice: { peakHz: 620, peakDb: 3.5, shelfDb: 1.0 },
  },
  // 6A12 MIVEC howl. The idle-500 rows are pitch-pinned by the safety
  // envelope, so their character has to come from the filters alone.
  {
    test: /^Mitsubishi FTO/,
    minRows: 6,
    voice: { peakHz: 850, peakDb: 3.5, shelfDb: 1.0 },
  },
  // B16A — the original VTEC zing.
  {
    test: /^Honda (CIVIC SiR|CR-X)/,
    minRows: 5,
    voice: { peakHz: 840, peakDb: 3.2, shelfDb: 0.8 },
  },
  // B16B / B18C-R — the Type R cars, cammy and thin-topped above the SiRs.
  {
    test: /^Honda (CIVIC|INTEGRA) TYPE R/,
    minRows: 4,
    voice: { peakHz: 890, peakDb: 3.7, shelfDb: 1.1, levelMulX: 1.02 },
  },
  // 2JZ / 1JZ / 7M — silky and DEEP where the RB is raspy. The two are the
  // classic contrast pair, so they are pushed apart deliberately.
  {
    test: /^Toyota SUPRA/,
    minRows: 3,
    voice: { peakHz: 470, peakDb: 3.0, shelfDb: 0, levelMulX: 1.03 },
  },
];

export const ICONIC_VOICES: Record<string, IconicVoice> = {
  // ---- JAPAN -------------------------------------------------------------
  // F20C: intake snarl hardening into a metallic 9000 rpm scream.
  'Honda S2000 `99': { peakHz: 980, peakDb: 4.0, shelfDb: 1.5, levelMulX: 1.04 },
  // 10 000 rpm race B18C on an open intake — the loudest NA four in the game.
  // Exact name so it outranks the Type R pattern above.
  'Spoon INTEGRA TYPE R (DC2) `99':
    { rateMulX: 0.98, peakHz: 1000, peakDb: 4.5, shelfDb: 2.5, levelMulX: 1.08 },
  // 4A-GE on T-VIS: induction honk, flat and eager through the midrange.
  ...fill(['Toyota COROLLA LEVIN GT-APEX (AE86) `83',
    'Toyota SPRINTER TRUENO GT-APEX (AE86) `83'],
    { rateMulX: 1.02, peakHz: 760, peakDb: 3.5, shelfDb: 0.8 }),
  // 20-valve 4A-GE on individual throttle bodies — throatier than the AE86.
  ...fill(['Toyota COROLLA LEVIN BZ-R `98', 'Toyota SPRINTER TRUENO BZ-R `98'],
    { peakHz: 820, peakDb: 4.0, shelfDb: 1.2, levelMulX: 1.02 }),
  // R26B quad-rotor — the Le Mans banshee, highest-pitched thing in the game.
  'Mazda 787B Race Car `91':
    { rateMulX: 1.01, peakHz: 1150, peakDb: 5.0, shelfDb: 3.0, levelMulX: 1.10 },
  // 10A Cosmo Sport: a silky hum, nothing like the later turbo rotaries.
  ...fill(['Mazda 110S (L10A) `67', 'Mazda 110S (L10B) `68'],
    { peakHz: 780, peakDb: 2.5, shelfDb: 1.0, levelMulX: 0.98 }),
  // Yamaha-headed 3M solid-lifter six — cultured, hard-edged.
  'Toyota 2000GT `67': { peakHz: 680, peakDb: 3.2, shelfDb: 1.0 },
  // L24 on SU carburettors: brassy, warm six burble.
  'Nissan 240ZG (HS30) `71': { peakHz: 460, peakDb: 3.0, shelfDb: 0.5 },
  // S20 — race-bred 24-valve, high and hard in a period way. Exact names so
  // they are not swept up by the RB26 pattern (different engine entirely).
  ...fill(['Nissan SKYLINE Hard Top 2000GT-R (KPGC10) `70',
    'Nissan SKYLINE 2000GT-R (KPGC110) `73'],
    { rateMulX: 1.02, peakHz: 720, peakDb: 3.5, shelfDb: 1.5, levelMulX: 1.02 }),
  // E07A MTREC: a 660 cc triple that revs like it resents being one.
  ...fill(['Honda BEAT `91', 'Honda BEAT Version F `92', 'Honda BEAT Version Z `93'],
    { peakHz: 900, peakDb: 2.5, shelfDb: 1.0 }),
  // Roller-crank quad-carb Honda S-series — a sewing machine that screams.
  ...fill(['Honda S800 `66', 'Honda S500 `63', 'Honda S600 `64'],
    { rateMulX: 1.02, peakHz: 950, peakDb: 3.0, shelfDb: 1.5 }),
  // 981 hp twin-turbo hillclimb special.
  'Suzuki ESCUDO Dirt Trial Car `98':
    { peakHz: 700, peakDb: 5.0, shelfDb: 2.0, levelMulX: 1.12 },
  // Bikes. Harley is deliberately ABSENT — those rows resolve to no recorded
  // family (the pack has no V-twin) and must stay on the procedural voice.
  'Kawasaki Ninja ZX-6R': { peakHz: 1100, peakDb: 4.0, shelfDb: 2.0, levelMulX: 1.05 },
  'Kawasaki Ninja 250': { peakHz: 1000, peakDb: 3.5, shelfDb: 1.0 },
  // Air-cooled GSX four: rawer and boomier than a modern screamer.
  'Suzuki Katana': { peakHz: 750, peakDb: 3.2, shelfDb: 1.5 },

  // ---- AMERICA -----------------------------------------------------------
  // FE 427 side-oiler through open side pipes: low thunder with a hard crackle.
  ...fill(['Shelby Cobra 427 `67', 'AC Cars 427 S/C `66'],
    { rateMulX: 0.97, peakHz: 330, peakDb: 3.0, shelfDb: 2.0, levelMulX: 1.12 }),
  // 426 Hemi: a hammering lope.
  ...fill(['Dodge Charger Super Bee 426 Hemi `71', 'Plymouth Super Bird `70'],
    { rateMulX: 0.97, peakHz: 300, peakDb: 3.0, shelfDb: 1.0, levelMulX: 1.10 }),
  // 440 big-block: lazy and deep.
  ...fill(['Dodge Charger 440 R/T `70', 'Plymouth Cuda 440 Six Pack `71'],
    { rateMulX: 0.98, peakHz: 290, peakDb: 2.8, shelfDb: 0.5, levelMulX: 1.08 }),
  // LS6 454 — the loudest of the muscle era.
  'Chevrolet Chevelle SS 454 `70': { peakHz: 310, peakDb: 3.0, shelfDb: 1.0, levelMulX: 1.10 },
  // 289 HiPo with side exits: a bark rather than a rumble.
  'Shelby Mustang G.T. 350R `65': { peakHz: 420, peakDb: 3.5, shelfDb: 2.0, levelMulX: 1.10 },
  // 389 tri-power: a softer lope than the Mopars.
  'Pontiac Tempest Le Mans GTO `64':
    { rateMulX: 0.97, peakHz: 300, peakDb: 2.8, shelfDb: 0.5, levelMulX: 1.06 },
  // Small-block Chevy rumble — the default American V8 in most people's heads.
  ...fill(['Chevrolet Corvette Coupe (C2) `63',
    'Chevrolet Corvette Stingray L46 350 (C3) `69',
    'Chevrolet Camaro SS `69', 'Chevrolet Camaro Z28 302 `69'],
    { peakHz: 350, peakDb: 3.0, shelfDb: 0.8, levelMulX: 1.05 }),
  // LT5 32-valve: a V8 bottom with a DOHC top-end howl, unlike any other US V8.
  'Chevrolet Corvette ZR-1 (C4) `90': { peakHz: 520, peakDb: 3.2, shelfDb: 1.2, levelMulX: 1.04 },
  // 8.0 pushrod V10 out of the side sills: a flat, unmusical drone. The single
  // worst formant miss the generic formula made (it wanted 924 Hz).
  'Dodge VIPER GTS `99':
    { rateMulX: 0.97, peakHz: 320, peakDb: 2.5, shelfDb: 1.0, levelMulX: 1.08 },
  // The anti-override: the GNX is a hushed sleeper, all turbo and no bark.
  'BUICK GNX `87': { peakHz: 380, peakDb: 1.8, shelfDb: 0, levelMulX: 0.98 },
  // Gurney-Weslake 302: raw race thunder.
  'Ford GT40 Race Car `69': { peakHz: 430, peakDb: 3.5, shelfDb: 2.0, levelMulX: 1.10 },

  // ---- EUROPE + RACE -----------------------------------------------------
  // Air-cooled turbo flat-six: a hollow whoosh over audible valve clatter.
  ...fill(['RUF BTR `86', 'RUF CTR "Yellow Bird" `87', 'RUF CTR2 `96'],
    { peakHz: 480, peakDb: 3.5, shelfDb: 1.0, levelMulX: 1.02 }),
  // Air-cooled VW chuff — tinny, and quieter than anything else here.
  'Volkswagen Karmann Ghia Coupe (Type-1) `68':
    { peakHz: 350, peakDb: 1.5, shelfDb: 1.0, levelMulX: 0.95 },
  // M198 direct-injection six: authoritative, gravelly.
  'Mercedes-Benz 300 SL Coupe `54': { peakHz: 520, peakDb: 3.0, shelfDb: 0.5, levelMulX: 1.02 },
  // XK6: velvet growl.
  'Jaguar E-Type Coupe `61': { peakHz: 420, peakDb: 2.8, shelfDb: 0 },
  // 7.0 V12 — colossal and smooth, the Group C wail.
  'Jaguar XJR-9 Race Car `88':
    { rateMulX: 1.04, peakHz: 820, peakDb: 4.5, shelfDb: 1.5, levelMulX: 1.10 },
  'Lister Storm V12 Race Car `99': { peakHz: 600, peakDb: 4.0, shelfDb: 1.5, levelMulX: 1.10 },
  // S70 V12: urgent, ripping.
  ...fill(['BMW McLaren F1 GTR Race Car `97', 'BMW V12 LMR Race Car `99'],
    { rateMulX: 1.04, peakHz: 880, peakDb: 4.5, shelfDb: 2.0, levelMulX: 1.08 }),
  // Really an M297 6.9 V12 — see the matching family override in engineFamily.
  'AMG Mercedes CLK-GTR Race Car `98': { peakHz: 800, peakDb: 4.0, shelfDb: 1.5, levelMulX: 1.08 },
  // Twin flat-plane cranks: a V16 shriek.
  'Cizeta V16T `94': { rateMulX: 1.03, peakHz: 950, peakDb: 4.0, shelfDb: 2.0, levelMulX: 1.05 },
  // The 11 750 rpm DTM Busso. The safety envelope pins its pitch, so the
  // scream has to be entirely filter-side.
  'Alfa Romeo 155 2.5 V6 TI `93': { peakHz: 1000, peakDb: 5.0, shelfDb: 3.0, levelMulX: 1.10 },
  // Road Busso: sonorous midrange howl.
  ...fill(['Alfa Romeo 156 2.5 V6 24V `98', 'Alfa Romeo 166 2.5 V6 24V Sportronic `98'],
    { peakHz: 720, peakDb: 3.8, shelfDb: 1.5, levelMulX: 1.03 }),
  // ITC V6 — the same class of scream as the 155, but a harder, less melodic
  // edge: the Alfa is a Busso and this is not, so they are deliberately parted.
  'Opel Calibra Touring Car `94': { peakHz: 930, peakDb: 4.8, shelfDb: 3.8, levelMulX: 1.08 },
  // 3.5 V10 at very nearly F1 pitch.
  'Peugeot 905 Race Car `92': { peakHz: 1100, peakDb: 5.0, shelfDb: 3.5, levelMulX: 1.10 },
  // Inline-five offbeat warble. The formant fakes part of it; the rest needs an
  // axis this system does not have.
  'Audi quattro `82': { peakHz: 560, peakDb: 4.0, shelfDb: 0.5, levelMulX: 1.03 },
  // Dino V6: exotic, ripping.
  ...fill(['Lancia STRATOS `73', 'Lancia STRATOS Rally Car `77'],
    { peakHz: 800, peakDb: 3.8, shelfDb: 1.5, levelMulX: 1.05 }),
  // 5.0 Rover V8, famously barely silenced.
  'TVR Griffith 500 `94': { peakHz: 380, peakDb: 3.2, shelfDb: 2.5, levelMulX: 1.15 },
  'TVR Cerbera Speed Six `97': { peakHz: 650, peakDb: 4.0, shelfDb: 2.0, levelMulX: 1.10 },
  // V600: a supercharged brute burble (the blower whine is inexpressible here).
  'Aston Martin V8 Vantage `99': { peakHz: 350, peakDb: 3.0, shelfDb: 0.5, levelMulX: 1.08 },
  // DTM 10 000 rpm four.
  'AMG Mercedes 190 E 2.5 - 16 Evolution II Touring Car `92':
    { peakHz: 950, peakDb: 4.5, shelfDb: 3.0, levelMulX: 1.08 },
  // M119 5.0 twin-turbo: a deep boosted bellow, NOT a flat-plane screamer — so
  // this pulls the shared race-V8 voice DOWN rather than up.
  'Sauber Mercedes C 9 Race Car `89':
    { rateMulX: 0.97, peakHz: 520, peakDb: 4.0, shelfDb: 1.0, levelMulX: 1.08 },
  // VRH35Z: boost-heavy growl-shriek.
  ...fill(['Nissan R92CP Race Car `92', 'Nissan R89C Race Car `89'],
    { peakHz: 640, peakDb: 4.5, shelfDb: 1.5, levelMulX: 1.08 }),
};

/** The iconic voice for this car, or undefined. Exact names win over patterns,
 *  so a standout trim can still be called out inside a covered group — that is
 *  how the Spoon Integra escapes the Type R pattern and the KPGC10 escapes the
 *  RB26 one. */
export function iconicVoiceFor(name: string): IconicVoice | undefined {
  const exact = ICONIC_VOICES[name];
  if (exact) return exact;
  for (const p of ICONIC_PATTERNS) if (p.test.test(name)) return p.voice;
  return undefined;
}
