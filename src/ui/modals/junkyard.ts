/**
 * H1002: Junkyard drive-in screen — SALVAGE YARD.
 *
 * Two tabs:
 *   PULL PARTS — a rolled inventory of used donor parts (engine / tires /
 *     body), each with a QUALITY of 0..90% (the condition it installs to).
 *     Pulling needs the right TOOL: the player's garage toolbox covers most
 *     (bring your own), else RENT a kit for the visit (flat fee, no haggle).
 *     Quality 0..12% = unusable scrap (can't pull).
 *   SCRAP CAR — sell a car to the yard for 8% MSRP (guards your last car).
 *
 * State (all transient, opaque LIFE blob — no save-schema bump):
 *   life.junkyardOpen, _junkyardTab, _junkyardParts, _junkyardRented,
 *   _junkyardHits.
 */
import type { LifeState } from '@/state/life';
import { CAR_CATALOG } from '@/config/cars/catalog';
import { GT2_COLORS, drawGt2Backdrop } from '@/ui/gt2Chrome';
import { showNotif } from '@/ui/notif';
import { ensureToolbox } from '@/sim/toolbox';
import {
  generateJunkyardParts,
  hasToolCategory,
  installJunkPart,
  activeStatValue,
  activeCarName,
  JUNK_UNUSABLE_MAX,
  TOOL_RENTAL_FEE,
  type JunkyardPart,
} from '@/sim/junkyardParts';

interface Rect { x: number; y: number; w: number; h: number }
type JunkTab = 'parts' | 'scrap';
interface JunkyardHits {
  tabs: Array<Rect & { key: JunkTab }>;
  pulls: Array<Rect & { idx: number }>;
  rent: Rect | null;
  scrap: Array<Rect & { carId: string }>;
  leave: Rect;
}

const STAT_LABEL: Record<JunkyardPart['stat'], string> = {
  engine: 'engine', tires: 'tires', hp: 'body',
};

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

/** True if the player can pull this part (owns the tool OR has rented). */
function canPull(life: LifeState, part: JunkyardPart): boolean {
  if (life._junkyardRented) return true;
  return hasToolCategory(ensureToolbox(life), part.toolReq);
}

