/**
 * H1003: tool shop catalog (Auto Parts store TOOLS tab).
 *
 * Sells ToolItems the player buys to OWN — added to life.toolbox
 * (ensureToolbox), which persists. Owning a tool removes the need to rent
 * it at the junkyard (junkyard pulls gate on toolbox categories). The base
 * game only ever gave the starter kit; this is the first way to acquire
 * more. Durable tools are one-per-player (show OWNED); consumables (WD-40)
 * stack a quantity.
 */
import type { LifeState, ToolItem } from '@/state/life';
import { ensureToolbox } from '@/sim/toolbox';
import { showNotif } from '@/ui/notif';

export interface ToolShopItem {
  id: string;
  name: string;
  category: ToolItem['category'];
  spec?: string;
  price: number;
  /** Consumables re-buy and add `qty`; durables are one-time. */
  consumable?: boolean;
  qty?: number;
  /** One-line pitch (what it unlocks). */
  blurb: string;
}

export const TOOL_SHOP: readonly ToolShopItem[] = [
  { id: 'tire_machine', name: 'Tire Machine',     category: 'tire',       price: 420, blurb: 'Pull tires at the junkyard free' },
  { id: 'engine_hoist', name: 'Engine Hoist',     category: 'power',      price: 560, blurb: 'Heavy engine + trans pulls' },
  { id: 'impact_wrench', name: 'Impact Wrench',   category: 'power',      price: 190, blurb: 'Faster nut-busting' },
  { id: 'socket_imperial', name: 'Imperial Sockets', category: 'socket', spec: 'imperial', price: 95, blurb: 'For older / US iron' },
  { id: 'wd40', name: 'WD-40 (3-pack)',           category: 'consumable', price: 15, consumable: true, qty: 3, blurb: 'Frees rusted bolts' },
];

/** True if the player already owns this durable tool (by id). */
export function ownsTool(life: LifeState, item: ToolShopItem): boolean {
  if (item.consumable) return false; // always re-buyable
  return ensureToolbox(life).some((t) => t.id === item.id);
}

/** Buy a tool: deduct money, add/stack it in the toolbox. Returns true on
 *  success (caller shows its own notif via the return, or we notify here). */
export function buyTool(life: LifeState, item: ToolShopItem): boolean {
  if (life.money < item.price) { showNotif(life, "✗ Can't afford " + item.name, 120); return false; }
  const box = ensureToolbox(life);
  if (item.consumable) {
    const existing = box.find((t) => t.id === item.id);
    if (existing) existing.qty = (existing.qty ?? 0) + (item.qty ?? 1);
    else box.push({ id: item.id, name: item.name.replace(/\s*\(.*\)$/, ''), category: item.category, qty: item.qty ?? 1, spec: item.spec });
    life.money -= item.price;
    showNotif(life, '🧰 Bought ' + item.name, 150);
    return true;
  }
  if (ownsTool(life, item)) { showNotif(life, 'Already owned', 90); return false; }
  box.push({ id: item.id, name: item.name, category: item.category, qty: 1, spec: item.spec });
  life.money -= item.price;
  showNotif(life, '🧰 Bought ' + item.name + ' — added to garage', 180);
  return true;
}
