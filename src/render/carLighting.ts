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

/** H1193: path a rounded-rect approximating the car BODY silhouette in
 *  the car's local frame (origin center, +X = length). Used as a clip so
 *  light washes/tints follow the rounded body instead of the sprite's
 *  hard rectangular bounding box (user: "respect car sprite shape, not
 *  just rectangles"). A true per-sprite mask needs an offscreen redraw
 *  the wash call sites don't have the sprite for; the rounded rect kills
 *  the hard corners cheaply and works on both the desktop pc-overlay and
 *  the mobile main canvas. */
export function traceBodyRoundRect(ctx: CanvasRenderingContext2D, hl: number, hw: number): void {
  const r = Math.min(hl, hw) * 0.5;
  const x = -hl + 0.5, y = -hw + 0.5, w = 2 * hl - 1, h = 2 * hw - 1;
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, w, h, r);
  } else {
    // Manual rounded rect fallback.
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
}

/** H1137: a lit headlight pair another car can catch light from. */
export interface HeadlightSource {
  x: number;
  y: number;
  angle: number;
  /** Beam reach in world px (player 220, traffic 140). */
  beam: number;
}

/** H1137: cone alignment gate — dot(source heading, source→car) must
 *  beat this (≈ cos 36°, just wider than the 0.36 rad drawn cone so
 *  the paint catches light a beat before the cone visually swallows
 *  the car). */
