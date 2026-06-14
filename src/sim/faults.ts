import type { LifeState } from '@/state/life';

export type DamageZone =
  | 'headlightL' | 'headlightR' | 'frontBumper'
  | 'taillightL' | 'taillightR' | 'rearBumper'
  | 'fenderFL' | 'fenderFR' | 'hood'
  | 'quarterRL' | 'quarterRR' | 'trunk'
  | 'doorL' | 'doorR';

export interface ZoneDamage {
  cosmetic: number;
  functional: number;
  structural: number;
}

export type BodyDamage = Record<DamageZone, ZoneDamage>;

export interface Fault {
  id: string;
  name: string;
  stat: 'engine' | 'tires' | 'hp' | 'paint';
  cost: number;
  days: number;
  type: 'mech' | 'body';
  add: number;
  zone?: DamageZone;
}

export function makeFreshBodyDamage(): BodyDamage {
  const z: BodyDamage = {} as BodyDamage;
  const zones: DamageZone[] = [
    'headlightL', 'headlightR', 'frontBumper',
    'taillightL', 'taillightR', 'rearBumper',
    'fenderFL', 'fenderFR', 'hood',
    'quarterRL', 'quarterRR', 'trunk',
    'doorL', 'doorR',
  ];
  for (const k of zones) z[k] = { cosmetic: 0, functional: 0, structural: 0 };
  return z;
}

/**
 * Classify a world-space hit point relative to the car's body axes.
 * cdx/cdy are world-delta from car center; pCos/pSin are car heading;
 * pHL/pHW are body half-length/half-width. Returns the DamageZone the
 * impact landed in.
 */
export function classifyHitZone(
  cdx: number, cdy: number,
  pCos: number, pSin: number,
  pHL: number, pHW: number,
): DamageZone {
  const lx = cdx * pCos + cdy * pSin;
  const ly = -cdx * pSin + cdy * pCos;
  const nx = lx / pHL;
  const ny = ly / pHW;
  const absNy = Math.abs(ny);
  if (nx > 0.85) {
    if (absNy >= 0.7) return ny < 0 ? 'headlightL' : 'headlightR';
    return 'frontBumper';
  }
  if (nx < -0.85) {
    if (absNy >= 0.7) return ny < 0 ? 'taillightL' : 'taillightR';
    return 'rearBumper';
  }
  if (nx > 0.3) {
    if (absNy >= 0.8) return ny < 0 ? 'fenderFL' : 'fenderFR';
    return 'hood';
  }
  if (nx < -0.3) {
    if (absNy >= 0.8) return ny < 0 ? 'quarterRL' : 'quarterRR';
    return 'trunk';
  }
  return ny < 0 ? 'doorL' : 'doorR';
}

export interface ApplyDamageContext {
  notify?: (msg: string) => void;
}

export function applyZoneDamage(
  life: LifeState,
  zone: DamageZone,
  impactDmg: number,
  scrapeDmg: number,
  ctx: ApplyDamageContext = {},
): void {
  if (!life.bodyDamage) life.bodyDamage = makeFreshBodyDamage();
  const dmg = life.bodyDamage as BodyDamage;
  const z = dmg[zone];
  if (!z) return;

  if (scrapeDmg > 0) z.cosmetic = Math.min(100, z.cosmetic + scrapeDmg * 2);

  if (impactDmg < 3) {
    z.cosmetic = Math.min(100, z.cosmetic + impactDmg * 1.5);
  } else if (impactDmg < 10) {
    z.cosmetic = Math.min(100, z.cosmetic + impactDmg * 0.5);
    z.functional = Math.min(100, z.functional + impactDmg * 1.2);
  } else {
    z.cosmetic = Math.min(100, z.cosmetic + impactDmg * 0.3);
    z.functional = Math.min(100, z.functional + impactDmg * 0.8);
    z.structural = Math.min(100, z.structural + (impactDmg - 10) * 0.9);
  }

  maybeTriggerZoneFault(life, zone, z, ctx);
}

