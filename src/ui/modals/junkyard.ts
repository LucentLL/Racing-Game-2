/**
 * H1002: Junkyard drive-in screen.
 *
 * Opened by driving into a placed 'junkyard' building. The junkyard's shipped
 * primitive is SCRAP-FOR-CASH: sell a car to the yard for 8% of its catalog
 * price (matches the existing tow-menu scrap value). Guards the player's last
 * car (you always keep one to drive). Lists every owned car with its scrap
 * offer; tap SCRAP to sell it.
 *
 * (The broader junkyard design — used-parts salvage feeding the repair
 * economy, "build a car from parts" — is future; this is the concrete first
 * screen.)
 *
 * State: life.junkyardOpen (transient — rides the opaque LIFE blob, no save-
 * schema bump). Hit-rects cache on life._junkyardHits. Eats every tap.
 */
import type { LifeState } from '@/state/life';
import { CAR_CATALOG } from '@/config/cars/catalog';
import { GT2_COLORS, drawGt2Backdrop } from '@/ui/gt2Chrome';
import { showNotif } from '@/ui/notif';

interface Rect { x: number; y: number; w: number; h: number }
interface JunkyardHits {
  scrap: Array<Rect & { carId: string }>;
  leave: Rect;
}

/** 8% of catalog price — the yard's scrap offer (parity with tow-menu). */
function scrapOffer(carId: string): number {
  const car = CAR_CATALOG[carId];
  return car ? Math.round(car.price * 0.08) : 0;
}

/** Scrap a car for cash. Guards the last car. Pays off any loan out of the
 *  offer (net can be negative — shown to the player). */
export function scrapCarAtJunkyard(life: LifeState, carId: string): void {
  if (life.ownedCars.length <= 1) {
    showNotif(life, "✗ Can't scrap your only car", 150);
    return;
  }
  const car = CAR_CATALOG[carId];
  if (!car) return;
  const offer = scrapOffer(carId);
  const loan = life.carLoans.find((l) => l.carId === carId);
  const payoff = loan ? loan.monthlyPayment * loan.monthsRemaining : 0;
  life.money += offer - payoff;
  life.ownedCars = life.ownedCars.filter((c) => c !== carId);
  life.carLoans = life.carLoans.filter((l) => l.carId !== carId);
  life.carAds = (life.carAds as Array<{ carId?: string }> | undefined)
    ?.filter((a) => a?.carId !== carId) ?? [];
  life._garageExpandedIdx = undefined;
  showNotif(
    life,
    '♻ Scrapped ' + car.name + (loan
      ? ' (NET ' + (offer - payoff >= 0 ? '+$' : '-$') + Math.abs(offer - payoff).toLocaleString() + ')'
      : ' for $' + offer.toLocaleString()),
    180,
  );
}

/** Draw the junkyard overlay. No-op unless life.junkyardOpen. */
export function drawJunkyardOverlay(
  ctx: CanvasRenderingContext2D,
  life: LifeState,
  GW: number,
  GH: number,
): void {
  if (!life.junkyardOpen) return;
  const C = GT2_COLORS;
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, GW, GH);
  drawGt2Backdrop(ctx, GW, GH);

  ctx.textAlign = 'center';
  ctx.fillStyle = C.amber;
  ctx.font = 'bold 14px monospace';
  ctx.fillText('JUNKYARD', GW / 2, 18);
  ctx.fillStyle = C.textMute;
  ctx.font = '9px monospace';
  ctx.fillText('SCRAP FOR CASH  ·  $' + Math.round(life.money).toLocaleString(), GW / 2, 30);

  const rowH = 34;
  const top = 46;
  const scrap: JunkyardHits['scrap'] = [];
  const onlyCar = life.ownedCars.length <= 1;
  for (let i = 0; i < life.ownedCars.length; i++) {
    const carId = life.ownedCars[i];
    const car = CAR_CATALOG[carId];
    if (!car) continue;
    const ly = top + i * rowH;
    const isActive = i === 0;
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.fillRect(8, ly, GW - 16, 30);
    ctx.strokeStyle = C.amberDark;
    ctx.lineWidth = 1;
    ctx.strokeRect(8.5, ly + 0.5, GW - 17, 29);
    ctx.fillStyle = car.color; ctx.fillRect(12, ly + 5, 12, 20);
    ctx.textAlign = 'left';
    ctx.fillStyle = C.amber;
    ctx.font = 'bold 9px monospace';
    ctx.fillText(car.name + (isActive ? '  (driving)' : ''), 30, ly + 12);
    ctx.fillStyle = C.textMute;
    ctx.font = '9px monospace';
    ctx.fillText('scrap offer  $' + scrapOffer(carId).toLocaleString(), 30, ly + 24);
    // SCRAP button (disabled for the only car).
    const bw = 66, bx = GW - 8 - bw - 6, bhY = ly + 6;
    const canScrap = !onlyCar;
    ctx.fillStyle = canScrap ? 'rgba(150,40,40,0.30)' : 'rgba(80,80,80,0.2)';
    ctx.fillRect(bx, bhY, bw, 18);
    ctx.strokeStyle = canScrap ? '#c55' : '#555';
    ctx.strokeRect(bx + 0.5, bhY + 0.5, bw - 1, 17);
    ctx.fillStyle = canScrap ? '#f88' : '#777';
    ctx.font = 'bold 9px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('♻ SCRAP', bx + bw / 2, bhY + 12);
    if (canScrap) scrap.push({ x: bx, y: bhY, w: bw, h: 18, carId });
  }
  if (onlyCar) {
    ctx.textAlign = 'center';
    ctx.fillStyle = C.textMute;
    ctx.font = '9px monospace';
    ctx.fillText('(you always keep one car to drive)', GW / 2, top + life.ownedCars.length * rowH + 8);
  }

  const leaveY = GH - 40;
  ctx.fillStyle = 'rgba(120,90,20,0.18)';
  ctx.fillRect(30, leaveY, GW - 60, 24);
  ctx.strokeStyle = C.amber;
  ctx.lineWidth = 1;
  ctx.strokeRect(30.5, leaveY + 0.5, GW - 61, 23);
  ctx.fillStyle = C.amber;
  ctx.font = 'bold 10px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('⟵ LEAVE', GW / 2, leaveY + 16);

  ctx.textAlign = 'left';
  (life as { _junkyardHits?: JunkyardHits })._junkyardHits = {
    scrap,
    leave: { x: 30, y: leaveY, w: GW - 60, h: 24 },
  };
}

/** Route a tap through the junkyard. Returns true if consumed. */
export function handleJunkyardClick(tx: number, ty: number, life: LifeState): boolean {
  if (!life.junkyardOpen) return false;
  const hits = (life as { _junkyardHits?: JunkyardHits })._junkyardHits;
  if (!hits) return true;
  const inside = (r: Rect): boolean => tx >= r.x && tx <= r.x + r.w && ty >= r.y && ty <= r.y + r.h;
  if (inside(hits.leave)) { life.junkyardOpen = false; return true; }
  for (const s of hits.scrap) {
    if (inside(s)) { scrapCarAtJunkyard(life, s.carId); return true; }
  }
  return true;
}
