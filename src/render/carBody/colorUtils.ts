/**
 * Hex color utilities used by every V2 per-generation renderer.
 *
 *   darken('#aabbcc', 0.3)  → 30% darker (each channel × 0.7)
 *   lighten('#aabbcc', 0.3) → 30% lighter (each channel ramps 30% toward 255)
 *
 * Ported from monolith L42013–42020. Both take `#RRGGBB` 6-char hex strings;
 * neither validates input — silently returns garbage if `hex` is malformed.
 */

export function darken(hex: string, amt: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return '#' + [r, g, b]
    .map((c) => Math.max(0, Math.round(c * (1 - amt))).toString(16).padStart(2, '0'))
    .join('');
}

export function lighten(hex: string, amt: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return '#' + [r, g, b]
    .map((c) => Math.min(255, Math.round(c + (255 - c) * amt)).toString(16).padStart(2, '0'))
    .join('');
}