function pushIfMissing(
  faults: Fault[],
  notify: ((m: string) => void) | undefined,
  id: string, name: string,
  stat: Fault['stat'], cost: number,
  type: Fault['type'], zone: DamageZone,
): void {
  if (faults.some((f) => f.id === id)) return;
  // H867: source the real repair DAYS + stat-restore ADD from the reference
  // table (ids match). Pre-H867 these were hard-coded days:0/add:0, which
  // made every crash fault free, instant, and restore-nothing — breaking the
  // repair time economy. Fallback covers any id not in the table.
  const ref = BODY_DAMAGE_FAULTS.find((r) => r.id === id);
  faults.push({ id, name, stat, cost, days: ref?.days ?? 1, type, add: ref?.add ?? 15, zone });
  notify?.(name);
}

export function maybeTriggerZoneFault(
  life: LifeState,
  zone: DamageZone,
  z: ZoneDamage,
  ctx: ApplyDamageContext,
): void {
  const faults = life.faults as Fault[];
  const n = ctx.notify;

  if ((zone === 'headlightL' || zone === 'headlightR') && z.functional >= 40) {
    pushIfMissing(faults, n, 'hl_' + zone, (zone === 'headlightL' ? 'LEFT' : 'RIGHT') + ' HEADLIGHT OUT', 'hp', 180, 'mech', zone);
  }
  if ((zone === 'taillightL' || zone === 'taillightR') && z.functional >= 40) {
    pushIfMissing(faults, n, 'tl_' + zone, (zone === 'taillightL' ? 'LEFT' : 'RIGHT') + ' TAILLIGHT OUT', 'hp', 120, 'mech', zone);
  }
  if (zone === 'frontBumper' && z.cosmetic >= 60) {
    pushIfMissing(faults, n, 'fb_crack', 'FRONT BUMPER CRACKED', 'hp', 200, 'body', zone);
  }
  if (zone === 'rearBumper' && z.cosmetic >= 60) {
    pushIfMissing(faults, n, 'rb_crack', 'REAR BUMPER CRACKED', 'hp', 180, 'body', zone);
  }
  if (zone === 'frontBumper' && z.structural >= 30) {
    pushIfMissing(faults, n, 'fb_frame', 'FRONT FRAME BENT', 'hp', 800, 'body', zone);
  }
  if (zone === 'rearBumper' && z.structural >= 30) {
    pushIfMissing(faults, n, 'rb_frame', 'REAR FRAME BENT', 'hp', 700, 'body', zone);
  }
  if (zone === 'hood' && z.functional >= 50) {
    pushIfMissing(faults, n, 'hood_latch', 'HOOD LATCH BROKEN', 'hp', 150, 'body', zone);
  }
  if (zone === 'trunk' && z.functional >= 50) {
    pushIfMissing(faults, n, 'trunk_latch', 'TRUNK WON’T LATCH', 'hp', 140, 'body', zone);
  }
  if ((zone === 'fenderFL' || zone === 'fenderFR') && z.structural >= 40) {
    pushIfMissing(faults, n, 'susp_' + zone, 'FRONT SUSP MOUNT DAMAGED (' + (zone === 'fenderFL' ? 'L' : 'R') + ')', 'tires', 600, 'mech', zone);
  }
  if ((zone === 'quarterRL' || zone === 'quarterRR') && z.structural >= 40) {
    pushIfMissing(faults, n, 'drv_' + zone, 'REAR DRIVETRAIN MOUNT HIT (' + (zone === 'quarterRL' ? 'L' : 'R') + ')', 'engine', 900, 'mech', zone);
  }
  if ((zone === 'doorL' || zone === 'doorR') && z.functional >= 50) {
    pushIfMissing(faults, n, 'door_' + zone, (zone === 'doorL' ? 'LEFT' : 'RIGHT') + ' DOOR JAMMED', 'hp', 200, 'body', zone);
  }
}