/** Draw the junkyard overlay. No-op unless life.junkyardOpen. */
export function drawJunkyardOverlay(
  ctx: CanvasRenderingContext2D,
  life: LifeState,
  GW: number,
  GH: number,
  day: number,
): void {
  if (!life.junkyardOpen) return;
  if (!life._junkyardParts) life._junkyardParts = generateJunkyardParts(day);
  const parts = life._junkyardParts as JunkyardPart[];
  const tab: JunkTab = (life._junkyardTab as JunkTab | undefined) ?? 'parts';
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
  ctx.fillText(activeCarName(life) + '  ·  $' + Math.round(life.money).toLocaleString(), GW / 2, 30);

  // Tab strip (2 tabs).
  const tabDefs: Array<{ key: JunkTab; label: string }> = [
    { key: 'parts', label: 'PULL PARTS' },
    { key: 'scrap', label: 'SCRAP CAR' },
  ];
  const tabW = Math.floor(GW / tabDefs.length);
  const tabs: JunkyardHits['tabs'] = [];
  for (let i = 0; i < tabDefs.length; i++) {
    const td = tabDefs[i];
    const txp = i * tabW;
    const active = tab === td.key;
    ctx.fillStyle = active ? C.amber : C.panel;
    ctx.fillRect(txp, 36, tabW - 1, 18);
    ctx.strokeStyle = active ? C.amber : C.amberDark;
    ctx.lineWidth = 1;
    ctx.strokeRect(txp + 0.5, 36.5, tabW - 2, 17);
    ctx.fillStyle = active ? C.bgDeep : C.amber;
    ctx.font = 'bold 9px monospace';
    ctx.fillText(td.label, txp + tabW / 2, 49);
    tabs.push({ x: txp, y: 36, w: tabW - 1, h: 18, key: td.key });
  }

  const pulls: JunkyardHits['pulls'] = [];
  let rent: Rect | null = null;
  const scrap: JunkyardHits['scrap'] = [];

  if (tab === 'parts') {
    // Tool status + rent line.
    const rented = !!life._junkyardRented;
    let ty = 62;
    ctx.textAlign = 'left';
    ctx.font = '8px monospace';
    ctx.fillStyle = C.textMute;
    ctx.fillText(rented ? 'TOOLS: rented for this visit ✓'
      : 'TOOLS: bring your own or RENT for a pull you lack', 10, ty + 6);
    if (!rented) {
      const rw = 92, rx = GW - 10 - rw;
      const afford = life.money >= TOOL_RENTAL_FEE;
      ctx.fillStyle = afford ? 'rgba(120,90,20,0.28)' : 'rgba(80,80,80,0.2)';
      ctx.fillRect(rx, ty - 4, rw, 16);
      ctx.strokeStyle = afford ? C.amber : '#555';
      ctx.strokeRect(rx + 0.5, ty - 3.5, rw - 1, 15);
      ctx.fillStyle = afford ? C.amber : '#777';
      ctx.font = 'bold 8px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('🔧 RENT $' + TOOL_RENTAL_FEE, rx + rw / 2, ty + 7);
      if (afford) rent = { x: rx, y: ty - 4, w: rw, h: 16 };
    }

    // Part rows.
    const rowH = 34;
    const top = 80;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      const ly = top + i * rowH;
      const unusable = p.quality <= JUNK_UNUSABLE_MAX;
      const pull = !unusable && canPull(life, p);
      const afford = life.money >= p.price;
      ctx.fillStyle = 'rgba(255,255,255,0.05)';
      ctx.fillRect(8, ly, GW - 16, 30);
      ctx.strokeStyle = C.amberDark;
      ctx.lineWidth = 1;
      ctx.strokeRect(8.5, ly + 0.5, GW - 17, 29);
      ctx.textAlign = 'left';
      ctx.fillStyle = unusable ? '#888' : C.amber;
      ctx.font = 'bold 9px monospace';
      ctx.fillText(p.name, 12, ly + 12);
      // quality bar
      const qx = 12, qy = ly + 17, qw = 90, qh = 5;
      ctx.fillStyle = 'rgba(0,0,0,0.4)';
      ctx.fillRect(qx, qy, qw, qh);
      const qcol = p.quality <= JUNK_UNUSABLE_MAX ? '#a33' : p.quality < 45 ? '#c93' : '#5c5';
      ctx.fillStyle = qcol;
      ctx.fillRect(qx, qy, Math.round(qw * p.quality / 100), qh);
      ctx.fillStyle = C.textMute;
      ctx.font = '8px monospace';
      ctx.fillText(p.quality + '% ' + STAT_LABEL[p.stat] + (unusable ? ' (SCRAP)' : ''), qx + qw + 6, qy + 5);
      // current stat hint
      ctx.fillText('you: ' + activeStatValue(life, p.stat) + '%', qx + qw + 6, ly + 12);
      // right: price + PULL button (or lock)
      const bw = 74, bx = GW - 8 - bw - 4, bhY = ly + 6;
      if (unusable) {
        ctx.fillStyle = '#666'; ctx.textAlign = 'center'; ctx.font = 'bold 8px monospace';
        ctx.fillText('UNUSABLE', bx + bw / 2, bhY + 12);
      } else if (!pull) {
        ctx.fillStyle = 'rgba(80,80,80,0.25)';
        ctx.fillRect(bx, bhY, bw, 18);
        ctx.strokeStyle = '#666'; ctx.strokeRect(bx + 0.5, bhY + 0.5, bw - 1, 17);
        ctx.fillStyle = '#999'; ctx.textAlign = 'center'; ctx.font = 'bold 7px monospace';
        ctx.fillText('🔒 ' + p.toolName, bx + bw / 2, bhY + 11);
      } else {
        ctx.fillStyle = afford ? 'rgba(30,120,40,0.22)' : 'rgba(80,80,80,0.2)';
        ctx.fillRect(bx, bhY, bw, 18);
        ctx.strokeStyle = afford ? '#5c5' : '#555';
        ctx.strokeRect(bx + 0.5, bhY + 0.5, bw - 1, 17);
        ctx.fillStyle = afford ? '#8f8' : '#777';
        ctx.textAlign = 'center'; ctx.font = 'bold 8px monospace';
        ctx.fillText('PULL $' + p.price, bx + bw / 2, bhY + 12);
        if (afford) pulls.push({ x: bx, y: bhY, w: bw, h: 18, idx: i });
      }
    }
    if (parts.length === 0) {
      ctx.textAlign = 'center'; ctx.fillStyle = C.textMute; ctx.font = '9px monospace';
      ctx.fillText('(picked clean — come back later)', GW / 2, top + 10);
    }
  } else {
    // SCRAP tab — owned cars.
    const rowH = 34, top = 62;
    const onlyCar = life.ownedCars.length <= 1;
    for (let i = 0; i < life.ownedCars.length; i++) {
      const carId = life.ownedCars[i];
      const car = CAR_CATALOG[carId];
      if (!car) continue;
      const ly = top + i * rowH;
      ctx.fillStyle = 'rgba(255,255,255,0.06)';
      ctx.fillRect(8, ly, GW - 16, 30);
      ctx.strokeStyle = C.amberDark; ctx.lineWidth = 1;
      ctx.strokeRect(8.5, ly + 0.5, GW - 17, 29);
      ctx.fillStyle = car.color; ctx.fillRect(12, ly + 5, 12, 20);
      ctx.textAlign = 'left'; ctx.fillStyle = C.amber; ctx.font = 'bold 9px monospace';
      ctx.fillText(car.name + (i === 0 ? '  (driving)' : ''), 30, ly + 12);
      ctx.fillStyle = C.textMute; ctx.font = '9px monospace';
      ctx.fillText('scrap offer  $' + scrapOffer(carId).toLocaleString(), 30, ly + 24);
      const bw = 66, bx = GW - 8 - bw - 6, bhY = ly + 6;
      ctx.fillStyle = onlyCar ? 'rgba(80,80,80,0.2)' : 'rgba(150,40,40,0.30)';
      ctx.fillRect(bx, bhY, bw, 18);
      ctx.strokeStyle = onlyCar ? '#555' : '#c55';
      ctx.strokeRect(bx + 0.5, bhY + 0.5, bw - 1, 17);
      ctx.fillStyle = onlyCar ? '#777' : '#f88'; ctx.font = 'bold 9px monospace'; ctx.textAlign = 'center';
      ctx.fillText('♻ SCRAP', bx + bw / 2, bhY + 12);
      if (!onlyCar) scrap.push({ x: bx, y: bhY, w: bw, h: 18, carId });
    }
    if (onlyCar) {
      ctx.textAlign = 'center'; ctx.fillStyle = C.textMute; ctx.font = '9px monospace';
      ctx.fillText('(you always keep one car to drive)', GW / 2, top + life.ownedCars.length * rowH + 8);
    }
  }

  const leaveY = GH - 40;
  ctx.fillStyle = 'rgba(120,90,20,0.18)';
  ctx.fillRect(30, leaveY, GW - 60, 24);
  ctx.strokeStyle = C.amber; ctx.lineWidth = 1;
  ctx.strokeRect(30.5, leaveY + 0.5, GW - 61, 23);
  ctx.fillStyle = C.amber; ctx.font = 'bold 10px monospace'; ctx.textAlign = 'center';
  ctx.fillText('⟵ LEAVE', GW / 2, leaveY + 16);

  ctx.textAlign = 'left';
  (life as { _junkyardHits?: JunkyardHits })._junkyardHits = {
    tabs, pulls, rent, scrap, leave: { x: 30, y: leaveY, w: GW - 60, h: 24 },
  };
}

