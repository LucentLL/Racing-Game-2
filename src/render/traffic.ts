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
  /** H242: render-layer filter. When 'ground', only paint
   *  car.roadZ < 2. When 'elevated', only paint car.roadZ >= 2.
   *  When undefined (default), paint everything (backwards
   *  compatible with single-pass callers). Drives the bridge
   *  layering — ground traffic paints before drawBridgeOverlays
   *  so the bridge can cover them; elevated traffic paints after. */
  layerFilter?: 'ground' | 'elevated',
): void {
  if (intensity <= 0.02) return;
  for (const car of cars) {
    if (layerFilter === 'ground' && car.roadZ >= 2) continue;
    if (layerFilter === 'elevated' && car.roadZ < 2) continue;
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
      TRAFFIC_W / 2,
      false,
    );
  }
}

/** H147: closest-silhouette match for each civilian sprite filename
 *  in /cars/. Each key is one of the bodyType variants traceCarBodyPath
 *  carves a distinct shape for (silhouette.ts L22+). Unmatched files
 *  default to 'sedan'. The map handles substring matches case-insensitively
 *  so "Mazda-RX7-FC-Red.png" and "Mazda-RX-7-FD-Black.png" both resolve
 *  to 'rx7'. */
/** H169: PNG-filename → manifest key (V2 genId). Returns the key
 *  drawTopCar's legacy traffic path uses for hasVehicleSprite +
 *  getVehicleSprite + spriteBuffer lookups. Originally returned
 *  bodyType keys (nsx, viper, rx7) which made the legacy lookup miss
 *  the manifest (which stores V2 genIds nsx_na / dodge_viper /
 *  rx7_fc), forcing X-Ray fallback for every traffic NSX / Viper /
 *  RX-7 / Skyline / Charger. Switching to V2 genIds routes those
 *  through the proper PNG path so traffic now shows the same car
 *  art the player does. */
export function spriteFileToBodyType(spriteFile: string | null): string {
  if (!spriteFile) return 'sedan';
  const f = spriteFile.toLowerCase();
  if (f.includes('caravan'))   return 'suv';
  if (f.includes('ram'))       return 'pickup';
  if (f.includes('viper'))     return 'dodge_viper';
  if (f.includes('nsx'))       return 'nsx_na';
  if (f.includes('rx-7') || f.includes('rx7')) return 'rx7_fc';
  if (f.includes('skyline'))   return 'gtr_r34';
  if (f.includes('superbee') || f.includes('super-bee')) return 'dodge_super_bee';
  if (f.includes('barracuda') || f.includes('cuda')) return 'plymouth_cuda';
  if (f.includes('charger'))   return 'dodge_charger';
  if (f.includes('civic'))     return 'civic99';
  if (f.includes('accord'))    return 'accord99';
  if (f.includes('miata'))     return 'miata_na';
  if (f.includes('silvia'))    return 'silvia';
  if (f.includes('180via') || f.includes('180sx')) return 'silvia_180sx';
  if (f.includes('corolla') || f.includes('ae86')) return 'ae86';
  if (f.includes('audi') || f.includes('quattro')) return 'audi_quattro';
  if (f.includes('ruf btr'))   return 'ruf_btr';
  if (f.includes('ruf ctr2'))  return 'ruf_ctr2';
  if (f.includes('yellowbird') || f.includes('ruf ctr')) return 'ruf_ctr_yb';
  // H163: Crown Vic CMPD / ST cop units map to 'cruiser' (multi-
  // variant manifest entry — getVehicleSprite picks st vs cmpd by
  // anchor-color distance).
  if (f.includes('crown'))     return 'cruiser';
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

/** H663: dist² cull radius for the main traffic-sprite pass — matches
 *  the H242+ drawTrafficTailLights TAIL_CULL_R2 pattern but a touch
 *  wider (600 wpx vs 500) so cars at the camera's outer edge still
 *  paint when the player is moving fast and the camera lookahead has
 *  shifted. Pre-H663 the loop iterated EVERY traffic car each frame
 *  (no spatial gate at all), so a tickTraffic pool of ~24 cars cost
 *  24 full drawTopCar invocations (~24 ctx.save/translate/rotate +
 *  sprite/vector draws + state-restore) per frame regardless of how
 *  many were on-screen. Most are off-screen at any given time. */
const TRAFFIC_CULL_R2 = 600 * 600;
export function drawTraffic(
  ctx: CanvasRenderingContext2D,
  cars: readonly TrafficCar[],
  nightIntensity: number = 0,
  /** H242: render-layer filter (see drawTrafficHeadlights doc). */
  layerFilter?: 'ground' | 'elevated',
  /** H663: camera center for the dist² cull. Optional so existing
   *  callers that didn't pass it still render every car (back-compat
   *  for editor previews / dev panels). */
  centerX?: number,
  centerY?: number,
): void {
  ctx.lineWidth = 1;
  const canCull = centerX !== undefined && centerY !== undefined;
  // H98 front headlight bulb pixels at night — see drawTrafficHeadlights
  // for the warm cone projecting forward. Bulb is the cone's visible
  // source pixel at the front corners.
  const bulbA = nightIntensity > 0.05 ? 0.7 * nightIntensity : 0;
  const xFront = TRAFFIC_LEN / 2;
  const yOff = TRAFFIC_W / 2 - 1.5;
  const deps = trafficDrawDeps();
  for (const car of cars) {
    if (layerFilter === 'ground' && car.roadZ >= 2) continue;
    if (layerFilter === 'elevated' && car.roadZ < 2) continue;
    if (canCull) {
      const dx = car.px - centerX;
      const dy = car.py - centerY;
      if (dx * dx + dy * dy > TRAFFIC_CULL_R2) continue;
    }
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
        // H615: pipe the AI cop pursuit flag so the cruiser lightbar
        // flashes blue/white during chases (matches monolith L41447).
        isPursuing: car.isPursuing,
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
    // H165: pursuit lightbar. When a cop is pursuing, paint a
    // flashing red+blue strip across the roof — alternates ~5Hz so
    // it reads as emergency lights without strobing painfully. Roof
    // strip is in local car coords (rotated frame); 5 wpx wide,
    // centered on the body. Real emergency lightbars rotate / strobe;
    // this is a 2D approximation. The PNG sprites for CMPD / ST
    // already have static lightbars baked in — the H165 flash
    // overlays on top so the cop visibly "lights up" when chasing.
    if (car.isPursuing) {
      const phase = Math.floor(Date.now() / 100) & 1; // 5 Hz toggle
      ctx.save();
      ctx.translate(car.px, car.py);
      ctx.rotate(car.pAngle);
      const halfL = 5;
      const halfW = TRAFFIC_W / 2 - 1;
      // Left half — color A
      ctx.fillStyle = phase ? 'rgba(40, 80, 255, 0.95)' : 'rgba(255, 40, 40, 0.95)';
      ctx.fillRect(-halfL, -halfW, halfL, halfW * 2);
      // Right half — color B (opposite phase)
      ctx.fillStyle = phase ? 'rgba(255, 40, 40, 0.95)' : 'rgba(40, 80, 255, 0.95)';
      ctx.fillRect(0, -halfW, halfL, halfW * 2);
      ctx.restore();
    }
  }
  // Silence unused-import for the legacy PNG sprite path —
  // getCarSprite stays callable for any subsystem (carSelect preview,
  // car-pin minimap) that wants the raw PNG. Removal lands when no
  // module references it anymore.
  void getCarSprite;
}

