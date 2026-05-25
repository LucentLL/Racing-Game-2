/**
 * Near-pin prompt — "drive-up to buy" call-to-action.
 *
 * When the player rolls slowly (|pSpeed|<5) within ~2.5 tiles of any
 * placed carPin, this module surfaces an orange "🚗 VIEW CAR (label)"
 * button (or purple "🏠 VIEW HOME (label)" for house listings). Tapping
 * the button opens the seller-visit / realtor flow.
 *
 * Ported from monolith L50361, L50403-50415 (checkNearPin), L50418-
 * 50428 (drawNearPinPrompt), L50430-50465 (handleNearPinTap).
 *
 * Live as of H619: pinPicker (newspaper → pin), purchase, realtor,
 * and seller-visit interiors are all ported (H189 + H569 onward).
 * carPins is populated by the home overlay's newspaper tab and
 * expired by sim/expireCarPins.ts; the tap handler routes through to
 * the seller / realtor modals via gameLoop. Earlier "DORMANT" caveats
 * are gone.
 */

import { TILE } from '@/config/world/tiles';
import type { CarPin } from '@/state/life';

/** Module-level "current near pin" cache, refreshed each frame by
 *  checkNearPin. Lives at module scope to match the monolith's
 *  L50361 `let _nearPin=null;` and so the click router can read the
 *  exact same value the renderer painted from. */
let _nearPin: CarPin | null = null;

/** Slow-speed gate the monolith uses. Player must be below 5 wpx/s
 *  (~2 mph) so the prompt doesn't strobe past as you drive by. */
const NEAR_PIN_SPEED_MAX = 5;

/** Search radius² (game-px²). Monolith: `TILE*TILE*6` ≈ 1944 — about
 *  a 2.5-tile radius around the pin. */
const NEAR_PIN_RADIUS_PX2 = TILE * TILE * 6;

/** Hit-test box for the prompt button. */
export function nearPinRect(GW: number, GH: number): {
  x: number; y: number; w: number; h: number;
} {
  return { x: GW / 2 - 65, y: GH * 0.35, w: 130, h: 28 };
}

/** Read the cached near-pin. Click router calls this. */
export function getNearPin(): CarPin | null {
  return _nearPin;
}

/** Per-frame recompute of the closest in-range pin. 1:1 port of
 *  monolith L50403-50416 — speed gate, pin walk, distance² min,
 *  early-out when carPins is empty.
 *
 *  Additional guard `seller/realtor visit not in driving phase` from
 *  L50406 is intentionally skipped — the seller-visit phase machine
 *  hasn't ported yet and there is no state that could need
 *  suppressing. */
export function checkNearPin(
  carPins: CarPin[] | undefined,
  playerPx: number,
  playerPy: number,
  pSpeed: number,
): void {
  _nearPin = null;
  if (!carPins || carPins.length === 0) return;
  if (Math.abs(pSpeed) > NEAR_PIN_SPEED_MAX) return;
  let best: CarPin | null = null;
  let bestD = NEAR_PIN_RADIUS_PX2;
  for (const pin of carPins) {
    const dx = playerPx - pin.worldX;
    const dy = playerPy - pin.worldY;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD) {
      bestD = d2;
      best = pin;
    }
  }
  _nearPin = best;
}

/** Paints the orange (car) / purple (house) button. No-op when
 *  _nearPin is null. 1:1 port of monolith L50418-50428. */
export function drawNearPinPrompt(
  ctx: CanvasRenderingContext2D,
  GW: number,
  GH: number,
): void {
  if (!_nearPin) return;
  const { x: bx, y: by, w: bw, h: bh } = nearPinRect(GW, GH);
  // listing.type === 'house' is the realtor branch. Cast through
  // unknown because CarPin.listing is intentionally decoupled from
  // the newspaper-listing shape.
  const listing = _nearPin.listing as { type?: string } | undefined;
  const isHouse = listing?.type === 'house';
  ctx.fillStyle = isHouse ? 'rgba(200, 130, 255, 0.3)' : 'rgba(255, 160, 0, 0.3)';
  ctx.fillRect(bx, by, bw, bh);
  ctx.strokeStyle = isHouse ? '#c8f' : '#fa0';
  ctx.lineWidth = 2;
  ctx.strokeRect(bx, by, bw, bh);
  ctx.fillStyle = isHouse ? '#c8f' : '#fa0';
  ctx.font = 'bold 11px monospace';
  ctx.textAlign = 'center';
  ctx.fillText(
    (isHouse ? '🏠 VIEW HOME (' : '🚗 VIEW CAR (') + _nearPin.label + ')',
    GW / 2,
    by + 18,
  );
  ctx.textAlign = 'left';
  ctx.lineWidth = 1;
}

/** Hit-test helper for the click router. */
export function isNearPinHit(
  tx: number,
  ty: number,
  GW: number,
  GH: number,
): boolean {
  const { x, y, w, h } = nearPinRect(GW, GH);
  return tx >= x && tx <= x + w && ty >= y && ty <= y + h;
}
