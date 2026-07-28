/**
 * H1251: PER-CAR ENGINE VOICE.
 *
 * User: "now that I added i4 engine sounds, they all kind of sound the same.
 * Can you alter the sound somehow to make each i4 car sound unique. If
 * possible, even different alterations based on exhaust modifications. This
 * can be a precedent for when I add more engine sounds for the remaining cars."
 *
 * There is ONE recorded voice per family (H1237), so all 124 L4 cars play the
 * identical loop at the identical rate. This derives a small, deterministic
 * character offset per car and applies it to that shared recording, so a
 * screaming 8500 rpm 1.6 and a lazy 5500 rpm 2.4 stop being the same engine.
 *
 * DESIGN NOTES, since this is meant to be the precedent for the other families:
 *
 * - Everything is derived from data the car ALREADY has (redline, hp, weight,
 *   aspiration, name) plus a stable hash of its id. No new per-car authoring:
 *   a new family inherits this the moment its samples land.
 * - It is deterministic. The same car sounds the same every session — a random
 *   voice per boot would read as a bug.
 * - The offsets are SMALL. The recording is the character; this is seasoning.
 *   Pitch moves at most a few percent, which is a different engine, not a
 *   chipmunk.
 *
 * The tone filters live on the family master (see sampleEngine), so they cost
 * two biquads total regardless of how many cars exist.
 */

import { iconicVoiceFor, camStepFor, type CamStep } from './iconicVoices';

/** Stable 32-bit hash of a car id — the per-unit "build variation" seed. */
function hashId(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967295;   // 0..1
}

export interface EngineVoice {
  /** Multiplies the sample playback rate. ~0.92..1.10. */
  rateMul: number;
  /** Peaking-filter centre (Hz) + gain (dB) — the formant that separates a
   *  gruff engine from a zingy one. */
  peakHz: number;
  peakDb: number;
  /** High-shelf gain (dB) — exhaust openness / rasp. */
  shelfDb: number;
  /** Overall level trim (linear) so a big-bore car sits heavier in the mix. */
  levelMul: number;
  /** H1254: which of the recorded turbo kits this car runs (see turboSample).
   *  Same idea one level up: the pack ships 10 different turbochargers instead
   *  of one, so the choice is the character and the per-car maths only has to
   *  pick well. Meaningless on an NA car — forcedInduction gates on it. */
  turboKit: string;
  /** H1276: VTEC/MIVEC cam changeover, or undefined on a fixed-cam engine.
   *  sampleEngine swaps these offsets in above cam.rpm — see CamStep. */
  cam?: CamStep;
}

/**
 * H1254: the 10 turbo kits ordered by MEASURED size — deepest/biggest spool
 * first, brightest/smallest last.
 *
 * The pack names the kits 1-10 in no particular order, so the ordering is the
 * geometric mean of each spool loop's FFT spectral centroid and its dominant
 * peak in the whistle band (kit3 3.45kHz … kit7 8.75kHz — a clean 2.5x spread,
 * and audibly a big single vs a little screamer). Measured once off the wavs;
 * the numbers are carried in public/audio/turbo/manifest.json under _measured
 * so this ladder can be re-derived rather than trusted.
 */
const TURBO_SIZE_LADDER = [
  'kit3', 'kit6', 'kit5', 'kit2', 'kit4', 'kit1', 'kit10', 'kit9', 'kit8', 'kit7',
] as const;

/** Effective HP that reads as "as big a turbo as this pack has" — a 450hp+
 *  build runs the deepest kit, a ~100hp economy turbo the smallest. Effective,
 *  not stock, so fitting power stages walks a car UP the ladder. */
const TURBO_HP_FLOOR = 100;
const TURBO_HP_SPAN = 350;

/** Pick a car's turbo kit. Deterministic, and jittered by a salted hash so two
 *  cars of identical output still aren't running the same turbocharger. */