const CATCH_ALIGN_MIN = 0.81;
/** H1137: moonlight starts showing on paint past this night level. */
const MOON_MIN_NIGHT = 0.35;

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
  /** H1137: nearby lit headlights (player + traffic). Null by day /
   *  when the cloud-light system is killed. */
  sources: readonly HeadlightSource[] | null = null,
): void {
  const hl = len / 2;
  const hw = wid / 2;
  const cosA = Math.cos(angle);
  const sinA = Math.sin(angle);

  // ===== H1137: NIGHT — moonlight sheen + headlight catch ==============
  // (runs first; day terms below are ~0 at night and vice versa.)
  if (night > 0.05) {
    // Strongest headlight hitting this car, if any.
    let lampHit = 0;
    let lampDirX = 0, lampDirY = 0;
    if (sources) {
      for (const s of sources) {
        const dx = x - s.x;
        const dy = y - s.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < 25 || d2 > s.beam * s.beam) continue; // self / out of reach
        const d = Math.sqrt(d2);
        const align = (dx * Math.cos(s.angle) + dy * Math.sin(s.angle)) / d;
        if (align <= CATCH_ALIGN_MIN) continue;
        const f = ((align - CATCH_ALIGN_MIN) / (1 - CATCH_ALIGN_MIN)) * (1 - d / s.beam);
        if (f > lampHit) {
          lampHit = f;
          lampDirX = dx / d;
          lampDirY = dy / d;
        }
      }
    }
    const moon = night > MOON_MIN_NIGHT ? (night - MOON_MIN_NIGHT) / (1 - MOON_MIN_NIGHT) : 0;
    if (lampHit > 0.03 || moon > 0.05) {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(angle);
      traceBodyRoundRect(ctx, hl, hw); ctx.clip(); // H1193: follow the body
      // -- Moonlight: cool specular band, moon opposite the sun -------
      if (moon > 0.05) {
        const mRel = angle - (sunAzimuth(timeOfDay) + Math.PI);
        const mSlide = Math.sin(mRel) * hl * 0.45;
        const mStr = moon * (0.05 + 0.07 * (0.5 + 0.5 * Math.cos(2 * mRel)));
        const bh = Math.max(2, len * 0.17);
        const mg = ctx.createLinearGradient(mSlide - bh, 0, mSlide + bh, 0);
        mg.addColorStop(0, 'rgba(205,222,255,0)');
        mg.addColorStop(0.5, 'rgba(205,222,255,' + mStr.toFixed(3) + ')');
        mg.addColorStop(1, 'rgba(205,222,255,0)');
        ctx.fillStyle = mg;
        ctx.fillRect(mSlide - bh, -hw + 0.5, bh * 2, wid - 1);
      }
      // -- Headlight catch: warm wash, brightest on the face the beam
      // hits, falling across the body ---------------------------------
      if (lampHit > 0.03) {
        // Incoming light direction in the car's local frame.
        const lx = lampDirX * cosA + lampDirY * sinA;
        const ly = -lampDirX * sinA + lampDirY * cosA;
        const a0 = Math.min(0.4, 0.34 * lampHit * Math.min(1, (night - 0.05) * 4));
        const lg = ctx.createLinearGradient(-lx * hl, -ly * hw, lx * hl, ly * hw);
        lg.addColorStop(0, 'rgba(255,224,150,' + a0.toFixed(3) + ')');
        lg.addColorStop(1, 'rgba(255,224,150,' + (a0 * 0.2).toFixed(3) + ')');
        ctx.fillStyle = lg;
        ctx.fillRect(-hl + 0.5, -hw + 0.5, len - 1, wid - 1);
      }
      ctx.restore();
    }
  }

  // H1136: sample the field at the NOSE and TAIL, not just the center —
  // a car straddling a cloud edge is now lit exactly where the sun
  // actually falls (user: "only the back portion of the car lights up,
  // it should be whatever is catching sunlight outside of a cloud").
  const fx = x + cosA * hl * 0.8;
  const fy = y + sinA * hl * 0.8;
  const rx = x - cosA * hl * 0.8;
  const ry = y - sinA * hl * 0.8;
  let shadeF = cloudShadeAt(fx, fy, tMs, night);
  let shadeR = cloudShadeAt(rx, ry, tMs, night);

  // H1136: a car with its headlights ON is self-lit — the cloud
  // shadow must not read as cast "through" the lamps (user report).
  // Headlights come on with dusk (the night>0.05 bulb gate); fade the
  // body shade out over the same window so by night 0.25 the paint is
  // owned by the lamps, not the sky.
  const lampSuppress = Math.max(0, 1 - Math.max(0, night - 0.05) / 0.2);
  shadeF *= lampSuppress;
  shadeR *= lampSuppress;

  const sunF = sunAt(fx, fy, tMs, night);
  const sunR = sunAt(rx, ry, tMs, night);
  if (shadeF < 0.02 && shadeR < 0.02 && sunF < 0.05 && sunR < 0.05) return;

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  traceBodyRoundRect(ctx, hl, hw); ctx.clip(); // H1193: follow the body

  // ---- 1. Cloud shade — axial gradient tail→nose so a cloud edge
  // crosses the BODY, same tint as the terrain pass -----------------------
  if (shadeF >= 0.02 || shadeR >= 0.02) {
    if (Math.abs(shadeF - shadeR) < 0.03) {
      const s = ((shadeF + shadeR) / 2).toFixed(3);
      ctx.fillStyle = 'rgba(' + SHADE_R + ',' + SHADE_G + ',' + SHADE_B + ',' + s + ')';
    } else {
      const g = ctx.createLinearGradient(-hl, 0, hl, 0);
      g.addColorStop(0, 'rgba(' + SHADE_R + ',' + SHADE_G + ',' + SHADE_B + ',' + shadeR.toFixed(3) + ')');
      g.addColorStop(1, 'rgba(' + SHADE_R + ',' + SHADE_G + ',' + SHADE_B + ',' + shadeF.toFixed(3) + ')');
      ctx.fillStyle = g;
    }
    // Slight inset so the darkening doesn't halo past the sprite.
    ctx.fillRect(-hl + 0.5, -hw + 0.5, len - 1, wid - 1);
  }

  // ---- 2. Sun glint — heading-reactive specular band, lit by the sun
  // at the band's OWN position (nose glint dies when the nose is under
  // the cloud, even while the tail still sparkles) ------------------------
  const rel = angle - sunAzimuth(timeOfDay);
  const slide = Math.sin(rel) * hl * 0.45;
  // Sun strength local to where the band sits on the body.
  const bandT = (slide + hl) / len;               // 0 tail … 1 nose
  const sunLocal = sunR + (sunF - sunR) * bandT;
  if (sunLocal >= 0.05) {
    // Strength peaks when a flank faces the sun (cos(2·rel) term keeps
    // it symmetric front/back) — never fully dies, paint always has a
    // little sheen in open sun.
    const strength = sunLocal * (0.14 + 0.18 * (0.5 + 0.5 * Math.cos(2 * rel)));
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
