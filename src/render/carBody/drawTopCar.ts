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
import { xrayCarGeom, drawXrayTiresFromGeom } from './xrayGeom';
import { drawXrayDamageOverlay, type BodyDamage } from './damage';

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

/** Per-bodyType physical size (game units). Mirrors L40396-40408 of monolith.
 *  Format: [length, width]. Real-vehicle-derived at ~4.5 game-units/meter.
 *  v8.99.123.21 / .24 / .25 finalized these for sprite-mapped traffic. */
export const TRAFFIC_BODY_SIZES: Readonly<Record<string, readonly [number, number]>> = {
  semi:     [34,   12],
  boxtruck: [33,   11],
  towtruck: [38.5, 11.7],
  bike:     [14,   5],
  civic99:  [20.0, 7.7],   // 1999 Honda Civic Coupe
  accord99: [21.6, 8.0],   // 1999 Honda Accord Sedan
  sedan:    [22.6, 8.34],  // 1996 Ford Taurus GL
  hatch:    [21.3, 8.78],  // 1999 Dodge Caravan SWB
  suv:      [21.3, 8.78],  // 1999 Dodge Caravan SWB (alias)
  pickup:   [23.3, 9.08],  // 1999 Dodge Ram 1500 RegCab
  cruiser:  [24.2, 8.9],   // 1999 Ford Crown Vic P71 (traffic cops)
};

/** Default size when bodyType not in TRAFFIC_BODY_SIZES. */
const DEFAULT_BODY_SIZE: readonly [number, number] = [20, 8];

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

/** Compute night factor [0..1] from hour-of-day. Mirrors L40414. */
export function computeNightFactor(hour: number): number {
  if (hour >= 21 || hour < 5) return 1.0;
  if (hour >= 19)             return (hour - 19) / 2;
  if (hour < 7)               return (7 - hour) / 2;
  if (hour >= 17)             return (hour - 17) / 4 * 0.3;
  return 0;
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
  _steerAngle: number,
  isPlayer: boolean,
  args: DrawTopCarArgs,
  deps: DrawTopCarDeps,
  _nf: number,
  _brk: boolean,
): void {
  const { player, getVehicleSprite, hasVehicleSprite, spriteBuffer } = deps;
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

  if (bikeSpriteKey && !xray && hasVehicleSprite(bikeSpriteKey)) {
    const sprite = getVehicleSprite(bikeSpriteKey);
    if (sprite) {
      const smPrev = ctx.imageSmoothingEnabled;
      ctx.imageSmoothingEnabled = true;
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

  // TODO(C19c-followup): vector bike body. Monolith L40508-40903.
  // Two variants — Harley cruiser (~150 lines) and sport bike (~320 lines).
  // For now, draw a simple oriented rectangle so the bike has SOME shape
  // when no sprite is loaded.
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.fillRect(-L / 2 + 1, -W * 0.35 + 1, L, W * 0.7);
  ctx.fillStyle = '#1a1a1a';
  ctx.fillRect(-L / 2, -W * 0.4, L, W * 0.8);
}

// ---- Ambulance dispatch (sprite hook + vector body stub) ------------------

function drawAmbulanceStub(
  ctx: CanvasRenderingContext2D,
  L: number,
  W: number,
  _args: DrawTopCarArgs,
  deps: DrawTopCarDeps,
  _nf: number,
  _brk: boolean,
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
      ctx.imageSmoothingEnabled = true;
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

  // TODO(C19c-followup): vector ambulance body. Monolith L40966-41028.
  // Cab + box + 7-light lightbar + red cross + bumper + side hinges +
  // headlights + taillights. For now, draw a simple white rectangle
  // with red cross so the ambulance has SOME shape when no PNG.
  ctx.fillStyle = '#f0f0f0';
  ctx.fillRect(-L / 2, -W / 2, L, W);
  ctx.strokeStyle = '#888';
  ctx.lineWidth = 0.5;
  ctx.strokeRect(-L / 2, -W / 2, L, W);
  ctx.fillStyle = '#cc0000';
  ctx.fillRect(-L * 0.05, -W * 0.4, L * 0.1, W * 0.8);
  ctx.fillRect(-L * 0.25, -W * 0.05, L * 0.5, W * 0.1);
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
      ctx.imageSmoothingEnabled = true;
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
      ctx.imageSmoothingEnabled = true;
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
      // Vector fallback — just fill the silhouette + black outline.
      traceCarBodyPath(ctx, bodyType, hl, hw, L, W);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.5)';
      ctx.lineWidth = 0.8;
      ctx.stroke();

      // TODO(C19c-followup): per-bodyType pixel-detail overlays. Monolith
      // L41269-42012 (~750 lines): hood highlights, cabin greenhouse,
      // cop CMPD blue stripes, tow flatbed deck + winch + amber lightbar,
      // semi exhaust stacks + fuel tanks + tandem tires, box truck cargo
      // body + rear roll-up door + reflectors, etc. Each is straight-
      // forward to port but a lot of pixel-level code; deferred to
      // follow-up since the V2 sprite path is the primary visual.
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
