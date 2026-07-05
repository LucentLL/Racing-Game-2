/**
 * H1050: car-manufacturer emblem in the steering-wheel hub center.
 *
 * The wheel SVG (#steerWheelSvg) gained a MOMO-style 3-spoke hub (index.html)
 * whose center cap hosts an <image id="swHubLogo"> slot. This module points
 * that image at the ACTIVE car's brand logo (CAR_LOGOS via getCarLogoUrl) so
 * each car's wheel reads with its own marque — the "distinction" the manufacturer
 * sprites are for. Cars with no logo entry hide the image, leaving a plain dark
 * center cap (a clean fallback, not a broken-image icon).
 *
 * The emblem lives INSIDE the rotating #steerWheelSvg, so it turns with the
 * wheel like a real center cap and returns upright when the wheel snaps to
 * neutral on release.
 *
 * Dirty-checked on car id so the per-frame HUD call collapses to a no-op when
 * the car hasn't changed.
 */

import { getCarLogoUrl } from '@/config/carLogos';

let hubImgEl: SVGImageElement | null = null;
let resolved = false;
/** undefined = never set yet (forces the first apply); string|null thereafter. */
let lastCarId: string | null | undefined;

function ensureEl(): SVGImageElement | null {
  if (resolved) return hubImgEl;
  if (typeof document === 'undefined') return null;
  resolved = true;
  hubImgEl = document.getElementById('swHubLogo') as SVGImageElement | null;
  return hubImgEl;
}

/** Point the wheel-hub emblem at `carId`'s brand logo, or hide it when the car
 *  has no logo. Dirty-checked — safe to call every HUD frame. */
export function setWheelHubLogo(carId: string | null): void {
  if (carId === lastCarId) return;
  lastCarId = carId;
  const el = ensureEl();
  if (!el) return;
  const url = carId ? getCarLogoUrl(carId) : null;
  if (url) {
    el.setAttribute('href', url);
    el.style.display = '';
  } else {
    el.removeAttribute('href');
    el.style.display = 'none';
  }
}
