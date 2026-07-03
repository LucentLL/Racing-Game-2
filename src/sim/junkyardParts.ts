/**
 * H1002: junkyard used-parts salvage.
 *
 * A junkyard visit exposes a rolled inventory of pullable donor parts. Each
 * part targets one of the car's condition stats (engine / tires / body) and
 * carries a QUALITY of 0..90% — the condition the part installs to. Because
 * a used part can't beat its own condition, installing SETS the stat toward
 * the part's quality (never downgrades): junkyard parts cap you at 90%, the
 * dealer/shop parts are what get you to 100%.
 *
 * Pulling a part needs the right TOOL. The player's garage toolbox
 * (life.toolbox, ensureToolbox) is their brought-tools; if it lacks the
 * needed category they can RENT a tool kit for the visit (flat fee, no
 * haggling). The starter kit covers wrench/socket/power (so body + engine
 * pulls are free) but NOT the 'tire' category (a tire machine), so tire
 * pulls require renting — exercising both paths.
 *
 * All state is transient on the opaque LIFE blob (life._junkyardParts /
 * _junkyardRented / _junkyardTab) — no save-schema change.
 */
import type { LifeState } from '@/state/life';
import type { ToolItem } from '@/state/life';
import { CAR_CATALOG } from '@/config/cars/catalog';

/** Condition stat a junkyard part restores. Maps to life.engine / tires /
 *  carHP (the '"hp" = body' condition). Paint isn't salvageable. */
export type JunkStat = 'engine' | 'tires' | 'hp';

export interface JunkyardPart {
  id: string;
  name: string;
  stat: JunkStat;
  /** 0..90 — the condition (%) this used part installs the stat TO. */
  quality: number;
  /** Fixed asking price (no haggling). */
  price: number;
  /** Tool CATEGORY needed to pull it (checked against life.toolbox). */
  toolReq: ToolItem['category'];
  /** Display name of the required tool. */
  toolName: string;
}

interface PartTemplate {
  name: string;
  stat: JunkStat;
  /** Base $ for a mint (100%) example — price scales down with quality. */
  base: number;
  toolReq: ToolItem['category'];
  toolName: string;
  weight: number;
}

/** Donor-part pool. Body panels are common (cheap, hand tools); engines are
 *  rare (dear, need a hoist); tires need a tire machine (rent). */
const PART_POOL: readonly PartTemplate[] = [
  { name: 'Front Bumper',       stat: 'hp',     base: 260,  toolReq: 'wrench', toolName: 'hand tools',   weight: 3 },
  { name: 'Fender',             stat: 'hp',     base: 220,  toolReq: 'wrench', toolName: 'hand tools',   weight: 3 },
  { name: 'Hood',               stat: 'hp',     base: 300,  toolReq: 'wrench', toolName: 'hand tools',   weight: 2 },
  { name: 'Door',               stat: 'hp',     base: 340,  toolReq: 'socket', toolName: 'hand tools',   weight: 2 },
  { name: 'Headlight Assembly', stat: 'hp',     base: 180,  toolReq: 'wrench', toolName: 'hand tools',   weight: 3 },
  { name: 'Salvaged Tire Set',  stat: 'tires',  base: 380,  toolReq: 'tire',   toolName: 'tire machine', weight: 3 },
  { name: 'Used Engine',        stat: 'engine', base: 950,  toolReq: 'power',  toolName: 'engine hoist', weight: 2 },
  { name: 'Used Transmission',  stat: 'engine', base: 700,  toolReq: 'power',  toolName: 'engine hoist', weight: 1 },
  { name: 'Alternator',         stat: 'engine', base: 220,  toolReq: 'socket', toolName: 'hand tools',   weight: 2 },
  { name: 'Radiator',           stat: 'engine', base: 260,  toolReq: 'wrench', toolName: 'hand tools',   weight: 2 },
];

/** Quality at/below this reads as "unusable" — the part is scrap and can't
 *  be pulled (it crumbles / is rusted through). */
export const JUNK_UNUSABLE_MAX = 12;

/** Roll a fresh junkyard inventory. Mirrors generateCarLot: non-seeded
 *  Math.random, fixed-ish size, one row per pick. `day` is accepted for
 *  parity/future seeding (unused today). */
export function generateJunkyardParts(_day = 0): JunkyardPart[] {
  const n = 5 + Math.floor(Math.random() * 3); // 5..7
  // Weighted shuffle: expand by weight, shuffle, take unique-ish picks.
  const bag: PartTemplate[] = [];
  for (const t of PART_POOL) for (let i = 0; i < t.weight; i++) bag.push(t);
  for (let i = bag.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = bag[i]; bag[i] = bag[j]; bag[j] = tmp;
  }
  const out: JunkyardPart[] = [];
  const seen = new Set<string>();
  for (const t of bag) {
    if (out.length >= n) break;
    // Allow at most 2 of the same template so a lot isn't 6 bumpers.
    const cnt = out.filter((p) => p.name === t.name).length;
    if (cnt >= 2) continue;
    const quality = Math.floor(Math.random() * 91); // 0..90 inclusive
    // Price: junkyard-cheap, scales with quality. Unusable parts are ~free.
    const price = Math.max(5, Math.round(t.base * (quality / 100) * 0.5));
    const id = 'jy_' + t.name.replace(/\s+/g, '_').toLowerCase() + '_' + out.length;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name: t.name, stat: t.stat, quality, price, toolReq: t.toolReq, toolName: t.toolName });
  }
  return out;
}

/** The player's brought tools cover this category (from the garage toolbox). */
export function hasToolCategory(toolbox: ToolItem[], cat: ToolItem['category']): boolean {
  return toolbox.some((t) => t.category === cat && (t.qty ?? 1) > 0);
}

/** Flat per-visit tool-kit rental fee (covers any missing category). */
export const TOOL_RENTAL_FEE = 60;

/** Current condition of the active car's stat that a junk part targets. */
export function activeStatValue(life: LifeState, stat: JunkStat): number {
  if (stat === 'engine') return life.engine ?? 0;
  if (stat === 'tires') return life.tires ?? 0;
  return life.carHP ?? 0; // 'hp' = body
}

/** Install a pulled part on the ACTIVE car: SET the stat toward the part's
 *  quality (never downgrade), clamped 0..100. Returns the delta applied. */
export function installJunkPart(life: LifeState, part: JunkyardPart): number {
  const cur = activeStatValue(life, part.stat);
  const target = Math.max(0, Math.min(100, Math.max(cur, part.quality)));
  const delta = target - cur;
  if (part.stat === 'engine') life.engine = target;
  else if (part.stat === 'tires') life.tires = target;
  else life.carHP = target;
  return delta;
}

/** Label for the active car (for the header). */
export function activeCarName(life: LifeState): string {
  const id = life.ownedCars[0];
  return id && CAR_CATALOG[id] ? CAR_CATALOG[id].name : '— no car —';
}
