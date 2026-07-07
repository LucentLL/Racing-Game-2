/**
 * H1067 (BL-1): the BLACKLIST rival roster — docs/BLACKLIST.md.
 *
 * Ten named rivals over the existing streetTier ladder, NFS-MW-style:
 * each is gated by wins + street rep (milestones land with BL-3's
 * challenge races). Rivals resolve their signature car from the
 * RUNTIME catalog by name pattern (ids are generated, not literal) —
 * see [[resolveRivalCar]].
 *
 * Boss-car uniqueness (design doc): while a rival is undefeated their
 * signature car is THE instance of that model in the world; the
 * pink-slip marker (BL-4) is the only way to own it. Static config —
 * progression state lives on life.blacklist (save blob).
 */

import { CAR_CATALOG, type CatalogCar } from '@/config/cars/catalog';

export type RivalVenue = 'drag' | 'oval' | 'city';

export interface BlacklistRival {
  /** Ladder position, 10 (entry) … 1 (boss). */
  rank: number;
  alias: string;
  /** Case-insensitive regex source matched against catalog car NAMES
   *  (first match wins; ids are runtime-generated). */
  carMatch: string;
  /** Fallback display when no catalog car matches the pattern. */
  carLabel: string;
  venue: RivalVenue;
  /** Challenge gate: total street-race wins + streetRep floor.
   *  (Milestones join the gate in BL-3.) */
  gate: { wins: number; rep: number };
  /** Mugshot inputs for drawCharacterBase. */
  gender: 'M' | 'F';
  fitness: number;
  /** Pre-race trash talk. Slots: {playerCar} {rivalCar}. The manual
   *  jab is appended by tauntFor() only when the player's car is an
   *  automatic. */
  taunts: string[];
}

export const BLACKLIST_RIVALS: readonly BlacklistRival[] = [
  // carMatch: FLAT priority alternatives (split on '|', tried in order;
  // no parenthesized groups — resolveRivalCar splits naively).
  { rank: 10, alias: 'JUICE',    carMatch: 'Civic.*EK|Civic.*Type R|Civic.*SiR|Civic',   carLabel: 'Honda Civic',      venue: 'drag', gate: { wins: 3,  rep: 10 }, gender: 'M', fitness: 50,
    taunts: ["You think you're gonna beat my {rivalCar} with that {playerCar}?", 'Pull up to the strip. Bring lunch money.'] },
  { rank: 9,  alias: 'PENNY',    carMatch: 'Eunos Roadster|MX-5|Miata',                  carLabel: 'Mazda Roadster',   venue: 'oval', gate: { wins: 4,  rep: 18 }, gender: 'F', fitness: 55,
    taunts: ['Corners matter, hotshot. Meet me at the oval.', 'That {playerCar} push wide in turn one? Thought so.'] },
  { rank: 8,  alias: 'DEACON',   carMatch: '240SX|SILEIGHTY|Silvia.*S13|Silvia.*S14|Silvia', carLabel: 'Nissan Silvia', venue: 'city', gate: { wins: 5,  rep: 25 }, gender: 'M', fitness: 30,
    taunts: ['These streets got a toll, and you ain’t paid it.', 'Bring that {playerCar}. I need a good laugh.'] },
  { rank: 7,  alias: 'KAZE',     carMatch: 'RX-7.*FC|Savanna|RX-7',                      carLabel: 'Mazda RX-7 FC',    venue: 'drag', gate: { wins: 7,  rep: 33 }, gender: 'M', fitness: 85,
    taunts: ['Rotary sings, piston begs. Listen close.', 'Your {playerCar} against my {rivalCar}? Short race.'] },
  { rank: 6,  alias: 'BIG SAL',  carMatch: 'Cuda|Barracuda|Charger|Super Bee',           carLabel: 'Plymouth Cuda',    venue: 'drag', gate: { wins: 9,  rep: 41 }, gender: 'M', fitness: 12,
    taunts: ['Eight cylinders of American arithmetic, kid.', 'That import of yours got a spare bumper? It’ll need one.'] },
  { rank: 5,  alias: 'WRENCH',   carMatch: 'Impreza.*22B|Impreza.*STi|Impreza.*WRX|Impreza', carLabel: 'Subaru Impreza', venue: 'city', gate: { wins: 11, rep: 50 }, gender: 'F', fitness: 82,
    taunts: ['I built mine. Who built yours?', 'Four driven wheels beat your {playerCar} in the wet AND the dry.'] },
  { rank: 4,  alias: 'DUCHESS',  carMatch: 'S2000',                                      carLabel: 'Honda S2000',      venue: 'oval', gate: { wins: 13, rep: 58 }, gender: 'F', fitness: 60,
    taunts: ['Nine thousand RPM of goodbye.', 'Keep your {playerCar} off my racing line.'] },
  { rank: 3,  alias: 'PREACHER', carMatch: 'Supra RZ|Supra.*Twin|Supra',                 carLabel: 'Toyota Supra',     venue: 'city', gate: { wins: 15, rep: 66 }, gender: 'M', fitness: 45,
    taunts: ['Everybody wants a sermon. Nobody wants the collection plate.', 'Boost is a faith, and your {playerCar} is an unbeliever.'] },
  { rank: 2,  alias: 'GHOST',    carMatch: 'GT-R.*R34|Skyline.*R34|GT-R',                carLabel: 'Nissan GT-R R34',  venue: 'city', gate: { wins: 18, rep: 75 }, gender: 'M', fitness: 70,
    taunts: ['You won’t see me. That’s the point.', 'ATTESA does the math your right foot can’t.'] },
  { rank: 1,  alias: 'CALLAHAN', carMatch: 'CTR2|RUF.*CTR|RUF.*BTR|911',                 carLabel: 'RUF CTR2',         venue: 'city', gate: { wins: 20, rep: 85 }, gender: 'M', fitness: 40,
    taunts: ['Every name above yours earned it. Every name below yours quit.', 'Charlotte has one king. You’re looking at him.'] },
];

