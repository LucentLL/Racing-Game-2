/**
 * H17/H28 traffic render — paints each TrafficCar as its picked /cars/
 * PNG sprite when the image is loaded, else falls back to the H17
 * colored rectangle (matching the player triangle's CAR_LEN/CAR_W
 * ratio) in world space. Caller has applied the camera translate
 * already.
 *
 * Per-frame cost: ~24 rotate + 1 drawImage (or 1 fillRect + 1
 * strokeRect) per car ≈ trivial. No culling — the world is big but
 * the cost is bounded.
 */

import type { TrafficCar } from '@/state/traffic';
import { getCarSprite } from './carSprites';
import { drawHeadlightsAt } from './playerCar';
import { drawTopCar } from './carBody';
import { getVehicleSprite, hasVehicleSprite } from '@/engine/sprites';
import { SPRITE_BUFFER } from '@/config/cars/spriteBuffer';
import { GT4_SPECS } from '@/config/cars/gt4Database';

/** H147: traffic now renders through drawTopCar with the same V2 +
 *  X-Ray dispatcher the player uses (H146). Bumped from 16×10 to
 *  22×8 so the body footprint matches V2_PLAYER_SIZE in playerCar.ts
 *  (NPCs and the player are similar real-world cars, so identical
 *  footprints read correctly). Tail-light / headlight bulb offsets
 *  below auto-derive from these constants, so the corner pixel
 *  positions still land at the rendered body's tips. */
const TRAFFIC_LEN = 22;
const TRAFFIC_W = 8;
/** Beam reach for traffic — shorter than the player's so off-camera
 *  cones don't blanket the screen. */
const TRAFFIC_BEAM_LEN = 140;
/** Distance² cull for headlight cones — only paint cones from cars
 *  near enough to plausibly illuminate the player's frame. */
const HEADLIGHT_CULL_R2 = 600 * 600;

/** H53 traffic-headlight pass — paint warm cones in front of every
 *  visible traffic car when nightIntensity > 0. Call BEFORE drawTraffic
 *  so the cone sits under the car body (matches monolith z-order).
 *  Distance²-culled around the player so we only pay for cars in the
 *  visible viewport. */
export function drawTrafficHeadlights(
  ctx: CanvasRenderingContext2D,
  cars: readonly TrafficCar[],
  centerX: number,
  centerY: number,
  intensity: number,
): void {
  if (intensity <= 0.02) return;
  for (const car of cars) {
    const dx = car.px - centerX;
    const dy = car.py - centerY;
    if (dx * dx + dy * dy > HEADLIGHT_CULL_R2) continue;
    drawHeadlightsAt(
      ctx,
      car.px,
      car.py,
      car.pAngle,
      intensity,
      TRAFFIC_LEN / 2,
      TRAFFIC_BEAM_LEN,
    );
  }
}

/** H147: closest-silhouette match for each civilian sprite filename
 *  in /cars/. Each key is one of the bodyType variants traceCarBodyPath
 *  carves a distinct shape for (silhouette.ts L22+). Unmatched files
 *  default to 'sedan'. The map handles substring matches case-insensitively
 *  so "Mazda-RX7-FC-Red.png" and "Mazda-RX-7-FD-Black.png" both resolve
 *  to 'rx7'. */
function spriteFileToBodyType(spriteFile: string | null): string {
  if (!spriteFile) return 'sedan';
  const f = spriteFile.toLowerCase();
  if (f.includes('caravan'))  return 'suv';
  if (f.includes('ram'))      return 'pickup';
  if (f.includes('viper'))    return 'viper';
  if (f.includes('nsx'))      return 'nsx';
  if (f.includes('rx-7') || f.includes('rx7')) return 'rx7';
  if (f.includes('skyline'))  return 'gtr';
  if (f.includes('charger') || f.includes('superbee') || f.includes('barracuda') || f.includes('cuda')) return 'camaro';
  if (f.includes('civic'))    return 'civic99';
  if (f.includes('accord'))   return 'accord99';
  return 'sedan';
}

/** H147: DrawTopCarDeps factory shared across the 24 traffic cars per
 *  frame. Built once per drawTraffic call to avoid 24× object literal
 *  churn. player: null marks the dispatch as NPC; gt4Lookup, sprite
 *  resolvers, and SPRITE_BUFFER are the same as the player path. The
 *  full DrawTopCarDeps shape lives in carBody/drawTopCar.ts. */
function trafficDrawDeps() {
  return {
    player: null as null,
    hour: 12,
    getVehicleSprite,
    hasVehicleSprite,
    spriteBuffer: SPRITE_BUFFER,
    gt4Lookup: (n: string) => GT4_SPECS[n],
  };
}

