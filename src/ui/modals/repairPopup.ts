/**
 * Repair popup — full-screen venue picker for a single fault.
 *
 * Opens when the player taps a fault row in the REPAIRS sub-view.
 * Shows the fault name, effect line, mechSkill bar, and three
 * venue choices (DIY / Mechanic / Dealer) with affordability and
 * skill-gate styling. Tap a venue → applyFaultFix runs immediately
 * + cash deducts; CANCEL dismisses without action.
 *
 * 1:1 port of monolith drawRepairPopup L42620-L42707 simplified for
 * the fault-only case. Parts repairs use their own immediate-order
 * ORDER button in src/ui/screens/home/overlay.ts drawGaragePartsView
 * (H567) — generalizing this popup to handle ShopPart entries is a
 * follow-up.
 *
 * Modal eats every tap so the player can't fall through to the
 * REPAIRS view beneath.
 */

import type { LifeState } from '@/state/life';
import type { Fault } from '@/sim/faults';
import { GT2_COLORS, drawGt2Backdrop } from '@/ui/gt2Chrome';
import { CAR_CATALOG } from '@/config/cars/catalog';
import { getFaultVenueOptions, applyFaultFix } from '@/sim/repairCost';
import { showNotif } from '@/ui/notif';

/** State stashed at life.repairPopup. Carries the fault + its index
 *  in life.faults for splice-on-fix. */
export interface RepairPopupState {
  fault: Fault;
  faultIdx: number;
}

interface RepairPopupHits {
  diy: { x: number; y: number; w: number; h: number; price: number; canDo: boolean; canAfford: boolean };
  mechanic: { x: number; y: number; w: number; h: number; price: number; canAfford: boolean };
  dealer: { x: number; y: number; w: number; h: number; price: number; canAfford: boolean };
  cancel: { x: number; y: number; w: number; h: number };
}

const STAT_LABEL: Record<string, string> = {
  engine: 'engine',
  tires: 'tires',
  hp: 'body',
  paint: 'paint',
};