const _carCache = new Map<number, CatalogCar | null>();

/** Resolve a rival's signature car from the runtime catalog. The
 *  carMatch alternatives (split on '|') are tried IN ORDER against
 *  the whole catalog — 'CTR2|911' means "the CTR2 if the catalog has
 *  one, else any 911", not "whichever appears first in catalog
 *  order". Cached; ids are runtime-generated so name matching is the
 *  stable key. Null when every pattern misses — callers fall back to
 *  rival.carLabel. */
export function resolveRivalCar(rival: BlacklistRival): CatalogCar | null {
  if (_carCache.has(rival.rank)) return _carCache.get(rival.rank) ?? null;
  let found: CatalogCar | null = null;
  const cars = Object.values(CAR_CATALOG);
  for (const pat of rival.carMatch.split('|')) {
    const re = new RegExp(pat, 'i');
    for (const c of cars) {
      if (!c.isBike && re.test(c.name)) { found = c; break; }
    }
    if (found) break;
  }
  _carCache.set(rival.rank, found);
  return found;
}

/** Progression state stored on life.blacklist (wholesale save blob;
 *  defaults filled by ensureBlacklistState). */
export interface BlacklistState {
  defeated: number[];
  attempts: Record<number, number>;
  pinkSlipsWon: string[];
}

export function ensureBlacklistState(life: { blacklist?: BlacklistState }): BlacklistState {
  if (!life.blacklist || !Array.isArray(life.blacklist.defeated)) {
    life.blacklist = { defeated: [], attempts: {}, pinkSlipsWon: [] };
  }
  return life.blacklist;
}

/** Gate check: a rival is challengeable when every rank below them is
 *  beaten AND the wins/rep gate clears. Returns the display status. */
export function rivalStatus(
  rival: BlacklistRival,
  life: { streetRep?: number; streetRacesWon?: number; blacklist?: BlacklistState },
): 'beaten' | 'open' | 'locked' {
  const bl = life.blacklist;
  if (bl?.defeated?.includes(rival.rank)) return 'beaten';
  const wins = life.streetRacesWon ?? 0;
  const rep = life.streetRep ?? 0;
  const lowerBeaten = BLACKLIST_RIVALS
    .filter((r) => r.rank > rival.rank)
    .every((r) => bl?.defeated?.includes(r.rank));
  if (lowerBeaten && wins >= rival.gate.wins && rep >= rival.gate.rep) return 'open';
  return 'locked';
}

/** Fill taunt slots from the player's actual car — including the
 *  manual-transmission jab, which only renders when the player's car
 *  really is an automatic (the design-doc rule). */
export function tauntFor(
  rival: BlacklistRival,
  playerCar: CatalogCar | undefined,
  playerIsManual: boolean,
): string {
  const line = rival.taunts[Math.floor(Math.random() * rival.taunts.length)] ?? '';
  const rivalCarName = resolveRivalCar(rival)?.name ?? rival.carLabel;
  let out = line
    .replace('{playerCar}', playerCar?.name ?? 'that thing')
    .replace('{rivalCar}', rivalCarName);
  if (playerCar && !playerIsManual && line.includes('{playerCar}')) {
    out += ' Does it even have a manual transmission?';
  }
  return out;
}
