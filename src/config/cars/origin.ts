/**
 * Car-origin classifier — derives a brand-region tag from the catalog
 * name string. Consumed by:
 *   - The pause-menu STATUS tab (origin flag/label chrome at monolith
 *     L34634 — "🇯🇵 JPN" / "🇺🇸 USA" / "🇪🇺 EUR")
 *   - [[diagnoseFault]] / FAULT_POOLS: picks which regional wear-fault
 *     pool to roll from. FAULT_POOLS only carries entries for jpn /
 *     usa / eur; the four sub-European tags (ita/fra/ger/gbr) fall
 *     through to FAULT_POOLS.jpn at lookup time via the
 *     `FAULT_POOLS[origin]||FAULT_POOLS.jpn` default in the diagnose
 *     path (preserved by [[diagnoseFault]] via the `origin in FAULT_POOLS`
 *     runtime check). This monolith quirk is intentional — sub-European
 *     brands don't get their own pool and silently inherit jpn's clean
 *     wear-item set.
 *   - The seller-visit / used-car flow at monolith L43322 (USED_FAULTS
 *     pool selection, same fallback semantics).
 *
 * H534: 1:1 port of monolith inline classifier at L7562 — same brand
 * lists, same precedence (jpn first, then usa, then italian, french,
 * german, british, then ambulance/truck → usa override, then 'eur'
 * default). Tested against every CARS catalog entry by walking
 * GT4_DB at module init in catalog.ts.
 */

/** All possible origin tags the classifier can return. Wider than
 *  [[CarOrigin]] in faultPools.ts (which only covers the three regional
 *  pools — jpn/usa/eur). The sub-European tags are surfaced verbatim
 *  so downstream chrome (origin badges, future per-country pricing)
 *  can read them; the wear-fault path collapses them to jpn at
 *  runtime via its existing fallback. */
export type CatalogCarOrigin = 'jpn' | 'usa' | 'ita' | 'fra' | 'ger' | 'gbr' | 'eur';

/** Brand patterns for each origin, in monolith L7562 evaluation
 *  order. The first matching pattern wins; the special
 *  ambulance/truck check at the bottom forces 'usa' even when the
 *  name doesn't contain a recognized American brand (matches the
 *  monolith's `if(/ambulance|truck/.test(n))return'usa'` rider). */
const ORIGIN_PATTERNS: ReadonlyArray<{ tag: CatalogCarOrigin; re: RegExp }> = [
  { tag: 'jpn', re: /honda|nissan|toyota|mazda|mitsubishi|subaru|kawasaki|suzuki|daihatsu|lexus|infiniti|isuzu|acura/ },
  { tag: 'usa', re: /chevrolet|dodge|ford|plymouth|pontiac|buick|mercury|eagle|shelby|harley/ },
  { tag: 'ita', re: /alfa|lancia|fiat|autobianchi|cizeta/ },
  { tag: 'fra', re: /peugeot|citroen|renault|alpine|hommell/ },
  { tag: 'ger', re: /bmw|mercedes|amg|audi|opel|volkswagen|ruf|sauber/ },
  { tag: 'gbr', re: /aston|tvr|lotus|jaguar|marcos|lister|mgf|ginetta|triumph|jensen|ac cars/ },
];

/** Special-case override: emergency / utility vehicles get tagged
 *  'usa' regardless of brand text, matching the monolith's
 *  ambulance/truck rider at the bottom of the L7562 classifier
 *  ternary chain. */
const USA_VEHICLE_OVERRIDE = /ambulance|truck/;

/** Classify a catalog car name into its origin tag.
 *
 *  Matches monolith L7562 verbatim: lowercases the name, walks the
 *  brand-pattern list in precedence order, then applies the
 *  ambulance/truck override, then falls back to 'eur' as the
 *  default. Case-insensitive by virtue of the toLowerCase at the
 *  top — patterns are written lowercase. */
export function classifyCarOrigin(name: string): CatalogCarOrigin {
  const n = name.toLowerCase();
  for (const { tag, re } of ORIGIN_PATTERNS) {
    if (re.test(n)) return tag;
  }
  if (USA_VEHICLE_OVERRIDE.test(n)) return 'usa';
  return 'eur';
}