export function pickTurboKit(id: string, hp: number): string {
  const t = Math.max(0, Math.min(1, ((hp || TURBO_HP_FLOOR) - TURBO_HP_FLOOR) / TURBO_HP_SPAN));
  const h = hashId((id || '') + '#turbo');
  const jitter = h < 1 / 3 ? -1 : h > 2 / 3 ? 1 : 0;
  const last = TURBO_SIZE_LADDER.length - 1;
  const idx = Math.max(0, Math.min(last, Math.round((1 - t) * last) + jitter));
  return TURBO_SIZE_LADDER[idx];
}

export interface VoiceCarInput {
  id: string;
  name: string;
  redline: number;
  hp: number;
  weight?: number;
  /** GT4 aspiration string: 'NA' | 'TURBO' | 'SuperCharger'. */
  aspiration?: string;
  /** H1274: idle RPM. Required to compute the per-car SAFE PITCH WINDOW — see
   *  safeRateWindow. Absent falls back to the catalog's floor of 500, which
   *  over-estimates the rev ratio and therefore errs toward a NARROWER window. */
  idleRPM?: number;
  /** H1274: displacement (cc) and the median displacement of the recorded
   *  family this car speaks through. The ratio is what says "big for its
   *  voice"; absolute cc cannot, because the family choice has already
   *  consumed most of the absolute-size information. 0 = unknown, and every
   *  axis that reads them must tolerate it. */
  cc?: number;
  familyMedianCc?: number;
  /** H1274: raw GT4 engine-type string ('L4 (DOHC)', 'V8 (OHV)') — the
   *  valvetrain token in the brackets is a real timbre axis. */
  eType?: string;
  modelYear?: number;
}

/**
 * H1274: the range of rateMul this car can take WITHOUT the sampleEngine pitch
 * clamp binding while both crossfade slots are audible.
 *
 * H1273 put the recorded bands on a geometric ladder and pitches each slot by
 * (rpm / bandRpm) * rateMul, hard-clamped to [0.66, 1.5]. A slot whose rate is
 * clamped stops tracking RPM and holds a fixed wrong note under the correct
 * one — the user-reported "multiple engines revving at different intervals".
 * rateMul eats directly into the headroom that clamp leaves.
 *
 * With S = redline/idle, a slot's pre-clamp rate is S^(r-frac) * rateMul. A
 * source is audible while its gain is within 14 dB of the loudest (the line the
 * shipped unison probe uses), which on the pair weights means |r - frac| stays
 * under 5/6 of a band gap. The widest gap in BAND_FRACS is 0.14, so the largest
 * audible stretch is Q = S^(7/60), and the clamp is safe exactly while
 * rateMul lies in [0.66 * Q, 1.5 / Q].
 *
 * Validated differentially against the real updateFamilySample on the catalog's
 * harshest ladder (S = 16): rateMul at the ceiling measured 18.8 cents of
 * spread and no bad frames; 10% past it measured 191 cents on 17.8% of frames,
 * i.e. the bug back in full.
 */
export function safeRateWindow(redline: number, idleRPM?: number): [number, number] {
  const idle = Math.max(1, idleRPM ?? 500);
  const S = Math.max(1.0001, (redline || 7000) / idle);
  const Q = Math.pow(S, 7 / 60);
  return [0.66 * Q, 1.5 / Q];
}

/** Exhaust state that colours the voice. Everything optional — absent means
 *  stock. */
export interface VoiceModInput {
  /** 0 = stock, 1 = full aftermarket system. */
  exhaustLevel?: number;
  /** Straight-through / no muffler — rasp with no back-pressure damping. */
  straightPipe?: boolean;
}

