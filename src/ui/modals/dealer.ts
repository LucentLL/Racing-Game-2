/**
 * H1001: Car dealership drive-in screen.
 *
 * Opened by driving into a placed 'dealership' building (buildingHint ENTER).
 * Re-homes the used-car LOT browser that used to live as a pause-menu tab
 * (the LOT tab is removed) into a standalone full-screen venue:
 *   - BUY: 8 used-car picks (life._carLot, generateCarLot) → the shared
 *     finance/purchase modal (life.purchaseMenu → completePurchase).
 *   - SELL: trade the current car in at the dealer (quickSellCar, 50% value).
 *   - RESHUFFLE the lot; LEAVE closes.
 *
 * State: life.dealerOpen (transient — not persisted; rides the opaque LIFE
 * blob, no save-schema bump). Row/button hit-rects cache on life._dealerHits.
 * The modal eats every tap while open; the purchase modal (drawn on top)
 * takes precedence in the tap router.
 */
import type { LifeState } from '@/state/life';
import { CAR_CATALOG } from '@/config/cars/catalog';
import { GT2_COLORS, drawGt2Backdrop } from '@/ui/gt2Chrome';
import { generateCarLot, type CarLotListing } from '@/sim/carLot';
import { getFinanceOptions } from '@/sim/finance';
import { quickSellCar } from '@/ui/screens/home/overlay';

interface Rect { x: number; y: number; w: number; h: number }
interface DealerHits {
  rows: Array<Rect & { idx: number }>;
  reshuffle: Rect;
  sell: Rect | null;
  leave: Rect;
}

function money(n: number): string { return '$' + Math.round(n).toLocaleString(); }

/** Draw the dealership overlay. No-op unless life.dealerOpen. */
export function drawDealerOverlay(
  ctx: CanvasRenderingContext2D,
  life: LifeState,
  GW: number,
  GH: number,
  day: number,
): void {
  if (!life.dealerOpen) return;
  if (!life._carLot || life._carLot.length === 0) life._carLot = generateCarLot(day);
  const lot = life._carLot as CarLotListing[];
  const C = GT2_COLORS;

  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, GW, GH);
  drawGt2Backdrop(ctx, GW, GH);

  ctx.textAlign = 'center';
  ctx.fillStyle = C.amber;
  ctx.font = 'bold 14px monospace';
  ctx.fillText('CAR DEALERSHIP', GW / 2, 18);
  ctx.fillStyle = C.textMute;
  ctx.font = '9px monospace';
  ctx.fillText('USED LOT  ·  ' + money(life.money), GW / 2, 30);

  const rowH = 30;
  const top = 44;
  const rows: DealerHits['rows'] = [];
  for (let i = 0; i < lot.length; i++) {
    const cl = lot[i];
    const car = CAR_CATALOG[cl.id];
    const ly = top + i * rowH;
    const canBuy = life.money >= cl.price;
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.fillRect(8, ly, GW - 16, 26);
    ctx.strokeStyle = canBuy ? C.amberDark : '#333';
    ctx.lineWidth = 1;
    ctx.strokeRect(8.5, ly + 0.5, GW - 17, 25);
    if (car) { ctx.fillStyle = car.color; ctx.fillRect(12, ly + 4, 12, 18); }
    ctx.textAlign = 'left';
    ctx.fillStyle = canBuy ? C.amber : '#666';
    ctx.font = 'bold 9px monospace';
    ctx.fillText(cl.name, 30, ly + 11);
    ctx.fillStyle = C.textMute;
    ctx.font = '9px monospace';
    const mi = cl.isNew ? 'NEW'
      : (cl.mileage >= 1000 ? Math.round(cl.mileage / 1000) + 'k mi' : cl.mileage + ' mi');
    ctx.fillText(money(cl.price) + '  ' + cl.cond + '%  ' + (car ? car.hp + 'hp  ' : '') + mi, 30, ly + 21);
    rows.push({ x: 8, y: ly, w: GW - 16, h: 26, idx: i });
  }

  let by = top + lot.length * rowH + 8;
  const btn = (y: number, label: string, accent: string, fill: string): Rect => {
    ctx.fillStyle = fill;
    ctx.fillRect(30, y, GW - 60, 22);
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1;
    ctx.strokeRect(30.5, y + 0.5, GW - 61, 21);
    ctx.fillStyle = accent;
    ctx.font = 'bold 10px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(label, GW / 2, y + 15);
    return { x: 30, y, w: GW - 60, h: 22 };
  };

  const reshuffle = btn(by, '🔁 RESHUFFLE LOT', '#0ff', 'rgba(0,140,200,0.15)');
  by += 28;
  // SELL: trade in the current car (needs >1 car so the player keeps one).
  let sell: Rect | null = null;
  if (life.ownedCars.length > 1) {
    const activeId = life.ownedCars[0];
    const car = CAR_CATALOG[activeId];
    sell = btn(by, `💵 TRADE IN ${car ? car.name : 'car'} (~50% value)`, '#7c5', 'rgba(30,120,40,0.18)');
    by += 28;
  }
  const leave = btn(by, '⟵ LEAVE', C.amber, 'rgba(120,90,20,0.18)');

  ctx.textAlign = 'left';
  (life as { _dealerHits?: DealerHits })._dealerHits = { rows, reshuffle, sell, leave };
}

/** Route a tap through the dealership. Returns true if consumed. */
export function handleDealerClick(
  tx: number, ty: number, life: LifeState, day: number,
): boolean {
  if (!life.dealerOpen) return false;
  const hits = (life as { _dealerHits?: DealerHits })._dealerHits;
  if (!hits) return true; // swallow taps until first draw caches hits
  const inside = (r: Rect | null): boolean =>
    !!r && tx >= r.x && tx <= r.x + r.w && ty >= r.y && ty <= r.y + r.h;

  if (inside(hits.leave)) { life.dealerOpen = false; return true; }
  if (inside(hits.reshuffle)) { life._carLot = generateCarLot(day); return true; }
  if (hits.sell && inside(hits.sell)) {
    if (life.ownedCars.length > 1) quickSellCar(life, life.ownedCars[0]);
    return true;
  }
  for (const r of hits.rows) {
    if (inside(r)) {
      const cl = (life._carLot as CarLotListing[])[r.idx];
      if (!cl) return true;
      if (life.money < cl.price * 0.1) return true; // can't cover minimal down — ignore
      life.purchaseMenu = {
        carId: cl.id,
        carName: cl.name,
        price: cl.price,
        isNew: cl.isNew,
        source: 'lot',
        index: r.idx,
        options: getFinanceOptions(cl.price, cl.isNew),
        listing: { mileage: cl.mileage },
      } as LifeState['purchaseMenu'];
      return true;
    }
  }
  return true; // eat all taps while open
}
