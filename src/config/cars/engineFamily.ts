/**
 * H1268: CAR → RECORDED ENGINE FAMILY.
 *
 * The user bought the full Skril "RealisticEngineSound" pack: 50 recorded
 * families instead of the single generic i4 that H1237 shipped. Picking one is
 * no longer something the raw engine type can do — proceduralEngine's classifier
 * collapses everything to eleven voice classes (i4/i6/v6/v8/…), and the pack
 * distinguishes i4_German_1 from i4_Japanese_2 from i4_Serbian. So this maps a
 * catalog car onto a specific recording using everything the car knows:
 * nationality (parsed from the GT4 name), layout, displacement, aspiration,
 * output and year.
 *
 * RULES, in order — first match wins. Two principles behind them:
 *
 *  - Match the RECORDING, not the label. A 9000 rpm screamer must not get a
 *    lazy 5500 rpm take pitched up, and a 1.0 L kei triple must not get a 2.5 L
 *    take pitched down; playbackRate is clamped to 0.66..1.5 in sampleEngine, so
 *    anything further apart than that simply cannot be reached.
 *  - USE THE VARIANTS. The pack ships _1/_2/_3 of most families precisely so a
 *    hundred cars do not share one loop. Where there is no principled axis to
 *    split on, a stable hash of the car id spreads them deterministically —
 *    the same car always sounds the same.
 *
 * A car with no good recording returns null and keeps the H1225 procedural
 * pulse voice, which is the correct answer for Harley V-twins (no V-twin in this
 * pack) and for layouts nobody recorded.
 */

import { GT4_SPECS } from './gt4Database';

/** What the resolver needs. CatalogCar satisfies it; the audiolab and probes
 *  can hand-build one. */
export interface FamilyCarInput {
  id?: string;
  name: string;
  /** Raw GT4 engine-type string, e.g. 'V8 (OHV)', 'Rotor2 (Rotary)'. */
  eType?: string;
  /** 'NA' | 'TURBO' | 'SuperCharger'. */
  asp?: string;
  hp: number;
  isBike: boolean;
  redline: number;
  modelYear?: number;
}

export type Country =
  | 'jp' | 'de' | 'it' | 'gb' | 'us' | 'fr' | 'se' | 'other';

/** Leading token of a GT4 key → country. Built from the REAL 65 makes in
 *  GT4_DB (verified by enumerating the keys), not from a guess at what a
 *  car database usually contains. */
const MAKE_COUNTRY: Record<string, Country> = {
  // Japan (218 of 370 rows — the catalog is overwhelmingly JDM)
  Nissan: 'jp', Honda: 'jp', Mitsubishi: 'jp', Toyota: 'jp', Mazda: 'jp',
  Subaru: 'jp', Daihatsu: 'jp', Suzuki: 'jp', Lexus: 'jp', Acura: 'jp',
  Infiniti: 'jp', NISMO: 'jp', Isuzu: 'jp', Kawasaki: 'jp', SILEIGHTY: 'jp',
  Spoon: 'jp', DOME: 'jp', MINOLTA: 'jp', Eunos: 'jp', Autozam: 'jp',
  // Germany
  'Mercedes-Benz': 'de', BMW: 'de', Audi: 'de', Volkswagen: 'de', Opel: 'de',
  RUF: 'de', AMG: 'de', Porsche: 'de',
  // Sauber ran Mercedes power; its V8 belongs with the German race voices.
  Sauber: 'de',
  // Italy
  Alfa: 'it', Lancia: 'it', Fiat: 'it', Cizeta: 'it', Autobianchi: 'it',
  Ferrari: 'it', Lamborghini: 'it', Maserati: 'it', Pagani: 'it',
  // Britain
  Lotus: 'gb', Jaguar: 'gb', TVR: 'gb', Aston: 'gb', Ginetta: 'gb',
  Lister: 'gb', Marcos: 'gb', MGF: 'gb', Triumph: 'gb', Jensen: 'gb',
  MINI: 'gb', Mini: 'gb',
  // USA. AC is a British chassis but the 427 S/C is a Ford big-block, and it
  // is the ENGINE we are voicing.
  Chevrolet: 'us', Ford: 'us', Dodge: 'us', Plymouth: 'us', Shelby: 'us',
  BUICK: 'us', Chaparral: 'us', Pontiac: 'us', Mercury: 'us', Panoz: 'us',
  AC: 'us', EAGLE: 'us', Cadillac: 'us', Chrysler: 'us',
  'Harley-Davidson': 'us',
  // France
  Peugeot: 'fr', Citroen: 'fr', Renault: 'fr', Alpine: 'fr', Hommell: 'fr',
  Venturi: 'fr',
  // Sweden
  Volvo: 'se', Saab: 'se',
};