/** Route a tap through the junkyard. Returns true if consumed. */
export function handleJunkyardClick(tx: number, ty: number, life: LifeState): boolean {
  if (!life.junkyardOpen) return false;
  const hits = (life as { _junkyardHits?: JunkyardHits })._junkyardHits;
  if (!hits) return true;
  const inside = (r: Rect | null): boolean =>
    !!r && tx >= r.x && tx <= r.x + r.w && ty >= r.y && ty <= r.y + r.h;

  if (inside(hits.leave)) {
    life.junkyardOpen = false;
    life._junkyardRented = false;   // rental is per-visit
    life._junkyardParts = undefined; // fresh stock next visit
    return true;
  }
  for (const t of hits.tabs) {
    if (inside(t)) { life._junkyardTab = t.key; return true; }
  }
  if (inside(hits.rent)) {
    if (life.money >= TOOL_RENTAL_FEE) {
      life.money -= TOOL_RENTAL_FEE;
      life._junkyardRented = true;
      showNotif(life, '🔧 Rented a tool kit for this visit', 150);
    }
    return true;
  }
  for (const pr of hits.pulls) {
    if (inside(pr)) {
      const parts = life._junkyardParts as JunkyardPart[] | undefined;
      const p = parts?.[pr.idx];
      if (!p) return true;
      if (p.quality <= JUNK_UNUSABLE_MAX) { showNotif(life, '✗ That part is scrap', 120); return true; }
      if (!life._junkyardRented && !canPull(life, p)) {
        showNotif(life, '✗ Need ' + p.toolName + ' — rent a kit', 150); return true;
      }
      if (life.money < p.price) { showNotif(life, "✗ Can't afford that part", 120); return true; }
      life.money -= p.price;
      const delta = installJunkPart(life, p);
      parts!.splice(pr.idx, 1);
      showNotif(
        life,
        delta > 0
          ? '♻ Pulled ' + p.name + ' (' + p.quality + '%) — +' + delta + ' ' + STAT_LABEL[p.stat]
          : '♻ Pulled ' + p.name + ' — but your ' + STAT_LABEL[p.stat] + ' was already better',
        200,
      );
      return true;
    }
  }
  for (const s of hits.scrap) {
    if (inside(s)) { scrapCarAtJunkyard(life, s.carId); return true; }
  }
  return true;
}
