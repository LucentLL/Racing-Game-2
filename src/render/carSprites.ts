/**
 * Car sprite loader + lookup. H44 routes via the full
 * VEHICLE_IMAGE_MANIFEST: GT4_DB name → getCarGeneration → manifest
 * key → filename, matching how the monolith picks sprites.
 *
 * Sprite orientation convention (matches monolith L41190):
 *   "pre-oriented to front=+X"
 * → no rotation offset; ctx.rotate(player.pAngle) aligns image to
 *   heading.
 *
 * Manifest entry shapes the resolver understands:
 *   string                          — direct filename
 *   { down, up }                    — pop-up headlight cars; H44 uses
 *                                     `down` always. The headlights-up
 *                                     state lands when the headlight
 *                                     timing port arrives.
 *   { variants, anchors }           — multi-paint sprites (Miata,
 *                                     Crown Vic cruiser). H44 picks
 *                                     the variant whose anchor RGB is
 *                                     closest to the car's body color.
 *
 * For cars not in the generation map, the silhouette colored from
 * CAR_CATALOG.color renders as a fallback.
 */

import {
  VEHICLE_IMAGE_BASE,
  VEHICLE_IMAGE_MANIFEST,
  type VehicleSpriteEntry,
} from '@/config/cars/manifest';
import { getCarGeneration } from '@/config/cars/generation';
import { CAR_CATALOG } from '@/config/cars/catalog';

/** Image cache keyed by URL. Browser populates .complete asynchronously. */
const SPRITE_CACHE = new Map<string, HTMLImageElement>();

/** Hex string ("#aabbcc" or "#aabbccdd") → [r,g,b]. */
function hexToRgb(hex: string): [number, number, number] | null {
  if (!hex || hex[0] !== '#') return null;
  const h = hex.length === 4
    ? hex[1] + hex[1] + hex[2] + hex[2] + hex[3] + hex[3]
    : hex.slice(1, 7);
  if (h.length !== 6) return null;
  const v = parseInt(h, 16);
  if (Number.isNaN(v)) return null;
  return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
}

function rgbDistSq(a: [number, number, number], b: [number, number, number]): number {
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return dr * dr + dg * dg + db * db;
}

/** Pick the variant whose anchor color is closest to the car's body
 *  color. Used for entries like Miata (red vs black) and Crown Vic
 *  (ST vs CMPD). Returns the variant's filename. */
function pickVariantFilename(
  entry: { variants: Record<string, string>; anchors: Record<string, string> },
  carColor: string,
): string | null {
  const carRgb = hexToRgb(carColor);
  const variantKeys = Object.keys(entry.variants);
  if (variantKeys.length === 0) return null;
  if (!carRgb) return entry.variants[variantKeys[0]];
  let best = variantKeys[0];
  let bestD = Infinity;
  for (const k of variantKeys) {
    const anchor = entry.anchors[k];
    const anchorRgb = anchor ? hexToRgb(anchor) : null;
    if (!anchorRgb) continue;
    const d = rgbDistSq(carRgb, anchorRgb);
    if (d < bestD) {
      bestD = d;
      best = k;
    }
  }
  return entry.variants[best];
}

/** Resolves a manifest entry to a single filename string. Caller
 *  supplies the catalog car's body color so multi-variant entries
 *  pick the closest paint. */
function entryToFilename(entry: VehicleSpriteEntry, carColor: string): string | null {
  if (typeof entry === 'string') return entry;
  if ('down' in entry) return entry.down;
  if ('variants' in entry) return pickVariantFilename(entry, carColor);
  return null;
}

/** Returns the cached or fresh Image for a filename. */
export function getCarSprite(filename: string): HTMLImageElement {
  const url = VEHICLE_IMAGE_BASE + filename;
  const cached = SPRITE_CACHE.get(url);
  if (cached) return cached;
  const img = new Image();
  img.src = url;
  SPRITE_CACHE.set(url, img);
  return img;
}

/** Name → ready-or-loading Image, or null if the catalog name doesn't
 *  map to any sprite. */
export function spriteForCarName(name: string | undefined): HTMLImageElement | null {
  if (!name) return null;
  const genKey = getCarGeneration(name);
  if (!genKey) return null;
  const entry = VEHICLE_IMAGE_MANIFEST[genKey];
  if (!entry) return null;
  // Look up the catalog row for color-based variant selection.
  const slug = name.toLowerCase().replace(/[^a-z0-9]/g, '_');
  const catalog = CAR_CATALOG[slug];
  const color = catalog?.color ?? '#888888';
  const filename = entryToFilename(entry, color);
  if (!filename) return null;
  return getCarSprite(filename);
}