/** The make token of a GT4 name — its first word. 'Mercedes-Benz 190 E…' →
 *  'Mercedes-Benz'. Names in this database always lead with the marque. */
export function carMake(name: string): string {
  return name.split(' ')[0] ?? '';
}

export function carCountry(name: string): Country {
  return MAKE_COUNTRY[carMake(name)] ?? 'other';
}

/** Displacement in cc from the GT4 spec string ('2977cc', '2400 cc',
 *  '499.5cc'). 0 when unknown — every rule that uses it must tolerate 0. */
export function carDisplacementCc(name: string): number {
  const raw = (GT4_SPECS as Record<string, { disp?: string } | undefined>)[name]?.disp;
  if (!raw) return 0;
  const m = /([\d.]+)/.exec(raw);
  return m ? Math.round(parseFloat(m[1])) : 0;
}

/**
 * Cars whose GT4 row has no usable engine type (and often no displacement), so
 * no rule below can reach them. Each of these has an unambiguous real answer —
 * the GT40 is a Ford big-block, the Spoon Integra is a 10 000 rpm B18C — and
 * there are few enough to simply name.
 */
const NAME_OVERRIDES: Record<string, string | null> = {
  'Ford GT40 Race Car `69': 'v8_american_classic_1',
  'Panoz Esperante GTR-1 Race Car `98': 'v8_formula',
  'Mitsubishi PAJERO Rally Raid Car `85': 'v6_japanese_1',
  'Spoon INTEGRA TYPE R (DC2) `99': 'i4_japanese_1',
  // Three bike rows carry no displacement at all; the model names give it.
  'Suzuki Katana': 'bike_1000ccm',
  'Honda CB500': 'bike_600ccm',
  'Suzuki Bandit 400': 'bike_600ccm',
};

/** Stable 0..1 hash of a string — the deterministic spreader for variant
 *  families. Same FNV-1a engineVoice.hashId uses, so the two agree on what
 *  "this car" is. */
function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967295;
}

/** Pick one of `opts` deterministically for this car. */
function spread(key: string, opts: readonly string[]): string {
  return opts[Math.min(opts.length - 1, Math.floor(hash01(key) * opts.length))];
}

/** Coarse layout from the raw GT4 eType string. Deliberately separate from
 *  proceduralEngine.classifyEngine: that one answers "which synth voice", this
 *  one answers "which physical layout", and it must not collapse an L5 into an
 *  L4 the way the synth classifier reasonably does. */
type Layout = 'l3' | 'l4' | 'l5' | 'l6' | 'v6' | 'v8' | 'v10' | 'v12' | 'v16'
  | 'f4' | 'f6' | 'rot2' | 'rot3' | 'rot4' | 'other';

export function carLayout(eType: string | undefined): Layout {
  const s = (eType ?? '').toUpperCase();
  if (!s) return 'other';
  // 'ROTAR2' is not a typo here — it is a typo in the GT4 data itself, on
  // exactly one row (Mazda RX-7 GT-X (FC, J) `90). Matching only 'ROTOR' sent
  // that car to the synth while its twelve siblings got the rotary recording.
  if (s.includes('ROTOR4') || s.includes('ROTAR4')) return 'rot4';
  if (s.includes('ROTOR3') || s.includes('ROTAR3')) return 'rot3';
  if (s.includes('ROTOR') || s.includes('ROTAR')) return 'rot2';
  if (s.startsWith('V16')) return 'v16';
  if (s.startsWith('F4') || s.includes('FLAT4') || s.includes('BOXER4')) return 'f4';
  if (s.startsWith('F6') || s.includes('FLAT6') || s.includes('BOXER6')) return 'f6';
  if (s.startsWith('V12')) return 'v12';
  if (s.startsWith('V10')) return 'v10';
  if (s.startsWith('V8')) return 'v8';
  if (s.startsWith('V6')) return 'v6';
  if (s.startsWith('L6') || s.startsWith('I6')) return 'l6';
  if (s.startsWith('L5') || s.startsWith('I5')) return 'l5';
  if (s.startsWith('L4') || s.startsWith('I4')) return 'l4';
  if (s.startsWith('L3') || s.startsWith('I3')) return 'l3';
  return 'other';
}