/**
 * H1274: THE EXHAUST LADDER — stock (muffled) to straight-through (aggressive).
 *
 * The user asked for this progression by name. It used to be one linear knob
 * plus a boolean, which meant a stage-1 car and a stage-3 car differed only by
 * a smooth interpolation nobody could point at. These are five distinct voices.
 *
 * The acoustics, in the order they matter:
 *  - SHELF is the headline. A muffler is a low-pass; taking it away is almost
 *    purely a treble lift. Stage 0 sits at the car's own spec-derived shelf,
 *    which for a soft cruiser is NEGATIVE — quieter and duller than the raw
 *    recording, because the recording was made on something sportier.
 *  - FORMANT rises as back pressure falls. A restrictive system resonates
 *    lower; opening it moves the peak up.
 *  - LEVEL rises throughout, and a straight pipe is louder at IDLE too, not
 *    just at full throttle — which falls out for free, since levelMul is a
 *    flat multiplier on the master rather than a load-dependent term.
 *
 * The stage-4 totals are deliberately close to what H1251 produced at
 * exhaustLevel 1 + straightPipe (shelf 8.5 dB, formant x1.14, level x1.26), so
 * a fully-built car does not suddenly change character; the new information is
 * all in stages 0-3.
 */
interface ExhaustStage {
  label: string;
  shelfAdd: number;
  peakHzMul: number;
  levelMul: number;
  /** Slight formant emphasis as the system opens up and stops damping it. */
  peakDbAdd: number;
}

const EXHAUST_LADDER: readonly ExhaustStage[] = [
  { label: 'stock',       shelfAdd: 0.0, peakHzMul: 1.000, levelMul: 1.000, peakDbAdd: 0.0 },
  { label: 'sport',       shelfAdd: 2.0, peakHzMul: 1.040, levelMul: 1.060, peakDbAdd: 0.2 },
  { label: 'performance', shelfAdd: 3.8, peakHzMul: 1.075, levelMul: 1.110, peakDbAdd: 0.4 },
  { label: 'race',        shelfAdd: 5.4, peakHzMul: 1.105, levelMul: 1.160, peakDbAdd: 0.6 },
  { label: 'straight',    shelfAdd: 8.5, peakHzMul: 1.140, levelMul: 1.260, peakDbAdd: 0.9 },
];

/** Resolve the ladder rung from the legacy continuous inputs, so every existing
 *  caller keeps working. exhaustLevel is powerStage/4 today, and straightPipe
 *  is set at stage 4 — so this reproduces the caller's intent exactly while
 *  giving the ladder named, separable rungs. */
function exhaustStageOf(mods: VoiceModInput): ExhaustStage {
  const ex = Math.max(0, Math.min(1, mods.exhaustLevel ?? 0));
  if (mods.straightPipe) return EXHAUST_LADDER[4];
  return EXHAUST_LADDER[Math.min(3, Math.round(ex * 4))];
}

/** Redline that reads as "average" for a 4-cylinder; cars above it sound
 *  peakier and are pitched up, below it lazier and pitched down. */
const REDLINE_REF = 7000;

/** Salted hash — one independent stream per axis, so a car that lands high on
 *  pitch isn't thereby also loud. */
function hashAxis(id: string, salt: string): number {
  return hashId(id + '#' + salt);
}

