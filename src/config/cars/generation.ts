/**
 * H44 — car name → generation key. Maps a GT4_DB catalog name to the
 * VEHICLE_IMAGE_MANIFEST key for that car's chassis silhouette.
 *
 * Direct port of monolith getCarGeneration L36580-36708. The regex
 * patterns and priority order are preserved exactly so every car in
 * the catalog maps to the same sprite the monolith picks for it.
 *
 * Returns null for catalog entries that have no sprite — the caller
 * then falls back to the silhouette colored from CAR_CATALOG.color.
 *
 * Why a regex chain instead of a lookup table:
 *   - The GT4_DB has ~440 entries but only ~40 distinct chassis
 *     silhouettes; one regex per chassis is ~40 rules vs ~440 table
 *     rows, and the rules survive when the catalog gains new model
 *     years (a new "Civic Type R `00" automatically maps to civic_ek
 *     via the existing pattern).
 *   - Pattern order matters in a few places (Super Bee BEFORE
 *     Charger, V-spec R34 BEFORE base R34, CTR2 BEFORE BTR, etc.) —
 *     comments inline mark every such case.
 */

/** Maps a GT4_DB car name to a manifest key, or null when no
 *  chassis-specific sprite is available. */
export function getCarGeneration(name: string | undefined | null): string | null {
  if (!name) return null;
  const n = name;
  const yrM = n.match(/`(\d{2})\b/);
  const yr = yrM ? parseInt(yrM[1], 10) : null;
  const is2000s = yr !== null && yr < 50; // 00-49 = 2000-2049

  // --- Mazda RX-7 ---
  if (/RX-7.*\(FD\)|RX-7.*Type R|RX-7.*Spirit R|RX-7.*Efini|RX-7.*RZ|RX-7.*RB|RX-7.*FD3S/i.test(n)) return 'rx7_fd';
  if (/RX-7.*\(FC\)|RX-7.*GT-X|RX-7.*GTU|RX-7.*FC3S/i.test(n)) return 'rx7_fc';
  if (n.includes('RX-7') && yr !== null) {
    if (is2000s || yr >= 92) return 'rx7_fd';
    return 'rx7_fc';
  }

  // --- Rally cars ---
  if (/Ford\s+FOCUS\s+Rally/i.test(n)) return 'focus_wrc';
  if (/Subaru\s+IMPREZA\s+Rally/i.test(n)) return 'impreza_gc8';
  if (/Lancer\s+Evolution\s+VI.*Rally/i.test(n)) return 'evo6_rally';

  // --- Toyota Supra ---
  if (/Supra\s+(RZ|SZ|SZ-R|GZ|Turbo)/i.test(n) && (yr === null || is2000s || yr >= 93)) return 'supra_a80';
  if (/Supra.*A80|Supra.*MK ?IV/i.test(n)) return 'supra_a80';
  if (/Supra.*(2\.5GT|3\.0GT|Turbo A|A70|MK ?III)/i.test(n)) return 'supra_a70';
  if (n.includes('Supra') && yr !== null) {
    if (is2000s || yr >= 93) return 'supra_a80';
    return 'supra_a70';
  }

  // --- Nissan Skyline GT-R ---
  // Order matters: V-spec checks must come before the catch-all R34.
  if (/Skyline.*V-spec.*\(R34\)|Skyline.*R-tune.*\(R34\)|NISMO.*R-tune.*\(R34\)/i.test(n)) return 'gtr_r34_vspec';
  if (/Skyline.*\(R34\)|BNR34/i.test(n)) return 'gtr_r34';

  // --- Honda / Acura NSX ---
  if (/\bNSX\b/i.test(n)) return 'nsx_na';

  // --- Mazda Miata NA ---
  if (/Miata.*\(NA/i.test(n)) return 'miata_na';

  // --- Nissan 180SX / Sileighty ---
  if (/180SX|Sileighty|Sil[\-\s]?Eighty/i.test(n)) return 'silvia_180sx';

  // --- Nissan Silvia (S13) coupes ---
  if (/Silvia/i.test(n)) return 'silvia';

  // --- Skyline R32 / R33 ---
  if (/Skyline.*\(R33\)|BCNR33/i.test(n)) return 'gtr_r33';
  if (/Skyline.*\(R32\)|BNR32/i.test(n)) return 'gtr_r32';

  // --- Honda Civic gens ---
  if (/Civic.*\(EK\)|Civic.*Type\s*R|Gathers.*CIVIC/i.test(n)) return 'civic_ek';
  if (/Civic.*\(EG\)|Civic.*SiR-II/i.test(n)) return 'civic_eg';
  if (/Civic\s+1500.*25i/i.test(n)) return 'civic_3gen';
  if (/Civic\s+1500.*CX/i.test(n)) return 'civic_2gen';

  // --- Toyota Corolla AE86 ---
  if (/\(AE86\)|AE86\b/i.test(n)) return 'ae86';

  // --- Dodge Viper ---
  if (/Viper/i.test(n)) return 'dodge_viper';

  // --- Plymouth Cuda / Barracuda ---
  if (/(?:^|\s)Cuda|Barracuda/i.test(n)) return 'plymouth_cuda';

  // --- Dodge Super Bee — MUST come before Charger catch-all ---
  if (/Super\s*Bee/i.test(n)) return 'dodge_super_bee';

  // --- Dodge Charger ---
  if (/Charger/i.test(n)) return 'dodge_charger';

  // --- Audi quattro (Ur-Quattro) ---
  if (/Audi\s+quattro/i.test(n)) return 'audi_quattro';

  // --- RUF — CTR2 BEFORE BTR (CTR2 is more specific) ---
  if (/^RUF\s+CTR2\b/i.test(n)) return 'ruf_ctr2';
  if (/Yellow\s*Bird/i.test(n)) return 'ruf_ctr_yb';
  if (/^RUF\s+BTR\b/i.test(n)) return 'ruf_btr';

  // --- Bikes (Kawasaki Ninja, Honda CB500, Suzuki Bandit/Katana) ---
  if (/Kawasaki.*Ninja|Ninja/i.test(n)) return 'kawasaki_ninja';
  if (/Honda.*CB500|CB500/i.test(n)) return 'honda_cb500';
  if (/Suzuki.*Bandit|Bandit/i.test(n)) return 'suzuki_bandit';
  if (/Suzuki.*Katana|Katana/i.test(n)) return 'suzuki_katana';

  // --- Service vehicles ---
  if (/Crown[-\s]?Vic.*Police|Crown[-\s]?Victoria.*Police/i.test(n)) return 'cruiser';
  if (/Crown[-\s]?Vic|Crown[-\s]?Victoria/i.test(n)) return 'cruiser';
  if (/Tow[-\s]?Truck/i.test(n)) return 'towtruck';
  if (/Peterbilt|Semi[-\s]?Truck|Semi\b/i.test(n)) return 'semi_truck';
  if (/Freightliner|Box[-\s]?Truck/i.test(n)) return 'box_truck';
  if (/Ambulance/i.test(n)) return 'ambulance';

  // --- 1999 Hondas (default daily-driver sedans) ---
  if (/Honda\s+CIVIC/i.test(n)) return 'civic99';
  if (/Honda\s+Accord/i.test(n)) return 'accord99';

  // --- Generic body types ---
  if (/Ford.*Taurus|Taurus/i.test(n)) return 'sedan';
  if (/Dodge.*Caravan|Caravan/i.test(n)) return 'hatch';
  if (/Dodge.*Ram|Ram\s+\d/i.test(n)) return 'pickup';

  return null;
}
