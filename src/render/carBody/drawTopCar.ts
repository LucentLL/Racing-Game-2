/**
 * drawTopCar — the per-vehicle render entry point. Dispatches to:
 *   1. Bike vector renderer (Harley cruiser OR sport bike) — when bodyType
 *      or player CAR is a bike, with sprite hook for the four bike sprites.
 *   2. Ambulance vector renderer — special-cased for the player's Ambulance
 *      (cab+box+lightbar+red cross), with PNG sprite hook.
 *   3. V2 per-chassis renderer — when getCarGeneration() returns a known
 *      id and GEN_DATA has an entry. PNG sprite drawn if present in the
 *      VEHICLE_IMAGE_MANIFEST; else GEN_DATA[id].render() is invoked.
 *   4. Legacy bodyType silhouette via traceCarBodyPath + per-bodyType
 *      pixel overlays (hood highlights, cop stripes, tow flatbed, semi
 *      details, etc.).
 *
 * Ported from monolith L40358-42012. The per-bodyType pixel-detail
 * overlays inside the legacy fallback are intentionally NOT ported in
 * this commit — they're ~800 lines of pixel-level visual polish that
 * only show when no PNG sprite is loaded (V2 sprite + X-Ray fallback
 * cover all player + traffic cars in practice). Each section is
 * tagged TODO with the monolith line range; bike + ambulance also
 * land as separate follow-up extractions for the same reason.
 *
 * Type contract here matches the monolith's 11-arg signature so the
 * cutover point in main.ts can swap a direct module import for the
 * legacy global without surface changes.
 */

import type { GT4SpecLike } from './types';
import { getCarGeneration } from './generation';
import { drawCarBodyV2 } from './drawCarBodyV2';
import { traceCarBodyPath } from './silhouette';
import { setV2PlayerTailDraw, v2GroundShadow } from './v2Helpers';
import { xrayCarGeom, drawXrayTiresFromGeom, xrayBikeGeom, drawXrayBikeTiresFromGeom } from './xrayGeom';
import { drawXrayDamageOverlay, type BodyDamage } from './damage';
import { darken, lighten } from './colorUtils';
import { WPX_PER_MM } from '@/config/world/tiles';

/** Player car summary needed by drawTopCar. Built from CAR() + LIFE. */
export interface PlayerCarSnapshot {
  name: string;
  color: string;
  size: readonly [number, number];
  isBike: boolean;
  /** Driver-intent reverse flag (gear selector, not velocity sign). */
  isReverse: boolean;
  /** Frontwheel steering angle (also used for bike lean visual). */
  steerAngle: number;
  /** Per-side headlight + taillight fault flags. */
  leftHeadlightOut: boolean;
  rightHeadlightOut: boolean;
  leftTaillightOut: boolean;
  rightTaillightOut: boolean;
  /** X-ray body mode toggle. */
  xrayBody: boolean;
  /** Per-zone body damage. Optional — null for cars with no damage tracked. */
  bodyDamage?: BodyDamage;
}

/** H805: real-vehicle mm → game units at the ROAD-TRUE world scale
 *  (WPX_PER_MM from config/world/tiles.ts, ≈ 1/159.4). Replaces the
 *  monolith's ~4.5 gu/m convention (mm × 0.0045), which drew every
 *  car at only 72% of the road network's scale — the user-reported
 *  "cars are 40-50% of a lane, should be ~70%". */
const MM = (l: number, w: number): readonly [number, number] =>
  [l * WPX_PER_MM, w * WPX_PER_MM] as const;

/** Per-bodyType physical size (game units). Mirrors L40396-40408 of
 *  monolith, restated as real-vehicle MILLIMETERS so the values ride
 *  the world-scale constant. H805 also corrects the muscle trio —
 *  Charger / Super Bee / Cuda shared a generic 4867×1844 "camaro"
 *  entry while their own comments carried the true dims (the user
 *  noticed the Charger reading short).
 *  v8.99.123.21 / .24 / .25 finalized the originals for sprite-mapped
 *  traffic; trucks keep their game-tuned implied mm. */
export const TRAFFIC_BODY_SIZES: Readonly<Record<string, readonly [number, number]>> = {
  semi:     MM(7556, 2667),  // Peterbilt 379 (game-tuned)
  boxtruck: MM(7333, 2444),  // Ford E-450 box (game-tuned)
  towtruck: MM(8556, 2600),  // F-550 + boom overhang (game-tuned)
  bike:     MM(2200, 800),   // generic motorcycle (real dims)
  civic99:  MM(4439, 1705),  // 1999 Honda Civic Coupe
  accord99: MM(4813, 1786),  // 1999 Honda Accord Sedan
  sedan:    MM(5017, 1854),  // 1996 Ford Taurus GL
  hatch:    MM(4732, 1950),  // 1999 Dodge Caravan SWB
  suv:      MM(4732, 1950),  // 1999 Dodge Caravan SWB (alias)
  pickup:   MM(5176, 2018),  // 1999 Dodge Ram 1500 RegCab
  cruiser:  MM(5395, 1980),  // 1999 Ford Crown Vic P71 (traffic cops)
  // H157: per-chassis dims for the legacy bodyType keys (kept as
  // back-compat — H169 routes traffic through V2 genIds below).
  viper:    MM(4488, 1923),  // 1996 Dodge Viper GTS
  nsx:      MM(4405, 1810),  // 1991 Acura NSX
  rx7:      MM(4285, 1760),  // 1991 Mazda RX-7 FD/FC
  gtr:      MM(4600, 1785),  // 1999 Skyline GT-R R34
  camaro:   MM(4724, 1880),  // 1969 Camaro SS (was generic muscle)
  // H169: V2 genId entries so traffic dispatched via
  // spriteFileToBodyType lands on accurate dims AND the manifest's
  // PNG. drawTopCar's legacy-traffic path looks up size by trafBody;
  // without these the V2-keyed traffic would render at the
  // DEFAULT_BODY_SIZE regardless of chassis.
  dodge_viper:     MM(4488, 1923),
  nsx_na:          MM(4405, 1810),
  rx7_fc:          MM(4290, 1760),  // FC3S
  rx7_fd:          MM(4285, 1760),  // FD3S
  gtr_r34:         MM(4600, 1785),
  gtr_r34_vspec:   MM(4600, 1785),
  dodge_charger:   MM(5232, 1948),  // '70 Charger R/T (H805: was 4867)
  dodge_super_bee: MM(5232, 1948),  // '70 Coronet Super Bee
  plymouth_cuda:   MM(5008, 1880),  // '70 Cuda
  miata_na:        MM(3950, 1675),
  silvia:          MM(4520, 1695),  // S13 coupe
  silvia_180sx:    MM(4520, 1695),  // S13 hatch
  ae86:            MM(4205, 1625),  // Levin / Trueno
  audi_quattro:    MM(4404, 1723),  // B2 Ur-Quattro
  ruf_btr:         MM(4291, 1652),  // 911 Carrera 3.2
  ruf_ctr_yb:      MM(4291, 1652),  // 911 G-body
  ruf_ctr2:        MM(4245, 1735),  // 993
};