/**
 * Which recorded family this car should speak with, or null to keep the
 * procedural pulse voice.
 *
 * Returned keys are manifest family keys — the lowercased pack directory names
 * that scripts/importEnginePack.mjs writes.
 */
export function resolveEngineFamily(car: FamilyCarInput): string | null {
  const name = car.name;
  const key = car.id ?? name;
  const make = carMake(name);
  const country = carCountry(name);
  const layout = carLayout(car.eType);
  const cc = carDisplacementCc(name);
  const turbo = car.asp === 'TURBO' || car.asp === 'SuperCharger';

  // --- cars the GT4 data cannot classify ----------------------------------
  // Seven rows carry no usable eType ('- (-)', '- (DOHC)', or nothing at all)
  // and several of those also carry no displacement, so every rule below would
  // fall through to the synth. They are named individually because there are
  // seven of them and each has an obvious right answer.
  const BY_NAME = NAME_OVERRIDES[name];
  if (BY_NAME !== undefined) return BY_NAME;

  // --- bikes ---------------------------------------------------------------
  if (car.isBike) {
    // No V-twin anywhere in this pack. A Harley on an inline-four take is
    // worse than the H1225 'hd' pulse voice, which was built for exactly this
    // 45-degree potato. The user knows and may buy a V-twin pack later.
    if (make === 'Harley-Davidson') return null;
    if (cc > 0 && cc < 300) return 'bike_125ccm';
    if (cc > 0 && cc <= 660) return 'bike_600ccm';
    if (cc > 0 && cc <= 800) return 'bike_660ccm';
    return 'bike_1000ccm';
  }

  // --- non-GT4 utility vehicles -------------------------------------------
  // These are hand-authored catalog rows with no GT4 spec, so they are matched
  // by name before any layout rule (layout would be 'other' and fall through).
  if (/^Semi|^Box|Truck/i.test(name)) {
    return (car.modelYear ?? 2000) < 1990 ? 'truck_classic' : 'truck_modern';
  }
  if (/^Bus\b/i.test(name)) {
    return (car.modelYear ?? 2000) < 1990 ? 'bus_classic' : 'bus_modern';
  }
  if (/^Ambulance|^Tow\b/i.test(name)) return 'diesel_2.5_german';

  // --- rotary --------------------------------------------------------------
  if (layout === 'rot4') return 'rotary_4_rotor';
  if (layout === 'rot3') return 'rotary_x3';
  if (layout === 'rot2') {
    // The 13B-REW turbo cars (RX-7 FC/FD) get the turbo rotary take; the NA
    // 12A/Renesis cars split across two of the x8 variants. Only two NA rotary
    // cars exist in this catalog, so spreading them over four families would
    // ship two recordings nobody ever hears.
    if (turbo) return 'rotary_x7';
    return spread(key, ['rotary_x8_1', 'rotary_x8_2']);
  }

  // --- boxer ---------------------------------------------------------------
  if (layout === 'f4' || layout === 'f6') {
    // Air-cooled VW/Porsche flat fours and sixes.
    if (country === 'de') return 'boxer_german';
    // Every Japanese boxer in this catalog is a turbo Subaru (15 of 16), so
    // splitting on aspiration would put all of them on one recording and leave
    // the other unused. Spread instead — the takes are two different Subarus.
    return spread(key, ['boxer_japanese_1', 'boxer_japanese_2']);
  }

  // --- V12 / V16 -----------------------------------------------------------
  if (layout === 'v12') return country === 'gb' ? 'v12_british' : 'v12_italian';
  // The Cizeta V16T's engine is literally two V8s sharing a crankcase and
  // nobody recorded a V16. The Italian V12 is the closest thing in the pack:
  // same exotic multi-cylinder wail, same country, right ballpark of cylinders.
  if (layout === 'v16') return 'v12_italian';

  // --- V10 -----------------------------------------------------------------
  if (layout === 'v10') {
    // USER CALL: the Viper's pushrod V10 is a big American lump, nothing like
    // the Audi/Lamborghini V10s this pack recorded — the user asked for a
    // modern American V8 instead, which is much closer in character.
    if (country === 'us') return 'v8_american_modern_2';
    return country === 'it' ? 'v10_italian' : 'v10_german';
  }

  // --- V8 ------------------------------------------------------------------
  if (layout === 'v8') {
    // Purpose-built race V8s (Group C / LMP / DTM / F1-adjacent) scream far
    // past anything a road car does; the Formula take is the only one that
    // reaches without absurd pitch shifting.
    if (car.redline >= 8200 || /Race Car|GTR|LMP|Formula|Chaparral|DOME|MINOLTA|Sauber/i.test(name)) {
      return 'v8_formula';
    }
    if (country === 'it') return spread(key, ['v8_italian_1', 'v8_italian_2', 'v8_italian_3']);
    if (country === 'de') {
      return spread(key, ['v8_german', 'v8_german_sport_1', 'v8_german_sport_2', 'v8_german_sport_3']);
    }
    if (country === 'gb') {
      // British V8s of this era are lazy, large and often Ford/GM-derived
      // (AC, Jensen, TVR, early Aston) — the American takes fit far better
      // than the high-strung German or Italian ones.
      return (car.modelYear ?? 1990) < 1980
        ? spread(key, ['v8_american_classic_1', 'v8_american_classic_2'])
        : spread(key, ['v8_american_modern_1', 'v8_american_modern_2']);
    }
    // American (and everything else): carburetted muscle vs modern EFI.
    return (car.modelYear ?? 1990) < 1980
      ? spread(key, ['v8_american_classic_1', 'v8_american_classic_2'])
      : spread(key, ['v8_american_modern_1', 'v8_american_modern_2']);
  }

  // --- V6 ------------------------------------------------------------------
  if (layout === 'v6') {
    // The pack has only Japanese V6s. A European V6 on a Japanese V6 take is
    // still the right LAYOUT and firing order, which is what dominates the
    // character — much closer than dropping to the synth.
    return turbo ? 'v6_japanese_1' : 'v6_japanese_2';
  }

  // --- inline six ----------------------------------------------------------
  if (layout === 'l6') {
    if (country === 'jp') return turbo ? 'i6_japanese_1' : 'i6_japanese_2';
    if (country === 'de') {
      return spread(key, ['i6_german', 'i6_german_free', 'i6_german_sport_1',
        'i6_german_sport_2', 'i6_german_sport_3']);
    }
    // Jaguar XK, Volvo, TVR straight sixes — the BMW takes are the closest
    // large-capacity European straight six in the pack.
    return spread(key, ['i6_german', 'i6_german_sport_1']);
  }

  // --- inline five ---------------------------------------------------------
  // Audi's 5-cylinder warble is neither a four nor a six. i6_German_free is the
  // least-wrong stand-in (offbeat, same broad capacity class); flagged so it can
  // be revisited if a 5-cylinder pack ever appears.
  if (layout === 'l5') return 'i6_german_free';

  // --- inline four / three -------------------------------------------------
  if (layout === 'l4' || layout === 'l3') {
    // KEI CARS FIRST, whatever the country. A 358 cc Carol or a 659 cc Midget
    // II revving to 8500 is not a small version of a 2.0 twin-cam — it is,
    // acoustically, a motorbike engine, and the pack has recordings at exactly
    // those displacements. This also fixes a hard reach problem: the Japanese
    // inline-four bucket spanned 358-2400 cc (6.7x) and sampleEngine clamps
    // playbackRate to 0.66..1.5, so one recording could not physically cover
    // both ends. Twenty kei cars come off the top here.
    if (cc > 0 && cc <= 400) return 'bike_125ccm';
    if (cc > 0 && cc <= 800) return 'bike_660ccm';
    // Small, low-output economy fours of ANY origin. The Serbian take is a
    // rough, breathless little engine, which is what a 1.0-1.4 L 90 hp
    // shopping car actually sounds like — Japanese ones included. Placed
    // before the country rules deliberately: origin matters far less than
    // this size/output class, and leaving it after them dumped 20 more cars
    // onto the already-largest Japanese bucket.
    if (cc > 0 && cc <= 1400 && car.hp <= 110) return 'i4_serbian';
    if (country === 'jp') {
      // High-revving screamers (F20C, 4A-GE, B18C) vs everyday twin-cams. The
      // recordings differ most in how far up they were pulled, so redline is a
      // better axis here than displacement.
      return car.redline >= 7800 ? 'i4_japanese_1' : 'i4_japanese_2';
    }
    if (country === 'de') {
      return spread(key, ['i4_german_1', 'i4_german_2', 'i4_german_3']);
    }
    if (country === 'it' || country === 'fr' || country === 'gb' || country === 'se') {
      return spread(key, ['i4_german_1', 'i4_german_2', 'i4_german_3']);
    }
    return spread(key, ['i4_japanese_2', 'i4_german_2']);
  }

  // No layout data (eType === '') or something nobody recorded — the pulse
  // synth still has a voice for it.
  return null;
}
