/**
 * World-space navigation markers — home and player-placed carPins.
 *
 * Painted inside the world camera transform alongside the H203
 * job markers. Both gated on player-within-TILE*80 culling so they
 * only draw when the player is in render range.
 *
 *   - drawHomeMarker: cyan disc + 'H' label at LIFE.homeX/Y. Solid
 *     0.7 alpha (no blink — distinguishes from the blinking A/B
 *     job markers).
 *   - drawCarPinsWorld: per-pin colored label disc floating above
 *     a simple parked-car silhouette. Deterministic parking angle
 *     derived from the pin's world coords so the car doesn't
 *     swivel as the player approaches.
 *
 * 1:1 port of monolith L32712-32722 (home) and L50310-50345 (pins).
 *
 * Sedan/bike silhouette is a minimal flat-rect render — the
 * monolith calls its positional drawTopCar variant which doesn't
 * map cleanly to the modular drawTopCar(args, deps) signature.
 * Real sprite render is a small follow-up that needs a static
 * preview-deps factory.
 */

import { TILE } from '@/config/world/tiles';
import { CAR_CATALOG } from '@/config/cars/catalog';
import type { LifeState, CarPin } from '@/state/life';

const RENDER_RADIUS_PX = TILE * 80;
const HOME_CIRCLE_R = TILE * 1.2;

/** Cyan 'H' disc at the home tile center. No blink — distinguishes
 *  from the blinking A/B job markers (H203). 1:1 with monolith
 *  L32713-32722. */
export function drawHomeMarker(
  ctx: CanvasRenderingContext2D,
  life: LifeState,
  px: number,
  py: number,
): void {
  const hx = life.homeX * TILE + TILE / 2;
  const hy = life.homeY * TILE + TILE / 2;
  const dx = px - hx;
  const dy = py - hy;
  if (dx * dx + dy * dy >= RENDER_RADIUS_PX * RENDER_RADIUS_PX) return;
  ctx.fillStyle = 'rgba(0, 255, 255, 0.7)';
  ctx.beginPath();
  ctx.arc(hx, hy, HOME_CIRCLE_R, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#000';
  ctx.font = 'bold ' + (TILE * 0.9) + 'px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('H', hx, hy + TILE * 0.35);
  ctx.textAlign = 'left';
}

/** For each carPin within render range, paints a parked-car
 *  silhouette + a blinking color-coded label disc floating above it.
 *  Suppresses the pin when the sellerVisit is in menu/testdrive
 *  phase AND its source pin matches this one — the player can't
 *  also see the pin while inside its seller flow (1:1 with monolith
 *  L50317-50318 guard).
 *
 *  CarPin.listing is unknown at the type level — we cast through to
 *  { id?: string } so the renderer can resolve catalog color + bike
 *  branch. Listings without a recognized id render as a default gray
 *  sedan (rather than skipping the pin entirely — the label disc is
 *  still useful navigation even if the car art is generic). */
export function drawCarPinsWorld(
  ctx: CanvasRenderingContext2D,
  life: LifeState,
  px: number,
  py: number,
): void {
  if (!life.carPins || life.carPins.length === 0) return;
  const blink = Math.sin(Date.now() * 0.006) > 0;
  const svPin = life.sellerVisit
    && (life.sellerVisit.phase === 'menu' || life.sellerVisit.phase === 'testdrive')
    ? (life.sellerVisit as { _fromPin?: CarPin })._fromPin
    : null;

  for (const pin of life.carPins) {
    const dx = px - pin.worldX;
    const dy = py - pin.worldY;
    if (dx * dx + dy * dy >= RENDER_RADIUS_PX * RENDER_RADIUS_PX) continue;
    if (svPin === pin) continue; // pin is inside its own seller visit

    // Resolve catalog entry from the listing id (when present).
    const listing = pin.listing as { id?: string } | undefined;
    const car = listing?.id ? CAR_CATALOG[listing.id] : undefined;
    const carColor = car?.color ?? '#888';
    const isBike = !!car?.isBike;

    // Lazy-bake a deterministic parking angle from world coords
    // (matches monolith L50322). Stored on the pin so subsequent
    // frames reuse the same angle and the car doesn't swivel.
    if (pin._parkAngle == null) {
      pin._parkAngle = (pin.worldX * 7 + pin.worldY * 13) % 6.28;
    }
    const ang = pin._parkAngle;

    ctx.save();
    ctx.translate(pin.worldX, pin.worldY);
    ctx.rotate(ang);
    if (isBike) {
      // Simple motorcycle silhouette. 1:1 with monolith L50327-50329.
      ctx.fillStyle = '#111';
      ctx.fillRect(-6, -1.5, 12, 3);
      ctx.fillStyle = carColor;
      ctx.fillRect(-4, -2, 8, 4);
      ctx.fillStyle = '#333';
      ctx.fillRect(-7, -1, 3, 2);
      ctx.fillRect(5, -1, 3, 2);
    } else {
      // Simple sedan silhouette — placeholder for the full drawTopCar
      // render (deps-bundle issue documented in module header).
      // 20×8 footprint matches the default car-size constant used
      // elsewhere; a dark stroke gives it a window line.
      ctx.fillStyle = carColor;
      ctx.fillRect(-10, -4, 20, 8);
      ctx.fillStyle = 'rgba(0, 0, 0, 0.2)';
      ctx.fillRect(-3, -3, 8, 6); // cabin-shadow band
    }
    ctx.restore();

    // Label disc floating above the car. Blinks the pin color
    // between 0.45 (off) and 0.85 (on) alpha. Label text in #000
    // at TILE*1.0 monospace. 1:1 with monolith L50335-50342.
    ctx.save();
    ctx.globalAlpha = blink ? 0.85 : 0.45;
    ctx.fillStyle = pin.color;
    ctx.beginPath();
    ctx.arc(pin.worldX, pin.worldY - TILE * 2.5, TILE * 1.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#000';
    ctx.font = 'bold ' + (TILE * 1.0) + 'px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(pin.label, pin.worldX, pin.worldY - TILE * 2.1);
    ctx.textAlign = 'left';
    ctx.restore();
  }
}