/** Default size when bodyType not in TRAFFIC_BODY_SIZES. */
const DEFAULT_BODY_SIZE: readonly [number, number] = MM(4445, 1778);

/** Wheelbase axle fractions [front, rear] for the legacy vector body
 *  fallback. Front = +hl × front; rear = -hl × rear. From monolith L41166. */
export const LEGACY_WB_FRACTIONS: Readonly<Record<string, readonly [number, number]>> = {
  viper:    [.62, .48], nsx:      [.59, .55], supra:    [.55, .51],
  rx7:      [.57, .52], corvette: [.56, .47], gtr:      [.58, .55],
  camaro:   [.55, .42], mustang:  [.56, .43], gto:      [.54, .50],
  mr2:      [.57, .55], tvr:      [.60, .52], hatch:    [.614, .603],
  roadster: [.61, .53], integra:  [.62, .53], silvia:   [.57, .50],
  celica:   [.57, .52], eclipse:  [.57, .50], rally:    [.58, .55],
  race:     [.55, .52], sedan:    [.585, .514], suv:    [.614, .603],
  pickup:   [.637, .529], towtruck: [.50, .45], cruiser: [.58, .52],
  semi:     [.62, .50], boxtruck: [.52, .42],
  civic99:  [.62, .55], accord99: [.555, .576],
};

/** Resolve a player car's display name to the bodyType used by the legacy
 *  vector fallback. Mirrors L41100-41131. */
export function resolveLegacyBodyType(carName: string): string {
  const n = carName;
  if (n.includes('Viper'))      return 'viper';
  if (n.includes('NSX'))        return 'nsx';
  if (n.includes('Supra'))      return 'supra';
  if (n.includes('RX-7'))       return 'rx7';
  if (n.includes('Corvette'))   return 'corvette';
  if (n.includes('GT-R') || n.includes('Fairlady')) return 'gtr';
  if (n.includes('GTO'))        return 'gto';
  if (n.includes('MR2'))        return 'mr2';
  if (n.includes('Griffith') || n.includes('Cerbera')) return 'tvr';
  if (n.includes('Camaro'))     return 'camaro';
  if (n.includes('Mustang'))    return 'mustang';
  if (n.includes('Integra'))    return 'integra';
  if (n.includes('del Sol') || n.includes('CR-X') || n.includes('Eunos')
   || n.includes('Roadster') || n.includes('Miata') || n.includes('MX-5')) return 'roadster';
  if (n.includes('Civic') || n.includes('Pulsar') || n.includes('Starlet')
   || n.includes('Mirage') || n.includes('Demio')) return 'hatch';
  if (n.includes('Stratos')) return 'roadster';
  if (n.includes('Focus') || n.includes('Xsara') || n.includes('206 Rally')
   || n.includes('Corolla Rally') || n.includes('HF Integrale')) return 'hatch';
  if (n.includes('Impreza') || n.includes('Lancer') || n.includes('Escort Rally')
   || n.includes('Corolla') || n.includes('Bluebird') || n.includes('240RS')) return 'rally';
  if (n.includes('RS200') || n.includes('205 Turbo 16') || n.includes('Delta S4')
   || n.includes('5 Maxi')) return 'race';
  if (n.includes('LM') || n.includes('Castrol')) return 'race';
  if (n.includes('Celica'))     return 'celica';
  if (n.includes('Silvia') || n.includes('180SX')) return 'silvia';
  if (n.includes('Eclipse') || n.includes('3000GT')) return 'eclipse';
  if (n.includes('Skyline') && !n.includes('GT-R')) return 'sport';
  if (n.includes('Tow Truck')) return 'towtruck';
  if (n.includes('Police Cruiser')) return 'cruiser';
  if (n.includes('Semi Truck')) return 'semi';
  if (n.includes('Box Truck'))  return 'boxtruck';
  return 'sedan';
}

/** Compute night factor [0..1] from hour-of-day. H680: binary on/off
 *  instead of the dusk/dawn ramp the monolith used (L40414). Paired
 *  with state/clock.ts:nightIntensity — same user feedback, same
 *  threshold style. Hour-of-day midpoints of the old ramps:
 *    - Dusk transition centered at hour 20 (old ramp 19→21).
 *    - Dawn transition centered at hour 6 (old ramp 5→7).
 *  Threshold at 5.65 / 18.6 matches state/clock.ts (timeOfDay 0.235
 *  = 5h38m, 0.775 = 18h36m). */
export function computeNightFactor(hour: number): number {
  return (hour >= 18.6 || hour < 5.65) ? 1 : 0;
}

/** Vehicle sprite resolver shape. Mirrors monolith getVehicleSprite. */
export type GetVehicleSpriteFn = (
  key: string,
  hlUp?: boolean,
  color?: string,
) => HTMLCanvasElement | HTMLImageElement | null;

export type HasVehicleSpriteFn = (key: string) => boolean;

/** Sprite buffer correction table (key → [Lscale, Wscale]). Used by both
 *  V2 sprite + bike sprite paths to compensate for mirror/fender flare
 *  that inflates the auto-trimmed canvas without contributing to body
 *  width. From monolith _SPRITE_BUFFER. */
export type SpriteBufferTable = Readonly<Record<string, readonly [number, number]>>;

export interface DrawTopCarDeps {
  /** Player snapshot, or null for traffic. */
  player: PlayerCarSnapshot | null;
  /** Current LIFE.hour for night factor calc. */
  hour: number;
  /** Sprite resolver — pulls per-key cached canvas from VehicleSprites cache. */
  getVehicleSprite: GetVehicleSpriteFn;
  hasVehicleSprite: HasVehicleSpriteFn;
  spriteBuffer: SpriteBufferTable;
  /** GT4_SPECS lookup for X-ray geometry. */
  gt4Lookup: (name: string) => GT4SpecLike | undefined;
  /** H511: true when the player is on an active PARAMEDIC shift
   *  (LIFE.playerJob === 'PARAMEDIC' && LIFE.job && !LIFE.jobDoneToday).
   *  Flips the ambulance lightbar from its static off-shift palette
   *  to the red/blue alternating-phase animation. Optional —
   *  undefined / false leaves the lightbar in its dim off-shift state,
   *  which is correct for traffic ambulances and for the player when
   *  not on a paramedic call. Closes the deferral documented in H510. */
  paramedicLightsActive?: boolean;
}