export function computeEngineVoice(car: VoiceCarInput, mods: VoiceModInput = {}): EngineVoice {
  const id = car.id || car.name || '';
  const h = hashId(id);
  const icon = iconicVoiceFor(car.name);

  // --- PITCH -------------------------------------------------------------
  // Redline proxies how short-stroke and busy the engine is. Compressed hard
  // (cube root) so nothing turns into a cartoon.
  const rr = Math.max(0.6, Math.min(1.6, (car.redline || REDLINE_REF) / REDLINE_REF));
  let rateMul = Math.cbrt(rr);
  // A big engine for its family turns slower and sounds it. Gentle — the
  // family already carries most of the size information.
  const ccRel = relativeDisplacement(car);
  rateMul *= Math.pow(ccRel, -0.022);
  rateMul *= 1 + (hashAxis(id, 'rate') - 0.5) * 0.035;    // +/-1.75% unit variation
  if (icon?.rateMulX) rateMul *= icon.rateMulX;
  // THE SAFETY CLAMP, and it is the last word on pitch — see safeRateWindow.
  // Everything above may ask for whatever it likes; a car physically cannot
  // leave the window where both crossfade slots stay in tune. This also
  // retires a latent defect: the old flat [0.90, 1.12] clamp let 33 of 365
  // cars sit outside their own envelope, which is a quiet recurrence of the
  // H1273 wrong-note bug at low crossfade weight.
  const [rLo, rHi] = safeRateWindow(car.redline, car.idleRPM);
  rateMul = Math.max(rLo, Math.min(rHi, rateMul));

  // --- FORMANT -----------------------------------------------------------
  // Displacement RELATIVE TO THE FAMILY is the honest bore cue: a 2.5 L is a
  // big lazy four but a tiny V8, and only the ratio knows which. Power-to-
  // weight is kept as a secondary term for state of tune, but it can no
  // longer dominate — on its own it claimed a Cobra 427 resonates at 944 Hz,
  // because "light and powerful" is precisely the wrong prior for a big
  // pushrod engine.
  const pwr = car.weight && car.weight > 0 ? car.hp / (car.weight / 1000) : 120;
  const pw = Math.max(0, Math.min(1, (pwr - 60) / 160));
  // The pw span stays wide — it is the single strongest separator in the
  // catalog, and narrowing it (the first attempt at this rewrite) made cars
  // LESS distinct, not more: same-family collisions went from 290 to 332.
  // What the ccRel term does is stop pw being the ONLY voice, which is what
  // let it claim a Cobra 427 resonates at 944 Hz.
  let peakHz = (360 + pw * 470) * Math.pow(ccRel, -0.34);
  peakHz *= 1 + (hashAxis(id, 'hz') - 0.5) * 0.12;
  let peakDb = 1.2 + pw * 2.0;

  // Valvetrain. A pushrod engine simply cannot make the top-end noise a
  // twin-cam does — two valves, low lift, and the cam is in the block.
  const cam = camOf(car.eType);
  peakHz *= cam.hzMul;

  // Forced induction muffles the intake edge and adds low-mid weight. The
  // recordings are NA, so the filter leans that way rather than pretending.
  const asp = (car.aspiration || '').toUpperCase();
  if (asp.includes('TURBO')) { peakHz *= 0.82; peakDb += 0.8; }
  else if (asp.includes('SUPER')) { peakHz *= 0.9; peakDb += 0.5; }

  // --- RASP (the stock high shelf) ---------------------------------------
  // Specific output is the best single predictor of exhaust energy up top:
  // valve overlap, port area and cam duration all track it. This is what
  // finally makes shelfDb a LIVE axis for stock cars — it was hard 0 for all
  // 365 of them, so a lazy cruiser and a screamer left the shelf identical.
  // Negative is the point: below the reference the car is more muffled than
  // the recording it borrows.
  let shelfDb = specificOutputRasp(car, asp);
  shelfDb += cam.shelfAdd;
  // Era. Pre-catalyst cars are thinner and brighter, with looser tolerances.
  const year = car.modelYear ?? 1990;
  if (year < 1975) { shelfDb += 1.2; peakDb += 0.5; }
  else if (year >= 1995) shelfDb -= 0.5;
  // Unit variation: a 30-year-old car's exhaust is not factory-fresh. Kept
  // smaller than the spec-driven span above (-1.2..+2.8 dB) so build scatter
  // seasons the rasp rather than swamping it. Measured: +/-0.7 dB takes
  // same-family near-identical pairs from 173 to 160; pushing to +/-1.1 only
  // reaches 127 and by then the axis is more noise than signal.
  shelfDb += (hashAxis(id, 'shelf') - 0.5) * 1.4;

  // --- LEVEL -------------------------------------------------------------
  // Bigger-for-its-family sits heavier in the mix. The floor is 0.75: below
  // roughly 0.7 a recorded car starts reading quieter than the synth-voiced
  // cars it shares a session with, which inverts the hierarchy.
  let levelMul = Math.pow(ccRel, 0.16);
  if (year < 1975) levelMul *= 0.95;
  levelMul *= 1 + (hashAxis(id, 'lvl') - 0.5) * 0.05;

  // --- ICONIC OVERRIDES --------------------------------------------------
  // Applied after the derivation and before the exhaust ladder, so a famous
  // car keeps its character AND still responds to exhaust work.
  if (icon) {
    if (icon.peakHz !== undefined) peakHz = icon.peakHz;
    if (icon.peakDb !== undefined) peakDb = icon.peakDb;
    if (icon.shelfDb !== undefined) shelfDb = icon.shelfDb;
    if (icon.levelMulX) levelMul *= icon.levelMulX;
  }

  // --- EXHAUST -----------------------------------------------------------
  // Stock -> straight-through. See EXHAUST_LADDER.
  const stage = exhaustStageOf(mods);
  shelfDb += stage.shelfAdd;
  peakHz *= stage.peakHzMul;
  peakDb += stage.peakDbAdd;
  levelMul *= stage.levelMul;

  void h;   // legacy unsalted hash retained for turbo-kit parity below
  return {
    rateMul,
    peakHz: Math.max(180, Math.min(1600, peakHz)),
    peakDb: Math.max(0, Math.min(6, peakDb)),
    // H1274: the floor is NEGATIVE now. A highshelf with negative gain is a
    // spec-defined, stable cut, and every consumer of this field was checked.
    shelfDb: Math.max(-4, Math.min(9, shelfDb)),
    levelMul: Math.max(0.75, Math.min(1.35, levelMul)),
    turboKit: pickTurboKit(id, car.hp),
    // H1276: the VTEC/MIVEC step, if this engine has a second cam profile.
    cam: camStepFor(car.name),
  };
}

