/**
 * Body-damage X-Ray overlay. When the player has LIFE.gameplaySettings.xrayBody
 * on, the damage heatmap renders inside the silhouette: yellow for cosmetic,
 * orange for functional, red for structural. Alpha scales with severity.
 *
 * Ported from monolith L43164-43208.
 */

/** 14 zone rectangles in car-local coords. Each entry is
 *  [x1, y1, x2, y2] — caller paints `fillRect(x1, y1, x2-x1, y2-y1)`. */
export interface DamageZoneRects {
  frontBumper: readonly [number, number, number, number];
  headlightL:  readonly [number, number, number, number];
  headlightR:  readonly [number, number, number, number];
  hood:        readonly [number, number, number, number];
  fenderFL:    readonly [number, number, number, number];
  fenderFR:    readonly [number, number, number, number];
  doorL:       readonly [number, number, number, number];
  doorR:       readonly [number, number, number, number];
  quarterRL:   readonly [number, number, number, number];
  quarterRR:   readonly [number, number, number, number];
  trunk:       readonly [number, number, number, number];
  taillightL:  readonly [number, number, number, number];
  taillightR:  readonly [number, number, number, number];
  rearBumper:  readonly [number, number, number, number];
}

export function getDamageZoneRects(hl: number, hw: number): DamageZoneRects {
  return {
    frontBumper: [hl * 0.85, -hw * 0.7,  hl,        hw * 0.7],
    headlightL:  [hl * 0.85, -hw,        hl,       -hw * 0.7],
    headlightR:  [hl * 0.85,  hw * 0.7,  hl,        hw      ],
    hood:        [hl * 0.3,  -hw * 0.8,  hl * 0.85, hw * 0.8],
    fenderFL:    [hl * 0.3,  -hw,        hl * 0.85,-hw * 0.8],
    fenderFR:    [hl * 0.3,   hw * 0.8,  hl * 0.85, hw      ],
    doorL:       [-hl * 0.3, -hw,        hl * 0.3,  0       ],
    doorR:       [-hl * 0.3,  0,         hl * 0.3,  hw      ],
    quarterRL:   [-hl * 0.85,-hw,       -hl * 0.3, -hw * 0.8],
    quarterRR:   [-hl * 0.85, hw * 0.8, -hl * 0.3,  hw      ],
    trunk:       [-hl * 0.85,-hw * 0.8, -hl * 0.3,  hw * 0.8],
    taillightL:  [-hl,       -hw,       -hl * 0.85,-hw * 0.7],
    taillightR:  [-hl,        hw * 0.7, -hl * 0.85, hw      ],
    rearBumper:  [-hl,       -hw * 0.7, -hl * 0.85, hw * 0.7],
  };
}

/** Per-zone damage levels (0..100). */
export interface ZoneDamage {
  cosmetic: number;
  functional: number;
  structural: number;
}

export type BodyDamage = Partial<Record<keyof DamageZoneRects, ZoneDamage>>;

/** Looks up the active player's body damage and paints the heatmap.
 *  Called from drawTopCar when xrayBody is on AND isPlayer. Injected
 *  body-damage source keeps this module independent of LIFE. */
export function drawXrayDamageOverlay(
  ctx: CanvasRenderingContext2D,
  hl: number,
  hw: number,
  bodyDamage?: BodyDamage,
): void {
  if (!bodyDamage) return;
  const rects = getDamageZoneRects(hl, hw);
  for (const name in rects) {
    const zone = bodyDamage[name as keyof DamageZoneRects];
    if (!zone) continue;
    let rgb: string;
    let sev: number;
    if (zone.structural > 5)      { rgb = '255,40,40';  sev = zone.structural; }
    else if (zone.functional > 5) { rgb = '255,160,40'; sev = zone.functional; }
    else if (zone.cosmetic > 5)   { rgb = '240,220,40'; sev = zone.cosmetic; }
    else continue;
    const a = Math.min(0.75, 0.15 + sev / 100 * 0.6);
    ctx.fillStyle = `rgba(${rgb},${a})`;
    const r = rects[name as keyof DamageZoneRects];
    ctx.fillRect(r[0], r[1], r[2] - r[0], r[3] - r[1]);
    // Structural-only crack outline.
    if (zone.structural > 15) {
      ctx.strokeStyle = 'rgba(255,255,255,0.6)';
      ctx.lineWidth = 0.4;
      ctx.strokeRect(r[0], r[1], r[2] - r[0], r[3] - r[1]);
    }
  }
}