/** drawTopCar args matching the 11-arg monolith signature. The split into
 *  `extra` keeps the 11 positional args readable in IDE call hints. */
export interface DrawTopCarArgs {
  cx: number;
  cy: number;
  angle: number;
  color: string;
  isPlayer: boolean;
  steerAngle: number;
  trafBody?: string;
  isCop?: boolean;
  copType?: string;
  isBraking?: boolean;
  trafBikeSprite?: string;
  /** H615: traffic-cop pursuit flag — drives the cruiser lightbar's
   *  blue/white flash. Player-cop pursuits use LIFE.copJob.phase in
   *  the monolith; modular hasn't ported that yet, so this only fires
   *  for AI cops chasing the player. */
  isPursuing?: boolean;
}

/**
 * Per-vehicle render entry. Translates+rotates the ctx, dispatches to one
 * of {bike, ambulance, V2 sprite, V2 vector, legacy bodyType silhouette},
 * restores ctx, and returns.
 *
 * NOTE: The bike, ambulance, and per-bodyType pixel-detail overlays
 * (hood highlights, cop stripes, tow flatbed, semi details, etc.) are
 * stubbed in this commit — see the TODO comments inline. The dispatch
 * + V2 path + traceCarBodyPath silhouette + xray fallback are all
 * present and correct so this can be wired at cutover and progressively
 * fleshed out.
 */
export function drawTopCar(
  ctx: CanvasRenderingContext2D,
  args: DrawTopCarArgs,
  deps: DrawTopCarDeps,
): void {
  const { cx, cy, angle, color, isPlayer, steerAngle: sa,
          trafBody, isBraking } = args;
  const { player, hour, getVehicleSprite, hasVehicleSprite,
          spriteBuffer, gt4Lookup } = deps;

  ctx.save();
  const prevPTD = setV2PlayerTailDraw(!!isPlayer);
  ctx.translate(cx, cy);
  ctx.rotate(angle);

  // ---- Size resolution ------------------------------------------------
  const size: readonly [number, number] =
    isPlayer && player ? player.size
    : (trafBody && TRAFFIC_BODY_SIZES[trafBody]) || DEFAULT_BODY_SIZE;
  const L = size[0];
  const W = size[1];
  const bike = isPlayer && player ? player.isBike : trafBody === 'bike';
  const amb = isPlayer && player ? player.name === 'Ambulance' : false;

  const nf = computeNightFactor(hour);
  const brk = !!isBraking;

  // ---- V2 check -------------------------------------------------------
  let v2GenId: string | null = null;
  if (isPlayer && !bike && !amb && player) {
    v2GenId = getCarGeneration(player.name);
  }

  // ---- Dispatch -------------------------------------------------------
  if (bike) {
    drawBikeStub(ctx, L, W, sa, isPlayer, args, deps, nf, brk);
  } else if (amb) {
    drawAmbulanceStub(ctx, L, W, args, deps, nf, brk);
  } else {
    drawCarPath(ctx, L, W, color, sa, isPlayer, v2GenId, args, deps, nf, brk);
  }

  // ---- Restore --------------------------------------------------------
  setV2PlayerTailDraw(prevPTD);
  ctx.restore();
}

// ---- Bike dispatch (sprite hook + vector fallback stub) -------------------

