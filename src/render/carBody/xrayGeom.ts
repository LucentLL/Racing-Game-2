/**
 * X-Ray wheel geometry pipeline. When LIFE.gameplaySettings.xrayBody is on,
 * tires are drawn as solid yellow rectangles using REAL per-car geometry
 * sourced from GT4_SPECS (wheelbase, track, tire spec strings) instead of
 * the bodyType-uniform placeholder.
 *
 * Ported from monolith L36813–37008. Three resolver tiers, in order:
 *   1. carName  → GT4_SPECS lookup (player + named entries)
 *   2. bodyType → TRAFFIC_BODYTYPE_SPECS (generic traffic vehicles)
 *   3. bike sprite key → BIKE_FALLBACK_SPECS (player bikes not in GT4)
 *
 * Tire-spec parser handles the three OEM string formats: numeric
 * (`245/60 R15`), ZR speed-rated (`120/60 ZR17`), bias-rated (`150/80 B16`),
 * and motorcycle alpha-numeric (`MT90B16`).
 */

import type {
  GT4SpecLike, TireSpec, CarWheelGeom, BikeWheelGeom,
} from './types';

/** Motorcycle alpha-numeric tire size table (Tire and Rim Association
 *  M-prefix chart). Used by older Harley OEM front fitments. */
const MOTORCYCLE_WIDTH_TABLE: Record<string, number> = {
  H: 90, J: 100, K: 110, L: 115, M: 120, N: 130, P: 140,
  R: 150, T: 130, U: 160, V: 170,
};

export function parseTireSpec(s: string | null | undefined): TireSpec | null {
  if (!s) return null;
  const str = String(s).trim();

  // Numeric: '245/60 R15', 'P225/60 R16', 'LT225/75 R16', '315/80 R22.5',
  // '120/60 ZR17', '150/80 B16'. Alpha prefix (P, LT) is skipped because
  // \d+ matches at the first digit.
  let m = str.match(/(\d+)\s*\/\s*(\d+)\s*Z?[RB]\s*(\d+(?:\.\d+)?)/i);
  if (m) {
    const widMm = parseFloat(m[1]);
    const aspect = parseFloat(m[2]);
    const rimIn = parseFloat(m[3]);
    if (isFinite(widMm) && isFinite(aspect) && isFinite(rimIn)) {
      return { width: widMm, diameter: rimIn * 25.4 + 2 * widMm * (aspect / 100) };
    }
  }

  // Motorcycle alpha-numeric: 'MT90B16' — section width encoded as a letter.
  m = str.match(/^M([HJKLMNPRTUV])\s*(\d+)\s*B\s*(\d+(?:\.\d+)?)/i);
  if (m) {
    const widMm = MOTORCYCLE_WIDTH_TABLE[m[1].toUpperCase()] || 130;
    const aspect = parseFloat(m[2]);
    const rimIn = parseFloat(m[3]);
    if (isFinite(aspect) && isFinite(rimIn)) {
      return { width: widMm, diameter: rimIn * 25.4 + 2 * widMm * (aspect / 100) };
    }
  }

  return null;
}

/** Takes a GT4-shaped spec and produces 4-wheel render geometry in game
 *  units. Shared between the by-name and by-bodyType paths. */
export function xrayWheelGeomFromSpec(
  spec: GT4SpecLike | undefined | null,
  L: number,
  W: number,
): CarWheelGeom | null {
  if (!spec || !spec.lng || !spec.wid || !spec.wb) return null;
  if (!spec.trF || !spec.trR) return null;
  const fT = parseTireSpec(spec.tsF);
  const rT = parseTireSpec(spec.tsR);
  if (!fT || !rT) return null;
  const gpmL = L / spec.lng;
  const gpmW = W / spec.wid;
  const wbG = spec.wb * gpmL;
  return {
    fL: fT.diameter * gpmL,
    fW: fT.width * gpmW,
    rL: rT.diameter * gpmL,
    rW: rT.width * gpmW,
    fAxleX: +wbG / 2,
    rAxleX: -wbG / 2,
    fHalfTrack: (spec.trF * gpmW) / 2,
    rHalfTrack: (spec.trR * gpmW) / 2,
  };
}

/** Traffic / generic-vehicle dimensions for X-ray when no carName is
 *  available. Mirrors real-world fitments — the comments in the original
 *  monolith call out each vehicle the trafBody key represents. */
export const TRAFFIC_BODYTYPE_SPECS: Readonly<Record<string, GT4SpecLike>> = {
  civic99:  { wb: 2620, lng: 4448, wid: 1704, tsF: '195/60 R15',   tsR: '195/60 R15',   trF: 1473, trR: 1473 },
  accord99: { wb: 2715, lng: 4796, wid: 1786, tsF: '205/65 R15',   tsR: '205/65 R15',   trF: 1521, trR: 1521 },
  sedan:    { wb: 2756, lng: 5017, wid: 1854, tsF: '205/65 R15',   tsR: '205/65 R15',   trF: 1565, trR: 1530 },
  hatch:    { wb: 2878, lng: 4732, wid: 1950, tsF: '205/70 R15',   tsR: '205/70 R15',   trF: 1593, trR: 1593 },
  suv:      { wb: 2878, lng: 4732, wid: 1950, tsF: '205/70 R15',   tsR: '205/70 R15',   trF: 1593, trR: 1593 },
  pickup:   { wb: 3505, lng: 5181, wid: 2017, tsF: '245/75 R16',   tsR: '245/75 R16',   trF: 1697, trR: 1697 },
  cruiser:  { wb: 2869, lng: 5385, wid: 1980, tsF: 'P225/60 R16',  tsR: 'P225/60 R16',  trF: 1545, trR: 1555 },
  towtruck: { wb: 2800, lng: 6700, wid: 2438, tsF: '225/70 R19.5', tsR: '225/70 R19.5', trF: 1580, trR: 1580 },
  boxtruck: { wb: 2800, lng: 7300, wid: 2515, tsF: '225/75 R16',   tsR: '225/75 R16',   trF: 1550, trR: 1650 },
  // 'semi' intentionally absent — tandem rear axles + duals don't fit the
  // 4-wheel renderer, so the semi keeps its bespoke draw block.
};

