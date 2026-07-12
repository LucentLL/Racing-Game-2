/**
 * H1133 — dynamic car lighting (user ask 2026-07-11: "car sprites are
 * all so matte... maybe they can dynamically catch sunrays and cloud
 * shadows").
 *
 * Two live overlays per visible car, drawn AFTER the body sprite (and
 * after the H1085 cel-shade bake, so cel cache keys stay static):
 *
 *   1. CLOUD SHADE — the world cloud-shadow pass (H1116) draws UNDER
 *      cars, so a car crossing a shadow stayed fully lit and visibly
 *      "floated" on top of the darkness. Sample the same drifting
 *      field at the car's position (cloudShadeAt) and multiply-darken
 *      the body rect with the SAME purple-dark the terrain shadow
 *      uses — the car now visually enters the shadow.
 *
 *   2. SUN GLINT — a soft specular band across the body that slides
 *      fore/aft and swells/fades as the car's heading rotates against
 *      the sun azimuth (which itself tracks the time of day, east →
 *      west). Killed by cloud cover via sunAt, so driving under a
 *      cloud dims the paint AND wipes the glint — the "dynamically
 *      catch sunrays" half of the ask.
 *
 * Cost: one fillRect (shade) + one gradient fillRect (glint) per
 * visible car, world-space rotate/translate — same class as the H98
 * headlight bulbs. No allocations besides the per-call gradient.
 */

import { cloudShadeAt, sunAt } from '@/render/cloudShadows';

/** Sun azimuth (world rad) for a clock time-of-day. 0.25 (~6 am) →
 *  light from the EAST (azimuth π: photons travel −x → glint reads on
 *  the car's east flank), 0.5 (noon) → from the south-east diagonal,
 *  0.75 (~6 pm) → from the WEST. Linear sweep between; screen-space
 *  believable rather than astronomically exact. */
export function sunAzimuth(timeOfDay: number): number {
  return Math.PI + (timeOfDay - 0.25) * Math.PI * 2 * 0.5;
}

/** Shadow tint matching the baked cloud texture (26,20,44). */
const SHADE_R = 26, SHADE_G = 20, SHADE_B = 44;

/**
 * Paint the lighting overlays for one car. `ctx` must carry the world
 * transform. (x, y) world center, `angle` heading, `len`/`wid` the
 * body size in world units. `night` is nightIntensity; both effects
 * fade to zero after dusk via the cloud samplers.
 */
export function drawCarLighting(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  angle: number,
  len: number,
  wid: number,
  tMs: number,
  night: number,
  timeOfDay: number,
): void {
  const shade = cloudShadeAt(x, y, tMs, night);
  const sun = sunAt(x, y, tMs, night);
  if (shade < 0.02 && sun < 0.05) return;

  const hl = len / 2;
  const hw = wid / 2;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);

  // ---- 1. Cloud shade — same tint as the terrain pass ------------------
  if (shade >= 0.02) {
    ctx.fillStyle = 'rgba(' + SHADE_R + ',' + SHADE_G + ',' + SHADE_B + ',' + shade.toFixed(3) + ')';
    // Slight inset so the darkening doesn't halo past the sprite.
    ctx.fillRect(-hl + 0.5, -hw + 0.5, len - 1, wid - 1);
  }

  // ---- 2. Sun glint — heading-reactive specular band -------------------
  if (sun >= 0.05) {
    // Relative angle between body heading and the sun azimuth: slides
    // the band fore/aft and modulates its strength, so turning the car
    // sweeps the highlight across the roof.
    const rel = angle - sunAzimuth(timeOfDay);
    const slide = Math.sin(rel) * hl * 0.45;
    // Strength peaks when a flank faces the sun (cos(2·rel) term keeps
    // it symmetric front/back) — never fully dies, paint always has a
    // little sheen in open sun. First cut (0.10+0.12) read matte at
    // play zoom — the whole point of the ask was killing the matte.
    const strength = sun * (0.14 + 0.18 * (0.5 + 0.5 * Math.cos(2 * rel)));
    const bandHalf = Math.max(2, len * 0.17);
    const g = ctx.createLinearGradient(slide - bandHalf, 0, slide + bandHalf, 0);
    g.addColorStop(0, 'rgba(255,246,220,0)');
    g.addColorStop(0.5, 'rgba(255,246,220,' + strength.toFixed(3) + ')');
    g.addColorStop(1, 'rgba(255,246,220,0)');
    ctx.fillStyle = g;
    ctx.fillRect(slide - bandHalf, -hw + 0.5, bandHalf * 2, wid - 1);
  }

  ctx.restore();
}
