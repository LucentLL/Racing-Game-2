/**
 * Per-category mechanical skill model (H938).
 *
 * User design: mechanical skill is not one number — it's SIX category
 * sub-skills (engine / transmission / suspension / brakes / electronics /
 * body), each on five 20-point TIER bands (1-20 Novice … 81-100 Master).
 * You raise a category by working IN it; each category owns a ladder of
 * tasks from light maintenance up to major upgrades (wired in a later
 * slice — see [[repair-economy]] CATEGORY_TASKS plan).
 *
 * This module is the data foundation: the category list, the tier bands,
 * the fault→category mapping, and the per-category skill store on LifeState
 * (`life.catSkill`). It is BACK-COMPAT: existing saves carry their single
 * `mechSkill` value as the seed for every category, which then diverge as
 * the player specializes. The legacy scalar `mechSkill` is still kept in
 * sync (it remains the DIY gate until a later slice migrates the gate to
 * per-category), so nothing that reads `mechSkill` breaks.
 */

import type { LifeState } from '@/state/life';

export type MechCategory =
  | 'engine' | 'transmission' | 'suspension' | 'brakes' | 'electronics' | 'body';

export const MECH_CATEGORIES: readonly MechCategory[] = [
  'engine', 'transmission', 'suspension', 'brakes', 'electronics', 'body',
];

/** Display chrome per category — full label, 3-letter chip, accent color. */
export const CATEGORY_META: Record<MechCategory, { label: string; abbr: string; color: string }> = {
  engine:       { label: 'Engine',       abbr: 'ENG', color: '#ff6a4d' },
  transmission: { label: 'Transmission', abbr: 'TRN', color: '#ffd24d' },
  suspension:   { label: 'Suspension',   abbr: 'SUS', color: '#7dd3fc' },
  brakes:       { label: 'Brakes',       abbr: 'BRK', color: '#fb7185' },
  electronics:  { label: 'Electronics',  abbr: 'ELE', color: '#a78bfa' },
  body:         { label: 'Body',         abbr: 'BDY', color: '#86efac' },
};

/** Five 20-point tiers (user: "1-20, 21-40, … 81-100"). */
export interface SkillTier { min: number; max: number; label: string }
export const SKILL_TIERS: readonly SkillTier[] = [
  { min: 0,  max: 20,  label: 'Novice' },
  { min: 21, max: 40,  label: 'Apprentice' },
  { min: 41, max: 60,  label: 'Competent' },
  { min: 61, max: 80,  label: 'Skilled' },
  { min: 81, max: 100, label: 'Master' },
];
export function skillTier(v: number): SkillTier {
  for (const t of SKILL_TIERS) if (v <= t.max) return t;
  return SKILL_TIERS[SKILL_TIERS.length - 1];
}
export function tierLabel(v: number): string { return skillTier(v).label; }

/** Which category's skill a fault trains. Body covers paint / structural
 *  (carHP) / collision-zone faults; the rest map by fault id keyword,
 *  defaulting to engine (the largest pool). */
export function categoryForFault(
  f: { id?: string; stat?: string; type?: string; zone?: string },
): MechCategory {
  // Collision-zone / body-typed faults are unambiguous body work.
  if (f.zone || f.type === 'body') return 'body';
  const id = (f.id || '').toLowerCase();
  // Keyword routing — id wins over the coarse condition stat (e.g. an
  // 'electrical_gremlin' uses the carHP stat but is electronics, not body),
  // so electronics is tested before the body keywords. Underscore is a word
  // char, so these are bare substrings (no \b — it wouldn't match
  // 'air_susp_leak').
  if (/trans|gear|clutch|torque|rear_seal|different|driveline|axle/.test(id)) return 'transmission';
  if (/brake|rotor|caliper|\bpad/.test(id)) return 'brakes';
  // (o2_sensor / cam_sensor stay ENGINE — engine-management work; only
  // 'electrical_*' sensors route here via the 'electr' keyword.)
  if (/electr|gremlin|battery|wiring|harness|ecu|alternator|fuse|relay|starter/.test(id)) return 'electronics';
  if (/strut|align|ball_joint|control_arm|bushing|susp|shock|spring|ps_leak|tie_rod|steering|sway/.test(id)) return 'suspension';
  if (/frame|rust|trim|dent|fender|bumper|panel|body|scratch|paint|quarter|hood|trunk|door|light/.test(id) || f.stat === 'paint') return 'body';
  return 'engine';
}

/** Lazily ensure life.catSkill exists, seeded from the legacy scalar
 *  mechSkill so existing saves carry their aptitude into every category
 *  (they diverge as the player specializes). Backfills any category the
 *  schema gained later. Returns the live, fully-populated map. */
export function ensureCatSkill(life: LifeState): Record<MechCategory, number> {
  const seed = Math.max(0, Math.min(100, life.mechSkill ?? 15));
  let cs = life.catSkill as Partial<Record<MechCategory, number>> | undefined;
  if (!cs) {
    cs = {};
    life.catSkill = cs as Record<string, number>;
  }
  for (const c of MECH_CATEGORIES) {
    if (typeof cs[c] !== 'number') cs[c] = seed;
  }
  return cs as Record<MechCategory, number>;
}

export function getCatSkill(life: LifeState, cat: MechCategory): number {
  return ensureCatSkill(life)[cat] ?? 0;
}

/** Add `gain` points to a category (clamped 0..100). Also lifts the legacy
 *  overall mechSkill to the best category so existing skill-gated checks
 *  keep working while the per-category model takes over. Returns the new
 *  category value. */
export function trainCategory(life: LifeState, cat: MechCategory, gain: number): number {
  const cs = ensureCatSkill(life);
  cs[cat] = Math.max(0, Math.min(100, (cs[cat] ?? 0) + Math.max(0, gain)));
  let best = 0;
  for (const c of MECH_CATEGORIES) best = Math.max(best, cs[c] ?? 0);
  life.mechSkill = Math.max(life.mechSkill ?? 0, best);
  return cs[cat];
}
