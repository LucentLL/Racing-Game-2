/**
 * Shared deps factory for static drawTopCar previews (STATUS-tab
 * sprite, jobSelect car cards, etc).
 *
 * The render-time drawTopCar in playerCar.ts builds its deps from
 * a live PlayerState. Menu previews don't have a live player — they
 * just want "show this catalog car at angle 0 with neutral
 * lighting". This factory packages the same imports
 * (getVehicleSprite / SPRITE_BUFFER / GT4_SPECS) into a deps bundle
 * that takes a CatalogCar instead.
 *
 * Falls back gracefully when the sprite isn't loaded yet — drawTopCar
 * picks the V2-vector path automatically.
 */

import type { CatalogCar } from '@/config/cars/catalog';
import type { DrawTopCarDeps } from './drawTopCar';
import type { XrayCondition } from './xrayDrivetrain';
import type { BodyDamage } from './damage';
import { getVehicleSprite, hasVehicleSprite } from '@/engine/sprites';
import { SPRITE_BUFFER } from '@/config/cars/spriteBuffer';
import { GT4_SPECS } from '@/config/cars/gt4Database';

/** Build the static-preview deps for a single CatalogCar entry.
 *  Returns the bundle drawTopCar wants when isPlayer=true.
 *
 *  H1284: pass `xrayCond` to render the preview as an X-RAY instead of the
 *  body/sprite — drivetrain identity rides the catalog entry (drv/eType)
 *  and the condition tints ride the caller-supplied XrayCondition, so the
 *  garage SPECS inspection shows the same internals the in-world X-ray
 *  does. Omitting it keeps the classic sprite preview. */
export function previewDepsForCar(
  car: CatalogCar,
  xrayCond?: XrayCondition,
  bodyDamage?: BodyDamage,
): DrawTopCarDeps {
  return {
    player: {
      name: car.name,
      color: car.color,
      size: car.size,
      isBike: car.isBike,
      isReverse: false,
      steerAngle: 0,
      leftHeadlightOut: false,
      rightHeadlightOut: false,
      leftTaillightOut: false,
      rightTaillightOut: false,
      xrayBody: !!xrayCond,
      drv: car.drv,
      engineType: car.eType,
      xrayCond,
      bodyDamage,
    },
    hour: 12, // neutral midday lighting
    getVehicleSprite,
    hasVehicleSprite,
    spriteBuffer: SPRITE_BUFFER,
    gt4Lookup: (n) => GT4_SPECS[n],
  };
}
