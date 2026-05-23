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
  // H157: per-chassis dims for the legacy bodyType keys (kept as
  // back-compat — H169 routes traffic through V2 genIds below).
  viper:    [20.2, 8.7],   // 1996 Dodge Viper GTS  (4488×1923 mm)
  nsx:      [19.8, 8.1],   // 1991 Acura NSX        (4405×1810 mm)
  rx7:      [19.3, 7.9],   // 1991 Mazda RX-7 FD/FC (4285×1760 mm)
  gtr:      [20.7, 8.0],   // 1999 Skyline GT-R R34 (4600×1785 mm)
  camaro:   [21.9, 8.3],   // 1969 Camaro / Charger / Cuda muscle
  // H169: V2 genId entries so traffic dispatched via
  // spriteFileToBodyType lands on accurate dims AND the manifest's
  // PNG. drawTopCar's legacy-traffic path looks up size by trafBody;
  // without these the V2-keyed traffic would render at the
  // DEFAULT_BODY_SIZE [20, 8] regardless of chassis. Same gu/m ratio
  // as H157 (4.5 gu/m = mm × 0.0045).
  dodge_viper:     [20.2, 8.7],   // 4488×1923 mm
  nsx_na:          [19.8, 8.1],   // 4405×1810 mm
  rx7_fc:          [19.3, 7.9],   // 4290×1760 mm (FC3S)
  rx7_fd:          [19.3, 7.9],   // 4285×1760 mm (FD3S)
  gtr_r34:         [20.7, 8.0],   // 4600×1785 mm
  gtr_r34_vspec:   [20.7, 8.0],
  dodge_charger:   [21.9, 8.3],   // 5232×1948 mm '70 R/T
  dodge_super_bee: [21.9, 8.3],   // 5232×1948 mm '70 Coronet
  plymouth_cuda:   [21.9, 8.3],   // 5008×1880 mm '70 Cuda
  miata_na:        [17.8, 7.5],   // 3950×1675 mm
  silvia:          [20.3, 7.6],   // 4520×1695 mm S13 coupe
  silvia_180sx:    [20.3, 7.6],   // 4520×1695 mm S13 hatch
  ae86:            [18.9, 7.4],   // 4205×1625 mm Levin / Trueno
  audi_quattro:    [19.8, 7.7],   // 4404×1723 mm B2 Ur-Quattro
  ruf_btr:         [20.3, 7.4],   // 4291×1652 mm 911 Carrera 3.2
  ruf_ctr_yb:      [20.3, 7.4],   // 911 G-body
  ruf_ctr2:        [20.4, 7.6],   // 4245×1735 mm 993
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

  // 7-light lightbar across cab roof — static off-shift colors. Blink
  // animation deferred; see hop docstring above for the wiring sketch.
  const lbX = hl - cabLen * 0.35;
  const lbW = cabHW * 1.6;
  for (let i = 0; i < 7; i++) {
    const lx = lbX;
    const ly = -lbW / 2 + lbW * i / 6;
    // Off-state palette: dim-red outer left (3), dim-yellow center (1),
    // dim-blue outer right (3). Matches monolith's `i<3 ? '#663333' :
    // (i>3 ? '#333366' : '#666633')` at L40914.
    ctx.fillStyle = i < 3 ? '#663333' : (i > 3 ? '#333366' : '#666633');
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