/** Render the modal. No-op when life.repairPopup is null. */
export function drawRepairPopup(
  ctx: CanvasRenderingContext2D,
  life: LifeState,
  GW: number,
  GH: number,
): void {
  const rp = life.repairPopup as RepairPopupState | null | undefined;
  if (!rp) return;
  const fault = rp.fault;
  const activeCarId = life.ownedCars[0];
  const car = activeCarId ? CAR_CATALOG[activeCarId] : undefined;
  const venues = getFaultVenueOptions(fault, car, life);

  // H780: GT2 charcoal + grid backdrop.
  ctx.fillStyle = GT2_COLORS.bg;
  ctx.fillRect(0, 0, GW, GH);
  drawGt2Backdrop(ctx, GW, GH);
  ctx.textAlign = 'center';
  const popW = GW - 40;
  const popX = 20;
  let yy = Math.floor(GH * 0.12);

  // Title.
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 13px monospace';
  ctx.fillText('🔧 FIX: ' + fault.name, GW / 2, yy);
  yy += 16;
  // Effect line.
  ctx.fillStyle = '#aaa';
  ctx.font = '10px monospace';
  ctx.fillText(
    '+' + fault.add + '% ' + (STAT_LABEL[fault.stat] ?? fault.stat),
    GW / 2, yy,
  );
  yy += 20;
  // Skill bar.
  const skill = life.mechSkill ?? 0;
  ctx.fillStyle = '#888';
  ctx.font = '9px monospace';
  ctx.fillText('🔧 Mechanical Skill: ' + skill + '/100', GW / 2, yy);
  yy += 6;
  const barW = popW - 40;
  const barX = popX + 20;
  ctx.fillStyle = '#333';
  ctx.fillRect(barX, yy, barW, 6);
  ctx.fillStyle = '#0f0';
  ctx.fillRect(barX, yy, barW * (skill / 100), 6);
  yy += 16;

  // Venue rows. DIY first (cheapest when skill clears), then
  // Mechanic (always works, 2x cost), then Dealer (instant, 8x cost).
  // Body damage repairs aren't routed through a dealer in real life —
  // mirror the monolith's mod-only dealer skip by checking the stat,
  // but for now keep all 3 for every fault since modular doesn't
  // separate body-shop from dealer yet.
  const venueOrder: Array<{ key: 'diy' | 'mechanic' | 'dealer'; color: string }> = [
    { key: 'diy',      color: '#0f0' },
    { key: 'mechanic', color: '#0cf' },
    { key: 'dealer',   color: '#f80' },
  ];
  const hits: Partial<RepairPopupHits> = {};
  for (const vo of venueOrder) {
    const v = venues[vo.key];
    const canAfford = life.money >= v.price;
    const blocked = !v.canDo;
    const dimmed = blocked || !canAfford;
    ctx.fillStyle = dimmed ? 'rgba(40,40,40,0.5)' : 'rgba(255,255,255,0.08)';
    ctx.fillRect(popX, yy, popW, 42);
    ctx.strokeStyle = dimmed ? '#444' : vo.color;
    ctx.lineWidth = 1;
    ctx.strokeRect(popX, yy, popW, 42);
    // Venue label.
    ctx.fillStyle = dimmed ? '#555' : vo.color;
    ctx.font = 'bold 12px monospace';
    ctx.fillText(v.label, GW / 2, yy + 14);
    // Price.
    ctx.fillStyle = dimmed ? '#444' : '#fff';
    ctx.font = 'bold 11px monospace';
    ctx.fillText('$' + v.price.toLocaleString(), GW / 2, yy + 28);
    // Subline — time / blocked / affordability.
    ctx.fillStyle = dimmed ? '#444' : '#888';
    ctx.font = '9px monospace';
    const timeStr = v.time === 0 ? 'Instant' : v.time + 'd wait';
    if (blocked) {
      ctx.fillText(
        timeStr + ' • Need skill ' + v.skillReq + ' (have ' + skill + ')',
        GW / 2, yy + 38,
      );
    } else if (!canAfford) {
      ctx.fillText(timeStr + " • Can't afford", GW / 2, yy + 38);
    } else {
      ctx.fillText(timeStr, GW / 2, yy + 38);
    }
    if (vo.key === 'diy') {
      hits.diy = { x: popX, y: yy, w: popW, h: 42, price: v.price, canDo: v.canDo, canAfford };
    } else if (vo.key === 'mechanic') {
      hits.mechanic = { x: popX, y: yy, w: popW, h: 42, price: v.price, canAfford };
    } else {
      hits.dealer = { x: popX, y: yy, w: popW, h: 42, price: v.price, canAfford };
    }
    yy += 48;
  }

  // CANCEL button.
  const cancelY = yy + 6;
  ctx.fillStyle = 'rgba(255,60,60,0.15)';
  ctx.fillRect(popX + 40, cancelY, popW - 80, 28);
  ctx.strokeStyle = '#f44';
  ctx.strokeRect(popX + 40, cancelY, popW - 80, 28);
  ctx.fillStyle = '#f44';
  ctx.font = 'bold 11px monospace';
  ctx.fillText('✕ CANCEL', GW / 2, cancelY + 19);
  ctx.textAlign = 'left';
  hits.cancel = { x: popX + 40, y: cancelY, w: popW - 80, h: 28 };

  (life as { _repairPopupHits?: RepairPopupHits })._repairPopupHits = hits as RepairPopupHits;
}

/** Routes a tap through the cached hits. Returns true when consumed.
 *  Always returns true while a repairPopup is up so the modal eats
 *  every tap. */
export function handleRepairPopupTap(
  tx: number,
  ty: number,
  life: LifeState,
): boolean {
  const rp = life.repairPopup as RepairPopupState | null | undefined;
  if (!rp) return false;
  const hits = (life as { _repairPopupHits?: RepairPopupHits })._repairPopupHits;
  if (!hits) return true;
  const inside = (r: { x: number; y: number; w: number; h: number }): boolean =>
    tx >= r.x && tx <= r.x + r.w && ty >= r.y && ty <= r.y + r.h;

  if (inside(hits.cancel)) {
    life.repairPopup = null;
    return true;
  }

  // Venue routing. DIY gates on skill + cash; others gate on cash only.
  const tryFix = (
    rect: { x: number; y: number; w: number; h: number; price: number; canAfford: boolean; canDo?: boolean },
    isDIY: boolean,
  ): boolean => {
    if (!inside(rect)) return false;
    if (rect.canDo === false) {
      showNotif(life, '✗ Skill too low', 120);
      return true;
    }
    if (!rect.canAfford) {
      showNotif(life, "✗ Can't afford this venue", 120);
      return true;
    }
    life.money -= rect.price;
    applyFaultFix(life, rp.faultIdx, rp.fault, isDIY);
    showNotif(life, '🔧 ' + rp.fault.name + ' fixed (-$' + rect.price.toLocaleString() + ')', 180);
    life.repairPopup = null;
    return true;
  };
  if (tryFix(hits.diy, true)) return true;
  if (tryFix(hits.mechanic, false)) return true;
  if (tryFix(hits.dealer, false)) return true;
  return true; // swallow stray taps
}