export const BODY_DAMAGE_FAULTS: readonly Fault[] = [
  { id: 'hl_headlightL', name: 'LEFT HEADLIGHT OUT',       stat: 'hp',     cost: 180, days: 0, type: 'mech', add: 15 },
  { id: 'hl_headlightR', name: 'RIGHT HEADLIGHT OUT',      stat: 'hp',     cost: 180, days: 0, type: 'mech', add: 15 },
  { id: 'tl_taillightL', name: 'LEFT TAILLIGHT OUT',       stat: 'hp',     cost: 120, days: 0, type: 'mech', add: 12 },
  { id: 'tl_taillightR', name: 'RIGHT TAILLIGHT OUT',      stat: 'hp',     cost: 120, days: 0, type: 'mech', add: 12 },
  { id: 'fb_crack',      name: 'FRONT BUMPER CRACKED',     stat: 'hp',     cost: 200, days: 1, type: 'body', add: 20 },
  { id: 'rb_crack',      name: 'REAR BUMPER CRACKED',      stat: 'hp',     cost: 180, days: 1, type: 'body', add: 18 },
  { id: 'fb_frame',      name: 'FRONT FRAME BENT',         stat: 'hp',     cost: 800, days: 3, type: 'body', add: 60 },
  { id: 'rb_frame',      name: 'REAR FRAME BENT',          stat: 'hp',     cost: 700, days: 3, type: 'body', add: 55 },
  { id: 'hood_latch',    name: 'HOOD LATCH BROKEN',        stat: 'hp',     cost: 150, days: 1, type: 'body', add: 15 },
  { id: 'trunk_latch',   name: 'TRUNK WON’T LATCH',   stat: 'hp',     cost: 140, days: 1, type: 'body', add: 14 },
  { id: 'susp_fenderFL', name: 'FRONT SUSP MOUNT DMG (L)', stat: 'tires',  cost: 600, days: 2, type: 'mech', add: 40 },
  { id: 'susp_fenderFR', name: 'FRONT SUSP MOUNT DMG (R)', stat: 'tires',  cost: 600, days: 2, type: 'mech', add: 40 },
  { id: 'drv_quarterRL', name: 'REAR DRIVETRAIN MOUNT (L)', stat: 'engine', cost: 900, days: 2, type: 'mech', add: 45 },
  { id: 'drv_quarterRR', name: 'REAR DRIVETRAIN MOUNT (R)', stat: 'engine', cost: 900, days: 2, type: 'mech', add: 45 },
  { id: 'door_doorL',    name: 'LEFT DOOR JAMMED',         stat: 'hp',     cost: 200, days: 1, type: 'body', add: 18 },
  { id: 'door_doorR',    name: 'RIGHT DOOR JAMMED',        stat: 'hp',     cost: 200, days: 1, type: 'body', add: 18 },
];

export type ZoneRect = readonly [x0: number, y0: number, x1: number, y1: number];

export function getDamageZoneRects(hl: number, hw: number): Record<DamageZone, ZoneRect> {
  return {
    frontBumper: [hl * 0.85, -hw * 0.7,  hl,       hw * 0.7],
    headlightL:  [hl * 0.85, -hw,        hl,      -hw * 0.7],
    headlightR:  [hl * 0.85,  hw * 0.7,  hl,       hw],
    hood:        [hl * 0.3,  -hw * 0.8,  hl * 0.85, hw * 0.8],
    fenderFL:    [hl * 0.3,  -hw,        hl * 0.85, -hw * 0.8],
    fenderFR:    [hl * 0.3,   hw * 0.8,  hl * 0.85, hw],
    doorL:       [-hl * 0.3, -hw,        hl * 0.3, -hw * 0.5],
    doorR:       [-hl * 0.3,  hw * 0.5,  hl * 0.3, hw],
    trunk:       [-hl * 0.85, -hw * 0.8, -hl * 0.3, hw * 0.8],
    quarterRL:   [-hl * 0.85, -hw,       -hl * 0.3, -hw * 0.8],
    quarterRR:   [-hl * 0.85, hw * 0.8,  -hl * 0.3, hw],
    rearBumper:  [-hl,       -hw * 0.7,  -hl * 0.85, hw * 0.7],
    taillightL:  [-hl,       -hw,        -hl * 0.85, -hw * 0.7],
    taillightR:  [-hl,        hw * 0.7,  -hl * 0.85, hw],
  };
}