/** Displacement as a ratio of this car's FAMILY median, clamped to a sane
 *  band. 1.0 when either figure is unknown, which reduces to the old
 *  size-blind behaviour rather than guessing. */
function relativeDisplacement(car: VoiceCarInput): number {
  const cc = car.cc ?? 0;
  const med = car.familyMedianCc ?? 0;
  if (!(cc > 0) || !(med > 0)) return 1;
  return Math.max(0.45, Math.min(2.2, cc / med));
}

/** Valvetrain from the GT4 eType bracket. */
function camOf(eType: string | undefined): { hzMul: number; shelfAdd: number } {
  const s = (eType || '').toUpperCase();
  if (s.includes('OHV')) return { hzMul: 0.86, shelfAdd: -1.2 };
  if (s.includes('DOHC') || s.includes('QOHC')) return { hzMul: 1.05, shelfAdd: 0.4 };
  if (s.includes('SOHC')) return { hzMul: 0.96, shelfAdd: -0.3 };
  return { hzMul: 1, shelfAdd: 0 };
}

/**
 * Specific output (hp per litre) mapped to high-shelf dB.
 *
 * Measured over the catalog, naturally-aspirated cars run p10..p90 = 52..108
 * hp/L around a median of 76, so 76 is the neutral point. Forced-induction
 * figures are boost-inflated (median 112) and would otherwise read as a wildly
 * cammy engine, so they are discounted back onto the NA scale.
 */
function specificOutputRasp(car: VoiceCarInput, asp: string): number {
  // H1275: eight familied cars carry no GT4 displacement at all (the GT40, the
  // Spoon Integra, the Panoz, three bikes...). Returning 0 left the rasp axis
  // SILENT for them — a 10 000 rpm race B18C got the same shelf as a shopping
  // car. Falling back to the family median keeps hp/L varying by output, which
  // is the half of the ratio those rows do have.
  const cc = (car.cc ?? 0) > 0 ? (car.cc as number) : (car.familyMedianCc ?? 0);
  if (!(cc > 0) || !(car.hp > 0)) return 0;
  let hpPerL = car.hp / (cc / 1000);
  if (asp.includes('TURBO') || asp.includes('SUPER')) hpPerL *= 0.68;
  const t = Math.max(-1, Math.min(1, (hpPerL - 76) / 34));
  return t >= 0 ? t * 2.8 : t * 1.2;
}
