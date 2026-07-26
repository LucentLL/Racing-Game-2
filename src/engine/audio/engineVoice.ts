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
}

/** Exhaust state that colours the voice. Everything optional — absent means
 *  stock, which must sound exactly like it did before this existed. */
export interface VoiceModInput {
  /** 0 = stock, 1 = full aftermarket system. */
  exhaustLevel?: number;
  /** Straight-through / no muffler — rasp with no back-pressure damping. */
  straightPipe?: boolean;
}

/** Redline that reads as "average" for a 4-cylinder; cars above it sound
 *  peakier and are pitched up, below it lazier and pitched down. */
const REDLINE_REF = 7000;

export function computeEngineVoice(car: VoiceCarInput, mods: VoiceModInput = {}): EngineVoice {
  const h = hashId(car.id || car.name || '');
  // --- PITCH -------------------------------------------------------------
  // Redline is the best proxy available for how "short-stroke and busy" an
  // engine is. A 8500 rpm screamer sits above the recording, a 5800 rpm
  // truck-ish four below it. Compressed hard (cube root) so nothing is a
  // cartoon, then nudged by the per-unit hash so two cars with identical
  // specs still aren't clones.
  const rr = Math.max(0.6, Math.min(1.6, (car.redline || REDLINE_REF) / REDLINE_REF));
  let rateMul = Math.cbrt(rr);
  rateMul *= 1 + (h - 0.5) * 0.035;          // +/-1.75% unit variation
  rateMul = Math.max(0.90, Math.min(1.12, rateMul));

  // --- TIMBRE ------------------------------------------------------------
  // Power-to-weight stands in for bore/exhaust volume: a heavy low-output
  // four is boomier and lower-formant, a light high-output one is harder and
  // more mid-forward.
  const pwr = car.weight && car.weight > 0 ? car.hp / (car.weight / 1000) : 120;
  const pw = Math.max(0, Math.min(1, (pwr - 60) / 160));
  let peakHz = 340 + pw * 520 + h * 90;      // ~340..950 Hz
  let peakDb = 1.2 + pw * 2.4;

  // Forced induction muffles the raw intake edge and adds low-mid weight —
  // the recorded voice is NA, so lean the filter that way rather than pretend.
  const asp = (car.aspiration || '').toUpperCase();
  if (asp.includes('TURBO')) { peakHz *= 0.82; peakDb += 0.8; }
  else if (asp.includes('SUPER')) { peakHz *= 0.9; peakDb += 0.5; }

  // --- EXHAUST -----------------------------------------------------------
  // The user's explicit ask. An aftermarket system opens the top end: more
  // high-shelf, a touch more level, and the formant moves up as back pressure
  // drops. Stock (level 0, no straight pipe) leaves the voice untouched.
  const ex = Math.max(0, Math.min(1, mods.exhaustLevel ?? 0));
  const shelfDb = ex * 5.0 + (mods.straightPipe ? 3.5 : 0);
  peakHz *= 1 + ex * 0.14;
  const levelMul = 1 + ex * 0.16 + (mods.straightPipe ? 0.10 : 0);

  return {
    rateMul,
    peakHz: Math.max(180, Math.min(1600, peakHz)),
    peakDb: Math.max(0, Math.min(6, peakDb)),
    shelfDb: Math.max(0, Math.min(9, shelfDb)),
    levelMul: Math.max(0.85, Math.min(1.35, levelMul)),
    turboKit: pickTurboKit(car.id || car.name || '', car.hp),
  };
}