function drawBikeStub(
  ctx: CanvasRenderingContext2D,
  L: number,
  W: number,
  steerAngle: number,
  isPlayer: boolean,
  args: DrawTopCarArgs,
  deps: DrawTopCarDeps,
  _nf: number,
  _brk: boolean,
): void {
  const { player, getVehicleSprite, hasVehicleSprite, spriteBuffer, gt4Lookup } = deps;
  const xray = isPlayer && player ? player.xrayBody : false;

  // Sprite hook (Ninja / CB500 / Bandit / Katana).
  let bikeSpriteKey: string | null = null;
  if (isPlayer && player) {
    const nm = player.name;
    if (nm.includes('Kawasaki Ninja')) bikeSpriteKey = 'kawasaki_ninja';
    else if (nm.includes('CB500'))     bikeSpriteKey = 'honda_cb500';
    else if (nm.includes('Bandit'))    bikeSpriteKey = 'suzuki_bandit';
    else if (nm.includes('Katana'))    bikeSpriteKey = 'suzuki_katana';
  } else if (args.trafBikeSprite) {
    bikeSpriteKey = args.trafBikeSprite;
  }

  // H620 — X-Ray bike render (yellow tires + dashed cyan silhouette).
  // 1:1 with monolith L40427-L40485. Fires before the sprite path because
  // X-Ray overrides the sprite (the sprite hook already gates on !xray).
  // Uses xrayBikeGeom for per-bike axle positions (Ninja's actual 0.671×L
  // wheelbase, etc.) instead of the legacy hardcoded ~0.77×L that
  // overstated every bike's wheelbase by ~15%.
  if (xray) {
    const isCruiser = isPlayer && player ? player.name.includes('Harley') : false;
    const bw = isCruiser ? W * 0.55 : W * 0.40;
    const bikeGeom = xrayBikeGeom(
      isPlayer && player ? player.name : null,
      bikeSpriteKey,
      L,
      gt4Lookup,
    );
    if (bikeGeom) {
      drawXrayBikeTiresFromGeom(ctx, bikeGeom, steerAngle);
    }
    // Dashed cyan silhouette — same path as the body shadow.
    ctx.strokeStyle = 'rgba(0,255,255,0.35)';
    ctx.lineWidth = 0.5;
    ctx.setLineDash([2, 2]);
    ctx.beginPath();
    if (isCruiser) {
      ctx.ellipse(0, 0, L * 0.48, bw * 0.9, 0, 0, Math.PI * 2);
    } else {
      const hl = L / 2;
      ctx.moveTo(-hl, -bw * 0.3);
      ctx.lineTo(-hl + L * 0.15, -bw * 0.55);
      ctx.lineTo(hl - L * 0.1, -bw * 0.55);
      ctx.quadraticCurveTo(hl, -bw * 0.3, hl, 0);
      ctx.quadraticCurveTo(hl, bw * 0.3, hl - L * 0.1, bw * 0.55);
      ctx.lineTo(-hl + L * 0.15, bw * 0.55);
      ctx.lineTo(-hl, bw * 0.3);
      ctx.closePath();
    }
    ctx.stroke();
    ctx.setLineDash([]);
    return;
  }

  if (bikeSpriteKey && !xray && hasVehicleSprite(bikeSpriteKey)) {
    const sprite = getVehicleSprite(bikeSpriteKey);
    if (sprite) {
      const smPrev = ctx.imageSmoothingEnabled;
      // H725: nearest-neighbor sprite scaling — pairs with H723's
      // image-rendering:pixelated CSS so sprites stay crisp
      // through the entire pipeline.
      ctx.imageSmoothingEnabled = false;
      const sb = spriteBuffer[bikeSpriteKey];
      if (sb) {
        const bL = L * sb[0];
        const bW = W * sb[1];
        ctx.drawImage(sprite, -bL / 2, -bW / 2, bL, bW);
      } else {
        ctx.drawImage(sprite, -L / 2, -W / 2, L, W);
      }
      ctx.imageSmoothingEnabled = smPrev;
      return;
    }
  }

  // H614: simplified vector bike body. The full monolith versions are
  // ~150 (cruiser) + ~320 (sport) lines with lean compensation, rider,
  // fairing details, and night lighting (L40508-40903). For the
  // no-sprite fallback the player encounters in this build (the
  // sprites/ folder ships empty), what matters is just "looks like a
  // motorbike from above," not pixel parity with the monolith.
  //
  // Layout: rear tire (lower-half), engine, fuel tank (paint color),
  // seat (dark), front tire (upper-half), and either a pointed sport
  // fairing or a round cruiser headlight depending on whether the
  // player name says Harley. Tires render BEFORE body so the body
  // sits on top, matching the monolith's z-order.
  const color = args.color;
  const isCruiser = isPlayer && player ? player.name.includes('Harley') : false;
  const bw = isCruiser ? W * 0.55 : W * 0.40;
  // Tires — perpendicular black ovals at front + rear axle.
  const rearAxleX = -L * 0.40;
  const frontAxleX = L * 0.38;
  const tireW = L * 0.10;
  const tireH = bw * 0.95;
  ctx.fillStyle = '#0a0a0a';
  ctx.beginPath();
  ctx.ellipse(rearAxleX, 0, tireW, tireH, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(frontAxleX, 0, tireW, tireH * 0.85, 0, 0, Math.PI * 2);
  ctx.fill();
  // Engine block — chrome between the wheels.
  ctx.fillStyle = isCruiser ? '#9a9a9a' : '#666';
  ctx.fillRect(-L * 0.08, -bw * 0.5, L * 0.20, bw);
  // Fuel tank — paint color teardrop just forward of center.
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.ellipse(L * 0.06, 0, L * 0.20, bw * 0.55, 0, 0, Math.PI * 2);
  ctx.fill();
  // Seat — dark behind the tank.
  ctx.fillStyle = '#1a1a1a';
  ctx.beginPath();
  ctx.ellipse(-L * 0.15, 0, L * 0.18, bw * (isCruiser ? 0.65 : 0.50), 0, 0, Math.PI * 2);
  ctx.fill();
  // Front fairing / headlight.
  if (isCruiser) {
    // Round headlight nacelle.
    ctx.fillStyle = '#ccc';
    ctx.beginPath();
    ctx.arc(L * 0.45, 0, bw * 0.28, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffd';
    ctx.beginPath();
    ctx.arc(L * 0.45, 0, bw * 0.17, 0, Math.PI * 2);
    ctx.fill();
  } else {
    // Pointed sport fairing in paint color.
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(L * 0.30, -bw * 0.50);
    ctx.lineTo(L * 0.50, 0);
    ctx.lineTo(L * 0.30, bw * 0.50);
    ctx.closePath();
    ctx.fill();
    // Windscreen — translucent blue.
    ctx.fillStyle = 'rgba(160,190,220,0.55)';
    ctx.fillRect(L * 0.32, -bw * 0.30, L * 0.10, bw * 0.60);
  }
}

// ---- Ambulance dispatch (sprite hook + vector body stub) ------------------

function drawAmbulanceStub(
  ctx: CanvasRenderingContext2D,
  L: number,
  W: number,
  _args: DrawTopCarArgs,
  deps: DrawTopCarDeps,
  nf: number,
  brk: boolean,
): void {
  const { player, getVehicleSprite, hasVehicleSprite, spriteBuffer, gt4Lookup } = deps;
  const xray = player ? player.xrayBody : false;

  // X-ray mode: yellow tires from GT4 spec + dashed cyan rectangle.
  if (xray) {
    const ambGeom = xrayCarGeom('Ambulance', null, L, W, gt4Lookup);
    if (ambGeom) drawXrayTiresFromGeom(ctx, ambGeom, player ? player.steerAngle : 0);
    ctx.strokeStyle = 'rgba(0,255,255,0.35)';
    ctx.lineWidth = 0.5;
    ctx.setLineDash([2, 2]);
    ctx.strokeRect(-L / 2, -W / 2, L, W);
    ctx.setLineDash([]);
    return;
  }

  // PNG sprite hook.
  if (hasVehicleSprite('ambulance')) {
    const sprite = getVehicleSprite('ambulance');
    if (sprite) {
      const smPrev = ctx.imageSmoothingEnabled;
      // H725: nearest-neighbor sprite scaling — pairs with H723's
      // image-rendering:pixelated CSS so sprites stay crisp
      // through the entire pipeline.
      ctx.imageSmoothingEnabled = false;
      const sb = spriteBuffer.ambulance;
      if (sb) {
        const bL = L * sb[0];
        const bW = W * sb[1];
        ctx.drawImage(sprite, -bL / 2, -bW / 2, bL, bW);
      } else {
        ctx.drawImage(sprite, -L / 2, -W / 2, L, W);
      }
      ctx.imageSmoothingEnabled = smPrev;
      return;
    }
  }

  // H510: vector ambulance body (1:1 port of monolith L40824-L40963).
  // Cab + box + 7-light lightbar (static off-shift colors) + red cross +
  // bumper step + side hinges + headlights + taillights. Lightbar BLINK
  // animation (red/blue alternating phase) requires LIFE.playerJob ===
  // 'PARAMEDIC' && active job — those flags aren't yet threaded through
  // DrawTopCarDeps; deferred to a follow-up hop that adds a
  // `paramedicLightsActive?: boolean` flag to the deps interface and
  // wires it from gameLoop. Until then the lightbar paints in its dim
  // off-shift colors (3 dim-red on the left, 1 dim-yellow center, 3
  // dim-blue on the right) — visually correct for ambulances in traffic
  // and for the player when not on a paramedic shift.
  const hl = L / 2;
  const hw = W / 2;
  const cabLen = L * 0.3;       // cab is ~30% of total length
  const cabHW = hw * 0.82;      // cab narrower than box

  // Box body (rear 72% of length, full width)
  ctx.fillStyle = '#f0f0f0';
  ctx.fillRect(-hl, -hw, L * 0.72, W);
  ctx.strokeStyle = '#888';
  ctx.lineWidth = 0.5;
  ctx.strokeRect(-hl, -hw, L * 0.72, W);

  // Cab body (front 30%, narrower than box)
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(hl - cabLen, -cabHW, cabLen, cabHW * 2);

  // Cab windshield (tinted glass)
  ctx.fillStyle = 'rgba(100,160,220,0.5)';
  ctx.fillRect(hl - cabLen * 0.2, -cabHW * 0.85, cabLen * 0.15, cabHW * 1.7);

  // Cab roof (darker top to read as a separate surface from windows)
  ctx.fillStyle = '#ddd';
  ctx.fillRect(hl - cabLen * 0.75, -cabHW * 0.7, cabLen * 0.5, cabHW * 1.4);

  // 3 vents on cab roof (behind windshield)
  ctx.fillStyle = '#555';
  for (let i = -1; i <= 1; i++) {
    ctx.fillRect(hl - cabLen * 0.5, cabHW * i * 0.4 - 0.8, 1.5, 1.6);
  }

  // 7-light lightbar across cab roof. H511 wires the
  // paramedicLightsActive flag: when true, each of the 7 cells phase-
  // blinks red↔blue via `sin(Date.now()×0.015 + i×0.9)` — gives the
  // characteristic asymmetric staggered cadence the monolith emits at
  // L40908-L40912. When false (off-shift, or any traffic ambulance),
  // the static off-shift palette (dim-red / dim-yellow / dim-blue)
  // paints instead — visually correct for parked / non-emergency state.
  const lbX = hl - cabLen * 0.35;
  const lbW = cabHW * 1.6;
  const lightsActive = !!deps.paramedicLightsActive;
  const blinkNow = lightsActive ? Date.now() : 0;
  for (let i = 0; i < 7; i++) {
    const lx = lbX;
    const ly = -lbW / 2 + lbW * i / 6;
    if (lightsActive) {
      const phase = Math.sin(blinkNow * 0.015 + i * 0.9);
      ctx.fillStyle = phase > 0 ? '#ff0000' : '#0044ff';
    } else {
      // Off-state palette: dim-red outer left (3), dim-yellow center (1),
      // dim-blue outer right (3). Matches monolith's `i<3 ? '#663333' :
      // (i>3 ? '#333366' : '#666633')` at L40914.
      ctx.fillStyle = i < 3 ? '#663333' : (i > 3 ? '#333366' : '#666633');
    }
    ctx.fillRect(lx - 0.8, ly - 0.6, 1.6, 1.2);
  }

  // Side mirrors (fold-out tow mirrors, characteristic of the chassis)
  ctx.fillStyle = '#333';
  ctx.fillRect(hl - cabLen * 0.3, -cabHW - 2, 1.5, 2.5);
  ctx.fillRect(hl - cabLen * 0.3, cabHW - 0.5, 1.5, 2.5);

  // Red cross on box roof — vertical bar + horizontal bar centered
  ctx.fillStyle = '#cc0000';
  ctx.fillRect(-hl + L * 0.15, -1.5, L * 0.35, 3);          // horizontal
  ctx.fillRect(-hl + L * 0.3, -hw * 0.4, 3, hw * 0.8);      // vertical

  // Rear bumper step (silver, protrudes slightly past the back of box)
  ctx.fillStyle = '#777';
  ctx.fillRect(-hl - 1, -hw * 0.7, 2, hw * 1.4);

  // Side hinges — 4 dark squares marking the cargo-door corners
  ctx.fillStyle = '#444';
  ctx.fillRect(-hl + L * 0.05, -hw - 0.5, 1, 1);
  ctx.fillRect(-hl + L * 0.05, hw - 0.5, 1, 1);
  ctx.fillRect(-hl + L * 0.35, -hw - 0.5, 1, 1);
  ctx.fillRect(-hl + L * 0.35, hw - 0.5, 1, 1);

  // Front headlights — warm yellow pair on each side of cab face
  ctx.fillStyle = '#ffee88';
  ctx.fillRect(hl - 1, -cabHW * 0.7, 1.5, 2);
  ctx.fillRect(hl - 1, cabHW * 0.7 - 2, 1.5, 2);

  // Rear taillights — bright red when braking, dimmer at night, near-
  // black during day. Per-side pair (taillight + amber turn indicator).
  // _brk is the brake-active flag; _nf the night factor from caller.
  ctx.fillStyle = brk ? '#f44' : (nf > 0.05 ? '#ff3300' : '#800');
  ctx.fillRect(-hl - 0.5, -hw * 0.85, 1.5, 2);
  ctx.fillRect(-hl - 0.5, hw * 0.85 - 2, 1.5, 2);
  ctx.fillStyle = brk ? '#fa4' : (nf > 0.05 ? '#ff8800' : '#840');
  ctx.fillRect(-hl - 0.5, -hw * 0.85 + 2, 1, 1.5);
  ctx.fillRect(-hl - 0.5, hw * 0.85 - 3.5, 1, 1.5);
}

// ---- Car dispatch (V2 sprite → V2 vector → legacy bodyType fallback) ------

function drawCarPath(
  ctx: CanvasRenderingContext2D,
  L: number,
  W: number,
  color: string,
  steerAngle: number,
  isPlayer: boolean,
  v2GenId: string | null,
  args: DrawTopCarArgs,
  deps: DrawTopCarDeps,
  nf: number,
  brk: boolean,
): void {
  const { player, getVehicleSprite, hasVehicleSprite, spriteBuffer, gt4Lookup } = deps;
  const hl = L / 2;
  const hw = W / 2;
  const isV2 = !!v2GenId;
  const xrayToggle = isPlayer && player ? player.xrayBody : false;
  const hlUp = nf > 0.2;
  const isReverse = isPlayer && player ? player.isReverse : false;

  // ---- V2 path -------------------------------------------------------
  if (isV2 && v2GenId) {
    const v2HasSprite = hasVehicleSprite(v2GenId);
    const v2Sprite = (v2HasSprite && !xrayToggle)
      ? getVehicleSprite(v2GenId, hlUp, color) : null;
    if (v2Sprite) {
      const smPrev = ctx.imageSmoothingEnabled;
      // H725: nearest-neighbor sprite scaling — pairs with H723's
      // image-rendering:pixelated CSS so sprites stay crisp
      // through the entire pipeline.
      ctx.imageSmoothingEnabled = false;
      const sb = spriteBuffer[v2GenId];
      if (sb) {
        const bL = L * sb[0];
        const bW = W * sb[1];
        ctx.drawImage(v2Sprite, -bL / 2, -bW / 2, bL, bW);
      } else {
        ctx.drawImage(v2Sprite, -L / 2, -W / 2, L, W);
      }
      ctx.imageSmoothingEnabled = smPrev;
      return;
    }
    // v126.89: sprite-less player cars auto-X-Ray (skid marks align to GT4 geom).
    const xrayV2 = isPlayer && (xrayToggle || !v2HasSprite);
    drawCarBodyV2(ctx, v2GenId, L, W, color, {
      isPlayer, isBraking: brk, nightFactor: nf, isReverse,
      steerAngle, isXray: xrayV2,
      carName: isPlayer && player ? player.name : undefined,
    });
    return;
  }

  // ---- Legacy bodyType silhouette ----------------------------------------
  const bodyType = isPlayer && player
    ? resolveLegacyBodyType(player.name)
    : (args.trafBody || 'sedan');

  // H634: revert H621's player-only auto-X-Ray gate — back to the
  // monolith's behavior (force X-Ray for ANY car without a loaded
  // sprite). H621 reasoned that vector + the new H615-H618 per-bodyType
  // detail rendered better than X-Ray for traffic in empty-sprites
  // builds; the reality is that drawing ~30 traffic cars through the
  // full vector path (traceCarBodyPath Path2D build + ground shadow +
  // wheels + per-bodyType fillRect chain ≈ 30+ ops/car) tanked PC FPS
  // to single digits. The monolith never paid this cost because it
  // shipped with PNG sprites; the modular sprites/ folder is empty,
  // so the X-Ray fallback is the perf-correct default.
  //
  // The H615-H618 per-bodyType detail still renders when sprites ARE
  // loaded — both vectors are present in the `else` branch below
  // (sprite path returns early, vector fallback retains all detail).
  // Players who drop PNGs into sprites/ get the detail back without
  // re-editing this gate.
  const xray = xrayToggle || !hasVehicleSprite(bodyType);

  // Ground shadow (skip in xray).
  if (!xray) {
    v2GroundShadow(ctx, (c, h, w, l, wd) => traceCarBodyPath(c, bodyType, h, w, l, wd), hl, hw, L, W);
  }

  // Wheels — try GT4 geom first, else legacy axle table.
  if (xray && bodyType !== 'semi') {
    const playerName = isPlayer && player ? player.name : null;
    const geom = xrayCarGeom(playerName, bodyType, L, W, gt4Lookup);
    if (geom) {
      drawXrayTiresFromGeom(ctx, geom, steerAngle);
    } else {
      drawLegacyWheels(ctx, bodyType, hl, hw, L, steerAngle, xray);
    }
  } else if (bodyType !== 'semi') {
    drawLegacyWheels(ctx, bodyType, hl, hw, L, steerAngle, xray);
  }

  // Body.
  if (xray) {
    ctx.save();
    traceCarBodyPath(ctx, bodyType, hl, hw, L, W);
    ctx.strokeStyle = 'rgba(0,255,255,0.35)';
    ctx.lineWidth = 0.5;
    ctx.setLineDash([2, 2]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();

    // Body damage heatmap (player only).
    if (isPlayer && player) {
      ctx.save();
      traceCarBodyPath(ctx, bodyType, hl, hw, L, W);
      ctx.clip();
      drawXrayDamageOverlay(ctx, hl, hw, player.bodyDamage);
      ctx.restore();
    }
  } else {
    // PNG sprite hook.
    const sprite = getVehicleSprite(bodyType, hlUp, color);
    if (sprite) {
      const smPrev = ctx.imageSmoothingEnabled;
      // H725: nearest-neighbor sprite scaling — pairs with H723's
      // image-rendering:pixelated CSS so sprites stay crisp
      // through the entire pipeline.
      ctx.imageSmoothingEnabled = false;
      const sb = spriteBuffer[bodyType];
      if (sb) {
        const bL = L * sb[0];
        const bW = W * sb[1];
        ctx.drawImage(sprite, -bL / 2, -bW / 2, bL, bW);
      } else {
        ctx.drawImage(sprite, -L / 2, -W / 2, L, W);
      }
      ctx.imageSmoothingEnabled = smPrev;
    } else {
      // Vector fallback — fill silhouette + black outline + per-bodyType
      // pixel detail. The remaining bodyType overlays (full set at
      // monolith L41269-42012: hood highlights, cabin greenhouse, tow
      // flatbed + winch + amber lightbar, semi exhaust stacks, box truck
      // roll-up door etc.) are still TODO and follow this same pattern.
      traceCarBodyPath(ctx, bodyType, hl, hw, L, W);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.5)';
      ctx.lineWidth = 0.8;
      ctx.stroke();

      // H615 — cruiser CMPD detail (cop cars). 1:1 with monolith L41437-
      // L41459 in intent: windshield + rear glass + push bar at front +
      // lightbar on roof. Lightbar flashes blue/white during a pursuit
      // (args.isPursuing) and reads as a static dark bar otherwise.
      // Player-cop's LIFE.copJob phase trigger is NOT wired (the copJob
      // sim hasn't ported); flash only fires for AI cops on a chase.
      // H618 — center specular highlight (metallic paint line down the
      // body center). Skipped on trucks since their cab/cargo split has
      // its own contrast. 1:1 with monolith L41225-L41229.
      if (
        bodyType !== 'boxtruck' &&
        bodyType !== 'semi' &&
        bodyType !== 'towtruck'
      ) {
        ctx.fillStyle = lighten(color, 0.35);
        ctx.fillRect(-hl * 0.4, -0.6, L * 0.55, 1.2);
      }

      // H618 — hood highlights for sports / mid-engine / roadster / race /
      // SUV / pickup bodyTypes. 1:1 with monolith L41231-L41241. Each
      // branch carves a lighter rectangle over the front of the body so
      // the silhouette reads as "hood + cabin" rather than a flat slab.
      // The remaining cruiser/towtruck hood highlights live inside their
      // own branches below alongside the rest of that bodyType's detail.
      ctx.fillStyle = lighten(color, 0.15);
      if (
        bodyType === 'viper' || bodyType === 'corvette' ||
        bodyType === 'camaro' || bodyType === 'mustang' || bodyType === 'gto'
      ) {
        ctx.fillRect(hl * 0.25, -hw * 0.65, hl * 0.7, W * 0.65);
      } else if (bodyType === 'nsx' || bodyType === 'mr2') {
        ctx.fillRect(hl * 0.35, -hw * 0.5, hl * 0.55, W * 0.5);
      } else if (bodyType === 'roadster') {
        ctx.fillRect(hl * 0.15, -hw * 0.8, hl * 0.8, W * 0.8);
      } else if (bodyType === 'race') {
        ctx.fillRect(hl * 0.15, -hw * 0.6, hl * 0.8, W * 0.6);
      } else if (bodyType === 'suv' || bodyType === 'pickup') {
        ctx.fillRect(hl * 0.35, -hw * 0.7, hl * 0.55, W * 0.7);
      }

      if (bodyType === 'boxtruck') {
        // H616 — boxtruck cab detail. 1:1 with monolith L41462-L41475.
        // Short wide cab at the front, then the cargo box behind. The
        // box itself is the silhouette fill above; this overlay just
        // distinguishes the cab from the box.
        ctx.fillStyle = 'rgba(60,80,110,0.85)';
        ctx.fillRect(hl * 0.55, -hw * 0.82, L * 0.04, W * 0.82);
        ctx.fillStyle = 'rgba(80,140,200,0.4)';
        ctx.fillRect(hl * 0.4, -hw * 0.88, hl * 0.15, 1.5);
        ctx.fillRect(hl * 0.4, hw * 0.88 - 1.5, hl * 0.15, 1.5);
        ctx.fillStyle = darken(color, 0.15);
        ctx.fillRect(hl * 0.35, -hw * 0.72, hl * 0.25, W * 0.72);
        // Side mirrors stick out past the cab.
        ctx.fillStyle = '#333';
        ctx.fillRect(hl * 0.45, -hw * 0.92 - 1.5, 1.5, 2);
        ctx.fillRect(hl * 0.45, hw * 0.92 - 0.5, 1.5, 2);
      } else if (bodyType === 'semi') {
        // H616 — semi tractor cab detail. 1:1 with monolith L41476-L41497.
        // Windshield, side windows, cab roof, sleeper, rear window, air
        // horns, sun visor.
        ctx.fillStyle = 'rgba(60,80,110,0.85)';
        ctx.fillRect(hl * 0.52, -hw * 0.85, L * 0.04, W * 0.85);
        ctx.fillStyle = 'rgba(80,140,200,0.4)';
        ctx.fillRect(hl * 0.15, -hw + 0.5, hl * 0.35, 2);
        ctx.fillRect(hl * 0.15, hw - 2.5, hl * 0.35, 2);
        ctx.fillStyle = darken(color, 0.15);
        ctx.fillRect(-hl * 0.15, -hw * 0.8, hl * 0.65, W * 0.8);
        ctx.fillStyle = darken(color, 0.25);
        ctx.fillRect(-hl * 0.2, -hw * 0.75, hl * 0.12, W * 0.75);
        ctx.fillStyle = 'rgba(60,100,160,0.35)';
        ctx.fillRect(-hl * 0.21, -hw * 0.5, L * 0.015, W * 0.5);
        ctx.fillStyle = '#888';
        ctx.fillRect(hl * 0.48, -2, 4, 1);
        ctx.fillRect(hl * 0.48, 1, 4, 1);
        ctx.fillStyle = '#555';
        ctx.fillRect(hl * 0.5, -hw * 0.75, L * 0.025, W * 0.75);
      } else if (bodyType === 'towtruck') {
        // H616 — towtruck detail. 1:1 with monolith L41243-L41276.
        // Cab hood + steel flatbed deck with diamond-plate stripes,
        // bed edge rails, winch behind cab, wheel chocks, ramp hinge,
        // rear tow hooks, flashing amber warning bar.
        //
        // H618 fixed the cab-hood color to lighten(color, 0.15) per
        // monolith — the earlier port used the base color, which made
        // the cab visually merge with the flatbed at low zoom.
        ctx.fillStyle = lighten(color, 0.15);
        ctx.fillRect(hl * 0.4, -hw * 0.55, hl * 0.5, W * 0.55);
        ctx.fillStyle = '#3a3a3a';
        ctx.fillRect(-hl + L * 0.02, -hw * 0.9, hl * 1.3, W * 0.9);
        ctx.strokeStyle = '#4a4a4a';
        ctx.lineWidth = 0.3;
        for (let i = -hl + L * 0.06; i < hl * 0.35; i += L * 0.05) {
          ctx.beginPath();
          ctx.moveTo(i, -hw * 0.85);
          ctx.lineTo(i, hw * 0.85);
          ctx.stroke();
        }
        ctx.fillStyle = '#555';
        ctx.fillRect(-hl + L * 0.02, -hw * 0.92, hl * 1.3, 1.5);
        ctx.fillRect(-hl + L * 0.02, hw * 0.92 - 1.5, hl * 1.3, 1.5);
        // Winch.
        ctx.fillStyle = '#666';
        ctx.fillRect(hl * 0.25, -hw * 0.25, L * 0.05, W * 0.25);
        ctx.fillStyle = '#888';
        ctx.beginPath();
        ctx.arc(hl * 0.28, 0, 1.5, 0, Math.PI * 2);
        ctx.fill();
        // Wheel chocks + ramp hinge + tow hooks.
        ctx.fillStyle = '#555';
        ctx.fillRect(-hl * 0.1, -hw * 0.7, L * 0.02, W * 0.15);
        ctx.fillRect(-hl * 0.1, hw * 0.55, L * 0.02, W * 0.15);
        ctx.fillStyle = '#4a4a4a';
        ctx.fillRect(-hl, -hw * 0.85, L * 0.03, W * 0.85);
        ctx.fillStyle = '#777';
        ctx.beginPath();
        ctx.arc(-hl + 1, -hw * 0.75, 1, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(-hl + 1, hw * 0.75, 1, 0, Math.PI * 2);
        ctx.fill();
        // Flashing amber warning bar on cab roof.
        const tFlash = Math.floor(Date.now() / 300) % 2;
        ctx.fillStyle = tFlash ? '#ff8800' : '#cc6600';
        ctx.fillRect(hl * 0.15, -hw * 0.35, L * 0.08, W * 0.35);
      } else if (bodyType === 'cruiser') {
        // H618 — cruiser hood highlight (1:1 monolith L41278). Lighter
        // rectangle over the front 60% of the body so the white CMPD
        // reads as "hood + cabin + lightbar" instead of a flat block.
        ctx.fillStyle = lighten(color, 0.15);
        ctx.fillRect(hl * 0.3, -hw * 0.65, hl * 0.6, W * 0.65);
        // Windshield + rear glass — paint-darken instead of glass-blue
        // since the monolith reads as "matte interior" on white CMPDs.
        ctx.fillStyle = 'rgba(60,80,110,0.85)';
        ctx.fillRect(hl * 0.15, -hw * 0.6, L * 0.09, W * 0.6);
        ctx.fillRect(-hl * 0.3, -hw * 0.5, L * 0.07, W * 0.5);
        // Roof — slightly darker than body so it reads against white CMPD.
        ctx.fillStyle = 'rgba(0,0,0,0.18)';
        ctx.fillRect(-hl * 0.22, -hw * 0.55, hl * 0.37, W * 0.55);
        // Push bar — black bumper guard at the front edge.
        ctx.fillStyle = '#333';
        ctx.fillRect(hl - 2, -hw * 0.5, 3, W * 0.5);
        // Roof lightbar.
        const lbW2 = L * 0.20;
        const lbX2 = -lbW2 / 2 + L * 0.06;
        if (args.isPursuing) {
          const cFlash = Math.floor(Date.now() / 150) % 4;
          if (cFlash < 2) {
            ctx.fillStyle = '#0066ff';
            ctx.fillRect(lbX2, -2, lbW2 / 2, 4);
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(lbX2 + lbW2 / 2, -2, lbW2 / 2, 4);
          } else {
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(lbX2, -2, lbW2 / 2, 4);
            ctx.fillStyle = '#0066ff';
            ctx.fillRect(lbX2 + lbW2 / 2, -2, lbW2 / 2, 4);
          }
        } else {
          ctx.fillStyle = '#333';
          ctx.fillRect(lbX2, -2, lbW2, 4);
        }
      } else if (bodyType === 'silvia') {
        // H617 — 180SX/Silvia: hatch greenhouse with large rear glass.
        // 1:1 with monolith L41498-L41504.
        ctx.fillStyle = 'rgba(60,80,110,0.85)';
        ctx.fillRect(hl * 0.08, -hw * 0.65, L * 0.10, W * 0.65);
        ctx.fillRect(-hl * 0.45, -hw * 0.70, L * 0.12, W * 0.70);
        ctx.fillStyle = darken(color, 0.20);
        ctx.fillRect(-hl * 0.32, -hw * 0.60, hl * 0.40, W * 0.60);
      } else if (bodyType === 'civic99') {
        // H617 — 1999 Civic Coupe: compact raked greenhouse, no sunroof.
        // 1:1 with monolith L41505-L41518.
        ctx.fillStyle = 'rgba(60,80,110,0.85)';
        ctx.fillRect(hl * 0.18, -hw * 0.55, L * 0.07, W * 0.55);
        ctx.fillRect(-hl * 0.40, -hw * 0.50, L * 0.07, W * 0.50);
        ctx.fillStyle = darken(color, 0.20);
        ctx.fillRect(-hl * 0.33, -hw * 0.55, hl * 0.51, W * 0.55);
      } else if (bodyType === 'accord99') {
        // H617 — 1999 Accord Sedan: full greenhouse + sunroof + B-pillar
        // + wiper arms + diagonal sun-glare across each glass panel.
        // 1:1 with monolith L41519-L41571.
        ctx.fillStyle = 'rgba(60,80,110,0.85)';
        ctx.fillRect(hl * 0.16, -hw * 0.62, L * 0.085, W * 0.62);
        ctx.fillRect(-hl * 0.38, -hw * 0.58, L * 0.085, W * 0.58);
        ctx.fillStyle = darken(color, 0.20);
        ctx.fillRect(-hl * 0.30, -hw * 0.62, hl * 0.46, W * 0.62);
        // Sunroof — dark tinted glass mid-roof.
        ctx.fillStyle = '#1a2532';
        ctx.fillRect(-hl * 0.08, -hw * 0.32, hl * 0.18, W * 0.32);
        // B-pillar — subtle vertical strip showing the 4-door split.
        ctx.fillStyle = darken(color, 0.30);
        ctx.fillRect(-hl * 0.04, -hw * 0.62, 0.5, W * 0.62);
        // Wiper arms — two diagonal strokes at the cowl line.
        const prevCap = ctx.lineCap;
        ctx.strokeStyle = '#181818';
        ctx.lineWidth = 0.45;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(hl * 0.245, -hw * 0.50);
        ctx.lineTo(hl * 0.165, -hw * 0.05);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(hl * 0.245, hw * 0.50);
        ctx.lineTo(hl * 0.165, hw * 0.05);
        ctx.stroke();
        ctx.lineCap = prevCap;
        // Sun-glare stripes — uniform diagonal across windshield + sunroof + rear.
        ctx.strokeStyle = 'rgba(245,250,255,0.55)';
        ctx.lineWidth = 0.55;
        ctx.beginPath();
        ctx.moveTo(hl * 0.22, -hw * 0.45);
        ctx.lineTo(hl * 0.165, hw * 0.30);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(hl * 0.07, -hw * 0.20);
        ctx.lineTo(hl * 0.02, hw * 0.10);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(-hl * 0.32, -hw * 0.42);
        ctx.lineTo(-hl * 0.37, hw * 0.28);
        ctx.stroke();
      } else {
        // H617 — generic sedan/sport-compact greenhouse. 1:1 with the
        // `else` branch at monolith L41572-L41578. Smaller rear window
        // than civic99/accord99 to read as a "generic" silhouette.
        ctx.fillStyle = 'rgba(60,80,110,0.85)';
        ctx.fillRect(hl * 0.15, -hw * 0.60, L * 0.08, W * 0.60);
        ctx.fillRect(-hl * 0.30, -hw * 0.45, L * 0.06, W * 0.45);
        ctx.fillStyle = darken(color, 0.20);
        ctx.fillRect(-hl * 0.22, -hw * 0.50, hl * 0.37, W * 0.50);
      }
      // H617 — GBC-era glass glint sparkle on every non-truck body.
      // 1:1 with monolith L41579-L41583. Tiny bright dot on the
      // windshield reads as a single specular highlight.
      if (
        bodyType !== 'semi' &&
        bodyType !== 'boxtruck' &&
        bodyType !== 'towtruck'
      ) {
        ctx.fillStyle = 'rgba(255,255,255,0.75)';
        ctx.fillRect(hl * 0.12, -hw * 0.25, 1.2, 1.2);
      }
    }
  }
}

/** Legacy wheel renderer using the bodyType axle table. Front pair
 *  rotates with steerAngle. */
function drawLegacyWheels(
  ctx: CanvasRenderingContext2D,
  bodyType: string,
  hl: number,
  hw: number,
  L: number,
  steerAngle: number,
  xray: boolean,
): void {
  const axle = LEGACY_WB_FRACTIONS[bodyType] || LEGACY_WB_FRACTIONS.sedan;
  ctx.fillStyle = xray ? '#ff0' : '#111';
  const wl = L * 0.18;
  const ww = xray ? 3 : 2;
  ctx.fillRect(-hl * axle[1], -hw - (xray ? 0.5 : 0), wl, ww);
  ctx.fillRect(-hl * axle[1],  hw - ww + (xray ? 0.5 : 0), wl, ww);
  ctx.save();
  ctx.translate(hl * axle[0], -hw + ww / 2);
  ctx.rotate(steerAngle);
  ctx.fillRect(-wl / 2, -ww / 2, wl, ww);
  ctx.restore();
  ctx.save();
  ctx.translate(hl * axle[0],  hw - ww / 2);
  ctx.rotate(steerAngle);
  ctx.fillRect(-wl / 2, -ww / 2, wl, ww);
  ctx.restore();
}