export function drawTraffic(
  ctx: CanvasRenderingContext2D,
  cars: readonly TrafficCar[],
  nightIntensity: number = 0,
): void {
  ctx.lineWidth = 1;
  // H98 front headlight bulb pixels at night — see drawTrafficHeadlights
  // for the warm cone projecting forward. Bulb is the cone's visible
  // source pixel at the front corners.
  const bulbA = nightIntensity > 0.05 ? 0.7 * nightIntensity : 0;
  const xFront = TRAFFIC_LEN / 2;
  const yOff = TRAFFIC_W / 2 - 1.5;
  const deps = trafficDrawDeps();
  for (const car of cars) {
    // H147: drawTopCar handles its own ctx.save/translate/rotate +
    // restore — pass world-space cx/cy/angle directly. trafBody picks
    // the silhouette curve; X-Ray fires automatically when the sprite
    // for that bodyType isn't in the cache (which is the current
    // state for every civilian filename). Sprite path can resume
    // wiring through here when V2 PNG loading lands.
    drawTopCar(
      ctx,
      {
        cx: car.px,
        cy: car.py,
        angle: car.pAngle,
        color: car.color,
        isPlayer: false,
        steerAngle: 0,
        trafBody: spriteFileToBodyType(car.spriteFile),
        isBraking: car.braking,
      },
      deps,
    );
    // H98 bulb pixels — paint AFTER drawTopCar in the rotated frame
    // so they sit on top of the body silhouette.
    if (bulbA > 0) {
      ctx.save();
      ctx.translate(car.px, car.py);
      ctx.rotate(car.pAngle);
      ctx.fillStyle = `rgba(255, 240, 200, ${bulbA})`;
      ctx.fillRect(xFront - 1.5, -yOff - 0.75, 1.5, 1.5);
      ctx.fillRect(xFront - 1.5,  yOff - 0.75, 1.5, 1.5);
      ctx.restore();
    }
  }
  // Silence unused-import for the legacy PNG sprite path —
  // getCarSprite stays callable for any subsystem (carSelect preview,
  // car-pin minimap) that wants the raw PNG. Removal lands when no
  // module references it anymore.
  void getCarSprite;
}

/** H54 — paint 2 small red tail-light pixels at the rear of every
 *  visible traffic car. Always-on (running lights), brighter at night.
 *  H97 — add a small per-car halo at night so the tails read as
 *  "lit running lights" against dark pavement, parallel to the H94
 *  player reverse halo + H95 brake halo. Traffic doesn't have a
 *  brake state in modular yet (the monolith's lane-change / signal-
 *  follow AI hasn't ported — see src/world/traffic/ai scaffold), so
 *  the brake-bright variant + brake ground wash stay player-only
 *  until the AI port lands and TrafficCar gains a `braking` flag.
 *  Drawn AFTER drawTraffic so the lights sit on top of the sprite. */
const TAIL_CULL_R2 = 500 * 500;
export function drawTrafficTailLights(
  ctx: CanvasRenderingContext2D,
  cars: readonly TrafficCar[],
  centerX: number,
  centerY: number,
  intensity: number,
): void {
  // Tail lights always render — daylight running lights are real.
  // Color saturation increases at night via intensity.
  const runningA = 0.55 + intensity * 0.4;
  const xRear = -TRAFFIC_LEN / 2;
  const yOff = TRAFFIC_W / 2 - 1.5;
  // H97 night halo for the always-on running lamps. Color matches
  // the lamp (rgba 220,40,30) so it reads as the same bulb's bloom,
  // not a separate light source. Alpha is ~half the crisp lamp's.
  const haloA = intensity > 0.05 ? 0.30 * intensity : 0;
  for (const car of cars) {
    const dx = car.px - centerX;
    const dy = car.py - centerY;
    if (dx * dx + dy * dy > TAIL_CULL_R2) continue;
    ctx.save();
    ctx.translate(car.px, car.py);
    ctx.rotate(car.pAngle);
    // H110: braking cars get bright saturated red lamps + an oversize
    // halo (same pattern player H95 uses, scaled to traffic 1.5 px
    // lamps). Painted under the crisp pixels so they read on top.
    if (car.braking) {
      // H111: night ground wash. Symmetric to player H95 — red linear
      // gradient on the pavement behind the bumper, alpha scales with
      // nightIntensity. Reach 4 px (half the player's 8) matches the
      // smaller traffic bumper width. Daytime (intensity < 0.05)
      // skips entirely — daylight braking still gets the corner
      // pixels + bloom below.
      if (intensity > 0.05) {
        const reach = 4;
        const grad = ctx.createLinearGradient(xRear, 0, xRear - reach, 0);
        grad.addColorStop(0, `rgba(255, 60, 50, ${0.55 * intensity})`);
        grad.addColorStop(1, 'rgba(255, 60, 50, 0)');
        ctx.fillStyle = grad;
        // Span the rear bumper minus 1 px each side so the wash
        // doesn't bleed past the tail corners.
        const halfW = TRAFFIC_W / 2;
        ctx.fillRect(xRear - reach, -halfW + 1, reach, TRAFFIC_W - 2);
      }
      // Always-visible braking bloom — daytime + night.
      ctx.fillStyle = 'rgba(255, 60, 50, 0.55)';
      ctx.fillRect(xRear - 1, -yOff - 1.5, 3, 3);
      ctx.fillRect(xRear - 1,  yOff - 1.5, 3, 3);
      // Crisp brake-bright lamps in #ff3020 — same hex the player
      // uses for the brake-pressed state.
      ctx.fillStyle = '#ff3020';
      ctx.fillRect(xRear, -yOff - 0.75, 1.5, 1.5);
      ctx.fillRect(xRear,  yOff - 0.75, 1.5, 1.5);
    } else {
      // Halo first so the crisp 1.5×1.5 lamp sits on top of it.
      // 2.5×2.5 centered on the same point.
      if (haloA > 0) {
        ctx.fillStyle = `rgba(220, 40, 30, ${haloA})`;
        ctx.fillRect(xRear - 0.5, -yOff - 1.25, 2.5, 2.5);
        ctx.fillRect(xRear - 0.5,  yOff - 1.25, 2.5, 2.5);
      }
      // Dim running-light crisp lamps.
      ctx.fillStyle = `rgba(220, 40, 30, ${runningA})`;
      ctx.fillRect(xRear, -yOff - 0.75, 1.5, 1.5);
      ctx.fillRect(xRear,  yOff - 0.75, 1.5, 1.5);
    }
    ctx.restore();
  }
}
