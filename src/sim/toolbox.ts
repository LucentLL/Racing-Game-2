/**
 * H944: garage TOOLBOX — the player's owned tools, consumables, and tires.
 *
 * Display foundation for the user's "toolbox in garage that shows owned tools
 * (spanner/socket wrenches, metric/imperial, tire sizes)". Tools are owned
 * (qty 1); consumables (WD-40) and tires carry a count. This is the inventory
 * the RPG-lite repair events will draw on (use WD-40 on a rusted bolt; having
 * the right socket avoids the "lost the 10mm — spend an hour looking" time hit).
 *
 * v1 is display + a sensible STARTER set; buying/acquiring tools + spending
 * them in events lands in later slices.
 */

import type { LifeState, ToolItem } from '@/state/life';

/** A modest starter kit — enough to do basic DIY, missing the specialty tools
 *  (torque wrench, specific large sockets) that gate harder jobs / events. */
export function makeStarterToolbox(): ToolItem[] {
  return [
    { id: 'socket_set_metric', name: 'Socket Set', category: 'socket', qty: 1, spec: 'metric' },
    { id: 'wrench_set_metric', name: 'Combination Wrenches', category: 'wrench', qty: 1, spec: 'metric' },
    { id: 'screwdrivers', name: 'Screwdriver Set', category: 'wrench', qty: 1 },
    { id: 'jack_stands', name: 'Floor Jack + Stands', category: 'power', qty: 1 },
    { id: 'wd40', name: 'WD-40', category: 'consumable', qty: 1 },
  ];
}

/** Lazily ensure life.toolbox exists (old saves predate it), returning the
 *  live array. */
export function ensureToolbox(life: LifeState): ToolItem[] {
  if (!life.toolbox) life.toolbox = makeStarterToolbox();
  return life.toolbox;
}

export interface ToolGroup {
  key: ToolItem['category'];
  label: string;
  items: ToolItem[];
}

const GROUP_ORDER: ReadonlyArray<{ key: ToolItem['category']; label: string }> = [
  { key: 'wrench', label: 'WRENCHES' },
  { key: 'socket', label: 'SOCKETS' },
  { key: 'power', label: 'POWER & LIFT' },
  { key: 'consumable', label: 'CONSUMABLES' },
  { key: 'tire', label: 'TIRES' },
];

/** Group the toolbox into display sections (only non-empty groups, in a
 *  stable order). */
export function groupToolbox(life: LifeState): ToolGroup[] {
  const items = ensureToolbox(life);
  const out: ToolGroup[] = [];
  for (const g of GROUP_ORDER) {
    const groupItems = items.filter((t) => t.category === g.key);
    if (groupItems.length > 0) out.push({ key: g.key, label: g.label, items: groupItems });
  }
  return out;
}
