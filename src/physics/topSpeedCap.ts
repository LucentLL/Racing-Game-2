/**
 * Per-frame effective top-speed resolver. The OPT PHYSICS TUNING
 * "Top Speed Cap" slider writes life.gameplaySettings.physTopSpeedCap
 * (km/h, range 250-450, default 350); this helper clamps a car's
 * catalog topSpeed against that cap each frame so a player who
 * dials the cap down to 250 km/h sees every car artificially
 * limited.
 *
 * Conversion: km/h → wpx/s = (km/h ÷ 3.6) × SCALE_MS. The cap is
 * pre-computed once per resolve so the gameLoop arcadeUpdate path
 * and the Phase 0B adapter both use the same clamped value.
 *
 * H584+: the monolith rebuilds CARS when this knob changes
 * (matching the L93-95 comment in src/config/cars/catalog.ts). The
 * modular path uses per-frame clamping instead — no global rebuild,
 * no save migration, but the player only sees the cap on the
 * currently-controlled car (parked traffic still uses its full
 * catalog top speed, which is correct anyway since cap is a
 * player-side preference).
 */

import type { LifeState } from '@/state/life';
import type { CatalogCar } from '@/config/cars/catalog';
import { SCALE_MS } from '@/physics/physicsUnits';

/** Convert km/h to world-pixels/second. Mirrors the kmh→wpx
 *  math in physicsUnits, inlined here for cap arithmetic. */
function kmhToWpx(kmh: number): number {
  return (kmh / 3.6) * SCALE_MS;
}

/** Returns the effective top speed (wpx/s) for the supplied car
 *  honoring the OPT physTopSpeedCap if set. Falls through to the
 *  catalog topSpeed when the cap is unset or wouldn't reduce. */
export function effectiveTopSpeed(car: CatalogCar | undefined, life: LifeState | undefined | null): number {
  const catalogTop = car?.topSpeed ?? Infinity;
  const capKmh = life?.gameplaySettings?.physTopSpeedCap;
  if (typeof capKmh !== 'number' || capKmh <= 0) return catalogTop;
  // Clamp the OPT input to the slider's advertised range so a stale
  // save value can't accidentally lock the player to 1 m/s.
  const safeKmh = Math.max(250, Math.min(450, capKmh));
  const capWpx = kmhToWpx(safeKmh);
  return Math.min(catalogTop, capWpx);
}