/** Unified resolver: try carName first, then bodyType. Caller passes a
 *  GT4_SPECS lookup function (the database lives in cfg/cars/gt4Database). */
export function xrayCarGeom(
  carName: string | null | undefined,
  bodyType: string | null | undefined,
  L: number,
  W: number,
  gt4Lookup: (name: string) => GT4SpecLike | undefined,
): CarWheelGeom | null {
  if (carName) {
    const spec = gt4Lookup(carName);
    if (spec) {
      const g = xrayWheelGeomFromSpec(spec, L, W);
      if (g) return g;
    }
  }
  if (bodyType && TRAFFIC_BODYTYPE_SPECS[bodyType]) {
    return xrayWheelGeomFromSpec(TRAFFIC_BODYTYPE_SPECS[bodyType], L, W);
  }
  return null;
}

/** Renders 4 yellow tires using real per-car geometry. Front pair rotates
 *  with steerAngle around its axle centre. Solid yellow rectangles align
 *  with the existing X-Ray visual vocabulary. */
export function drawXrayTiresFromGeom(
  ctx: CanvasRenderingContext2D,
  geom: CarWheelGeom,
  steerAngle: number,
): void {
  ctx.fillStyle = '#ff0';
  ctx.fillRect(geom.rAxleX - geom.rL / 2, -geom.rHalfTrack - geom.rW / 2, geom.rL, geom.rW);
  ctx.fillRect(geom.rAxleX - geom.rL / 2,  geom.rHalfTrack - geom.rW / 2, geom.rL, geom.rW);
  ctx.save();
  ctx.translate(geom.fAxleX, -geom.fHalfTrack);
  ctx.rotate(steerAngle);
  ctx.fillRect(-geom.fL / 2, -geom.fW / 2, geom.fL, geom.fW);
  ctx.restore();
  ctx.save();
  ctx.translate(geom.fAxleX,  geom.fHalfTrack);
  ctx.rotate(steerAngle);
  ctx.fillRect(-geom.fL / 2, -geom.fW / 2, geom.fL, geom.fW);
  ctx.restore();
}

// ---- Bike X-ray geometry (single-track) -----------------------------------

/** Same shape as xrayWheelGeomFromSpec but for bikes — both wheels on
 *  centerline so no lateral track. Tire widths scale by gpmL (not gpmW)
 *  because a bike's 'wid' field represents handlebar reach, not body width. */
export function xrayBikeGeomFromSpec(
  spec: GT4SpecLike | undefined | null,
  L: number,
): BikeWheelGeom | null {
  if (!spec || !spec.lng || !spec.wb) return null;
  const fT = parseTireSpec(spec.tsF);
  const rT = parseTireSpec(spec.tsR);
  if (!fT || !rT) return null;
  const gpmL = L / spec.lng;
  return {
    fL: fT.diameter * gpmL,
    fW: fT.width * gpmL,
    rL: rT.diameter * gpmL,
    rW: rT.width * gpmL,
    fAxleX: +(spec.wb / 2) * gpmL,
    rAxleX: -(spec.wb / 2) * gpmL,
  };
}

/** Fallback specs for bikes not in GT4_SPECS (CB500, Bandit 400, Katana). */
export const BIKE_FALLBACK_SPECS: Readonly<Record<string, GT4SpecLike>> = {
  default:        { wb: 1430, lng: 2080, wid: 740, tsF: '120/70 R17', tsR: '150/70 R17', trF: 0, trR: 0 },
  honda_cb500:    { wb: 1450, lng: 2125, wid: 750, tsF: '110/70 R17', tsR: '130/70 R17', trF: 0, trR: 0 },
  suzuki_bandit:  { wb: 1430, lng: 2055, wid: 730, tsF: '110/70 R17', tsR: '140/70 R17', trF: 0, trR: 0 },
  suzuki_katana:  { wb: 1485, lng: 2105, wid: 740, tsF: '110/80 R17', tsR: '140/80 R17', trF: 0, trR: 0 },
};

export function xrayBikeGeom(
  carName: string | null | undefined,
  bikeSpriteKey: string | null | undefined,
  L: number,
  gt4Lookup: (name: string) => GT4SpecLike | undefined,
): BikeWheelGeom | null {
  if (carName) {
    const spec = gt4Lookup(carName);
    if (spec) {
      const g = xrayBikeGeomFromSpec(spec, L);
      if (g) return g;
    }
  }
  if (bikeSpriteKey && BIKE_FALLBACK_SPECS[bikeSpriteKey]) {
    return xrayBikeGeomFromSpec(BIKE_FALLBACK_SPECS[bikeSpriteKey], L);
  }
  return xrayBikeGeomFromSpec(BIKE_FALLBACK_SPECS.default, L);
}

export function drawXrayBikeTiresFromGeom(
  ctx: CanvasRenderingContext2D,
  geom: BikeWheelGeom,
  steerAngle: number,
): void {
  ctx.fillStyle = '#ff0';
  ctx.fillRect(geom.rAxleX - geom.rL / 2, -geom.rW / 2, geom.rL, geom.rW);
  ctx.save();
  ctx.translate(geom.fAxleX, 0);
  ctx.rotate(steerAngle);
  ctx.fillRect(-geom.fL / 2, -geom.fW / 2, geom.fL, geom.fW);
  ctx.restore();
}
