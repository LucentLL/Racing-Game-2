/**
 * getCarGeneration — maps a catalog car NAME to a per-chassis generation key
 * used to dispatch into the GEN_DATA per-gen sprite registry (populated in
 * C19b). Returns null when no V2 chassis-specific renderer is registered;
 * the caller then falls back to the legacy bodyType silhouette path.
 *
 * Ported from monolith L36662–36790. The regex chain is mostly
 * catalog-name specific (matches the chassis tag in parens — e.g.
 * `(FD)`, `(R34)`, `(AE86)`), with year-fallback branches for cars that
 * don't carry a chassis tag.
 */

export function getCarGeneration(name: string | null | undefined): string | null {
  if (!name) return null;
  const n = name;
  const yrM = n.match(/`(\d{2})\b/);
  const yr = yrM ? parseInt(yrM[1], 10) : null;
  const is2000s = yr !== null && yr < 50;

  // ---- Mazda RX-7 -------------------------------------------------------
  if (/RX-7.*\(FD\)|RX-7.*Type R|RX-7.*Spirit R|RX-7.*Efini|RX-7.*RZ|RX-7.*RB|RX-7.*FD3S/i.test(n)) return 'rx7_fd';
  if (/RX-7.*\(FC\)|RX-7.*GT-X|RX-7.*GTU|RX-7.*FC3S/i.test(n)) return 'rx7_fc';
  if (n.includes('RX-7') && yr !== null) {
    if (is2000s || yr >= 92) return 'rx7_fd';
    return 'rx7_fc';
  }

  // ---- Rally cars -------------------------------------------------------
  if (/Ford\s+FOCUS\s+Rally/i.test(n)) return 'focus_wrc';
  if (/Subaru\s+IMPREZA\s+Rally/i.test(n)) return 'impreza_gc8';
  if (/Lancer\s+Evolution\s+VI.*Rally/i.test(n)) return 'evo6_rally';

  // ---- Toyota Supra -----------------------------------------------------
  if (/Supra\s+(RZ|SZ|SZ-R|GZ|Turbo)/i.test(n) && (yr === null || is2000s || yr >= 93)) return 'supra_a80';
  if (/Supra.*A80|Supra.*MK ?IV/i.test(n)) return 'supra_a80';
  if (/Supra.*(2\.5GT|3\.0GT|Turbo A|A70|MK ?III)/i.test(n)) return 'supra_a70';
  if (n.includes('Supra') && yr !== null) {
    if (is2000s || yr >= 93) return 'supra_a80';
    return 'supra_a70';
  }

  // ---- Nissan Skyline GT-R ---------------------------------------------
  // V-spec / R-tune / NISMO R-tune share the V-spec aero kit. Order
  // matters — the V-spec check has to fire before the catch-all R34.
  if (/Skyline.*V-spec.*\(R34\)|Skyline.*R-tune.*\(R34\)|NISMO.*R-tune.*\(R34\)/i.test(n)) return 'gtr_r34_vspec';
  if (/Skyline.*\(R34\)|BNR34/i.test(n)) return 'gtr_r34';

  // ---- Honda / Acura NSX ------------------------------------------------
  if (/\bNSX\b/i.test(n)) return 'nsx_na';

  // ---- Mazda Miata ------------------------------------------------------
  // NA chassis only — NB has fixed headlights, different body lines.
  if (/Miata.*\(NA/i.test(n)) return 'miata_na';

  // ---- Nissan 180SX / Sileighty (S13 hatchback) ------------------------
  if (/180SX|Sileighty|Sil[\-\s]?Eighty/i.test(n)) return 'silvia_180sx';

  // ---- Older Skyline GT-Rs ---------------------------------------------
  if (/Skyline.*\(R33\)|BCNR33/i.test(n)) return 'gtr_r33';
  if (/Skyline.*\(R32\)|BNR32/i.test(n)) return 'gtr_r32';

  // ---- Honda Civic chassis ---------------------------------------------
  if (/Civic.*\(EK\)|Civic.*Type\s*R|Gathers.*CIVIC/i.test(n)) return 'civic_ek';
  if (/Civic.*\(EG\)|Civic.*SiR-II/i.test(n)) return 'civic_eg';

  // ---- Toyota Corolla AE86 ---------------------------------------------
  if (/\(AE86\)|AE86\b/i.test(n)) return 'ae86';

  // ---- Older Civics ----------------------------------------------------
  if (/Civic\s+1500.*25i/i.test(n)) return 'civic_3gen';
  if (/Civic\s+1500.*CX/i.test(n)) return 'civic_2gen';

  // ---- Dodge Viper -----------------------------------------------------
  if (/Viper/i.test(n)) return 'dodge_viper';

  // ---- Plymouth Cuda / Barracuda --------------------------------------
  if (/(?:^|\s)Cuda|Barracuda/i.test(n)) return 'plymouth_cuda';

  // ---- Super Bee MUST come before Charger so the Super Bee row (which
  //      mentions "Charger" in its catalog name) doesn't get captured by
  //      the dodge_charger fallthrough.
  if (/Super\s*Bee/i.test(n)) return 'dodge_super_bee';
  if (/Charger/i.test(n)) return 'dodge_charger';

  // ---- Audi quattro (Ur-Quattro, B2) ----------------------------------
  if (/Audi\s+quattro/i.test(n)) return 'audi_quattro';

  // ---- RUF (CTR2 must precede BTR; Yellow Bird precedes generic CTR) --
  if (/^RUF\s+CTR2\b/i.test(n)) return 'ruf_ctr2';
  if (/Yellow\s*Bird/i.test(n)) return 'ruf_ctr_yb';
  if (/^RUF\s+BTR\b/i.test(n)) return 'ruf_btr';

  return null;
}
