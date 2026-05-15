/**
 * Car sprite loader + lookup. Maps GT4_DB car names to PNGs already
 * present in public/cars/, lazy-loads them on first request, and
 * caches HTMLImageElements for reuse.
 *
 * Sprite orientation convention (matches monolith L41190):
 *   "pre-oriented to front=+X"
 * → no rotation offset needed; ctx.rotate(player.pAngle) aligns the
 *   image to the player's heading.
 *
 * For cars without a matching sprite, the caller falls back to the
 * H26 silhouette colored from CAR_CATALOG.color. The matcher
 * intentionally returns null for unknowns rather than picking a
 * "close" sprite — a wrong-make sprite would read worse than a
 * neutral silhouette.
 */

/** Public path Vite serves /cars/ from. */
const SPRITE_BASE = '/cars/';

/** Map a car name → filename in /cars/, or null when no match. The
 *  regex set is hand-tuned for the ~20 available sprites; broaden
 *  these as more PNGs land in public/cars/. */
export function findSpriteForCarName(name: string): string | null {
  if (!name) return null;

  // Hondas
  if (/Honda\s+CIVIC/i.test(name)) return 'Honda-Civic-Blue.png';
  if (/Honda\s+Accord/i.test(name)) return 'Honda-Accord-Heather.png';

  // Mazdas
  if (/Mazda\s+RX[-\s]?7\b.*FD/i.test(name)) return 'RX7FD-Up-Grey.png';
  if (/Mazda\s+RX[-\s]?7/i.test(name)) return 'Mazda-RX7-FC-Red.png';
  if (/Mazda.*Miata.*Black/i.test(name)) return 'Mazda-Miata-NA-Black.png';
  if (/Mazda.*Miata|Miata.*NA/i.test(name)) return 'Mazda-Miata-NA-Red.png';

  // Nissans
  if (/Skyline.*R34.*V[- ]Spec/i.test(name)) return 'Nissan-Skyline-R34-VSpec-Blue (1).png';
  if (/Skyline.*R3[34]/i.test(name)) return 'Nissan-Skyline-R34-Blue.png';
  if (/Nissan.*180SX|180via|Silvia.*S13/i.test(name)) return 'Nissan-180via-Yellow.png';
  if (/Silvia/i.test(name)) return 'Nissan-Silvia-Coupe.png';

  // Acura / Honda imports
  if (/Acura\s+NSX|NSX\b/i.test(name)) return 'Acura-NSX-Red.png';

  // Toyotas
  if (/Toyota.*AE86|Corolla.*GT|AE86\b/i.test(name)) return 'Toyota-Corolla-AE86-White.png';

  // Mopars
  if (/Dodge.*Viper/i.test(name)) return 'Dodge-Viper-Blue.png';
  if (/Dodge.*SuperBee|Super\s*Bee/i.test(name)) return 'Dodge-SuperBee-Green.png';
  if (/Dodge.*Charger/i.test(name)) return 'Dodge-Charger-Orange.png';
  if (/Plymouth.*Barracuda|'Cuda/i.test(name)) return 'Plymouth-Barracuda-Orange.png';

  // RUF / Porsche-derived
  if (/RUF.*CTR\s*2|CTR2/i.test(name)) return 'RUF CTR2.png';
  if (/RUF.*CTR|Yellowbird/i.test(name)) return 'RUF CTR-Yellowbird.png';
  if (/RUF.*BTR/i.test(name)) return 'RUF BTR-86-Blue.png';

  // Audi
  if (/Audi.*Quattro|Quattro.*82/i.test(name)) return 'Audi-Quattro-82-White.png';

  // Generic Ford / sedan
  if (/Ford.*Taurus|Taurus/i.test(name)) return 'Ford-Taurus-Brown.png';
  if (/Ford.*Crown[-\s]?Vic.*Police|Crown[-\s]?Victoria.*Police/i.test(name)) return 'Ford-Crown-Vic-CMPD.png';
  if (/Ford.*Crown[-\s]?Vic/i.test(name)) return 'Ford-Crown-Vic-ST.png';
  if (/Ford.*Ambulance|Ambulance/i.test(name)) return 'Ford-Ambulance.png';

  // Dodge utility / trucks
  if (/Dodge.*Caravan|Caravan/i.test(name)) return 'Dodge-Caravan-Green.png';
  if (/Dodge.*Ram|Ram\s+\d/i.test(name)) return 'Dodge-Ram-White.png';

  // Trucks / commercial
  if (/Peterbilt|Semi/i.test(name)) return 'Peterbilt-379-Red.png';
  if (/Freightliner|Box[-\s]?Truck/i.test(name)) return 'Freightliner-Van.png';
  if (/Tow[-\s]?Truck/i.test(name)) return 'Tow Truck-White.png';

  // Bikes (motorcycles)
  if (/Suzuki.*Katana|Katana/i.test(name)) return 'Katana-Red.png';
  if (/Kawasaki.*Ninja|Ninja/i.test(name)) return 'Ninja-Green.png';
  if (/Honda.*CB500|CB500/i.test(name)) return 'CB500-Red.png';
  if (/Smokey|Bandit/i.test(name)) return 'Bandit-Blue.png';

  return null;
}

/** Image cache keyed by filename. Each entry is created on first
 *  request; the browser populates .complete asynchronously. */
const SPRITE_CACHE = new Map<string, HTMLImageElement>();

/** Returns a cached or freshly-allocated Image for the given filename.
 *  Caller checks `.complete && .naturalWidth > 0` before drawing —
 *  the H26 silhouette is the visual fallback during load. */
export function getCarSprite(filename: string): HTMLImageElement {
  const cached = SPRITE_CACHE.get(filename);
  if (cached) return cached;
  const img = new Image();
  // URL-encode the filename to handle spaces ("Tow Truck-White.png").
  img.src = SPRITE_BASE + encodeURIComponent(filename);
  SPRITE_CACHE.set(filename, img);
  return img;
}

/** Convenience: name → ready-or-loading Image, or null if no match. */
export function spriteForCarName(name: string | undefined): HTMLImageElement | null {
  if (!name) return null;
  const filename = findSpriteForCarName(name);
  if (!filename) return null;
  return getCarSprite(filename);
}
