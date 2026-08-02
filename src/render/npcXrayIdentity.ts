/**
 * H1308: drivetrain identity for NON-player vehicles, so traffic and NPC
 * racers can render a real X-ray when the player turns X-ray mode on.
 *
 * Traffic carries no CatalogCar — a TrafficCar is a sprite file, a colour and
 * some flags (src/state/traffic.ts). All the X-ray needs is a GT4 catalog
 * NAME (which upgrades xrayCarGeom from its 9-row bodyType table to real
 * wheelbase/track data), a drivetrain code and an engine type.
 *
 * Lives OUTSIDE render/carBody on purpose: that layer deliberately does not
 * import the car catalog (see the local eType parser in xrayDrivetrain.ts and
 * the local GT4SpecLike in xrayGeom.ts), and this module needs CAR_CATALOG.
 *
 * NOTE this is IDENTITY, never CONDITION. NPC cars carry no condition — they
 * always render XRAY_NEUTRAL_COND.
 */

import { CAR_CATALOG } from '@/config/cars/catalog';
import { getCarGeneration } from '@/render/carBody/generation';

export interface NpcXrayId {
  /** GT4 catalog display name, when one could be resolved. */
  name?: string | null;
  drv?: string;
  eType?: string;
}

/** Generic traffic / job bodyTypes with no catalog row of their own. These
 *  are the civilian "daily" pool plus the service vehicles, and they are the
 *  bulk of what is on screen at any moment. */
const STATIC: Readonly<Record<string, NpcXrayId>> = {
  civic99: { drv: 'FF', eType: 'L4' },
  accord99: { drv: 'FF', eType: 'L4' },
  sedan: { drv: 'FF', eType: 'V6' },      // Ford Taurus
  hatch: { drv: 'FF', eType: 'V6' },      // Dodge Caravan
  suv: { drv: 'FF', eType: 'V6' },        // Caravan alias
  pickup: { drv: 'FR', eType: 'V8' },     // Ram 1500
  cruiser: { drv: 'FR', eType: 'V8' },    // Crown Vic P71
  towtruck: { drv: 'FR', eType: 'V8' },
  boxtruck: { drv: 'FR', eType: 'V8' },
};

/** genId -> a representative catalog car. The reverse of getCarGeneration,
 *  built once on first use: traffic's "sport" pool is keyed by genId
 *  (rx7_fc, ae86, miata_na...), and without this those cars resolve no
 *  geometry and render as bare wheels with no drivetrain. */
let REV: Record<string, NpcXrayId> | null = null;

function reverseMap(): Record<string, NpcXrayId> {
  if (REV) return REV;
  const m: Record<string, NpcXrayId> = {};
  for (const id in CAR_CATALOG) {
    const c = CAR_CATALOG[id];
    const g = getCarGeneration(c.name);
    if (g && !m[g]) m[g] = { name: c.name, drv: c.drv, eType: c.eType };
  }
  // getCarGeneration has no rule that emits a bare 'silvia' (the S13 coupe),
  // so alias it to the hatch, which shares the chassis.
  if (!m.silvia) m.silvia = m.silvia_180sx ?? { drv: 'FR', eType: 'L4' };
  REV = m;
  return m;
}

/** Identity for a traffic/NPC bodyType, or undefined when nothing is known
 *  (the caller then draws tires + dashed outline only). */
export function npcXrayIdFor(bodyType: string | undefined): NpcXrayId | undefined {
  if (!bodyType) return undefined;
  return STATIC[bodyType] ?? reverseMap()[bodyType];
}
