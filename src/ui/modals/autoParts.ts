/**
 * H1003: Auto Parts store drive-in screen.
 *
 * Opened by driving into a placed 'autoparts' building. Two tabs:
 *   AFTERMARKET — buy the next performance-upgrade stage for the active car
 *     (power / weight / brakes / suspension / tires), reusing the existing
 *     upgrade economy (getUpgradeStagePlan + orderUpgrade at SHOP price; the
 *     build queues via life.pendingParts and completes on day-rollover).
 *   TOOLS — buy tools into the garage toolbox (toolShop). Owning a tool
 *     removes the junkyard rental need (e.g. a Tire Machine).
 *
 * State: life.autoPartsOpen / _autoPartsTab / _autoPartsHits — transient
 * (opaque LIFE blob, no save-schema bump). The upgrade/tool purchases route
 * through the persisted life.pendingParts / life.toolbox.
 */
import type { LifeState } from '@/state/life';
import type { Clock } from '@/state/clock';
import { CAR_CATALOG } from '@/config/cars/catalog';
import { GT2_COLORS, drawGt2Backdrop } from '@/ui/gt2Chrome';
import { showNotif } from '@/ui/notif';
import { UPGRADE_CATEGORIES, getCarUpgrades } from '@/config/cars/upgradeHeadroom';
import { getUpgradeStagePlan, hasPendingUpgrade, orderUpgrade } from '@/sim/upgradeCost';
import { TOOL_SHOP, buyTool, ownsTool } from '@/sim/toolShop';

interface Rect { x: number; y: number; w: number; h: number }
type PartsTab = 'aftermarket' | 'tools';

/** H1076: mail-order surcharges — the drive-in store stays cheapest. */
const MAIL_SHIPPING_FLAT = 15;
const MAIL_SHIPPING_DAYS = 2;
interface AutoPartsHits {
  tabs: Array<Rect & { key: PartsTab }>;
  upgrades: Array<Rect & { kind: string }>;
  tools: Array<Rect & { idx: number }>;
  leave: Rect;
}

function money(n: number): string { return '$' + Math.round(n).toLocaleString(); }

function activeCar(life: LifeState) {
  const id = life.ownedCars?.[0];
  return id ? CAR_CATALOG[id] : undefined;
}

/** Draw the auto-parts overlay. No-op unless life.autoPartsOpen. */
export function drawAutoPartsOverlay(
  ctx: CanvasRenderingContext2D,
  life: LifeState,
  GW: number,
  GH: number,
): void {
  if (!life.autoPartsOpen) return;
  const tab: PartsTab = (life._autoPartsTab as PartsTab | undefined) ?? 'aftermarket';
  const C = GT2_COLORS;
  const car = activeCar(life);
  // H1076: mail-order mode — same catalog browsed from the couch via
  // the HOME 📖 CATALOG button. Tools ship (+$15, 2 days) instead of
  // handing over the counter; upgrades add 2 shipping days.
  const mail = !!life._autoPartsMailOrder;

  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, GW, GH);
  drawGt2Backdrop(ctx, GW, GH);

  ctx.textAlign = 'center';
  ctx.fillStyle = C.amber;
  ctx.font = 'bold 14px monospace';
  ctx.fillText(mail ? '📖 PARTS CATALOG' : 'AUTO PARTS', GW / 2, 18);
  ctx.fillStyle = C.textMute;
  ctx.font = '9px monospace';
  ctx.fillText(
    (car ? car.name : '— no car —') + '  ·  ' + money(life.money)
    + (mail ? '  ·  mail order — ships in 2 days' : ''),
    GW / 2, 30,
  );

  const tabDefs: Array<{ key: PartsTab; label: string }> = [
    { key: 'aftermarket', label: 'AFTERMARKET' },
    { key: 'tools', label: 'TOOLS' },
  ];
  const tabW = Math.floor(GW / tabDefs.length);
  const tabs: AutoPartsHits['tabs'] = [];
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

  const upgrades: AutoPartsHits['upgrades'] = [];
  const tools: AutoPartsHits['tools'] = [];

  if (tab === 'aftermarket') {
    const rowH = 40;
    const top = 62;
    if (!car) {
      ctx.textAlign = 'center'; ctx.fillStyle = C.textMute; ctx.font = '9px monospace';
      ctx.fillText('(no car to upgrade)', GW / 2, top + 10);
    }
    const levels = car ? getCarUpgrades(life, car.id) : null;
    for (let i = 0; car && levels && i < UPGRADE_CATEGORIES.length; i++) {
      const cat = UPGRADE_CATEGORIES[i];
      const stage = levels[cat.kind];
      const ly = top + i * rowH;
      ctx.fillStyle = 'rgba(255,255,255,0.05)';
      ctx.fillRect(8, ly, GW - 16, 36);
      ctx.strokeStyle = C.amberDark; ctx.lineWidth = 1;
      ctx.strokeRect(8.5, ly + 0.5, GW - 17, 35);
      ctx.textAlign = 'left';
      ctx.fillStyle = C.amber; ctx.font = 'bold 9px monospace';
      ctx.fillText(cat.label, 12, ly + 12);
      // stage pips 0-4
      for (let s = 1; s <= 4; s++) {
        ctx.fillStyle = s <= stage ? C.amber : 'rgba(255,255,255,0.14)';
        ctx.fillRect(12 + (s - 1) * 12, ly + 18, 9, 6);
      }
      const pending = hasPendingUpgrade(life, car.id, cat.kind);
      const plan = getUpgradeStagePlan(car, cat.kind, stage + 1, life);
      // right side: price + BUY / MAX / BUILDING
      const bw = 92, bx = GW - 8 - bw - 4, bhY = ly + 9;
      if (pending) {
        ctx.fillStyle = C.textMute; ctx.font = '8px monospace'; ctx.textAlign = 'center';
        ctx.fillText('⏳ BUILDING', bx + bw / 2, ly + 15);
        ctx.fillText('ready day ' + pending.readyDay, bx + bw / 2, ly + 27);
      } else if (!plan) {
        ctx.fillStyle = '#5c5'; ctx.font = 'bold 9px monospace'; ctx.textAlign = 'center';
        ctx.fillText('✓ MAX', bx + bw / 2, ly + 22);
      } else {
        ctx.textAlign = 'left';
        ctx.fillStyle = C.textMute; ctx.font = '8px monospace';
        ctx.fillText('S' + plan.toStage + ': +' + plan.delta + plan.unit, 60, ly + 12);
        const afford = life.money >= plan.shopPrice;
        ctx.fillStyle = afford ? 'rgba(30,120,40,0.22)' : 'rgba(80,80,80,0.2)';
        ctx.fillRect(bx, bhY, bw, 18);
        ctx.strokeStyle = afford ? '#5c5' : '#555';
        ctx.strokeRect(bx + 0.5, bhY + 0.5, bw - 1, 17);
        ctx.fillStyle = afford ? '#8f8' : '#777';
        ctx.font = 'bold 8px monospace'; ctx.textAlign = 'center';
        ctx.fillText('BUY ' + money(plan.shopPrice), bx + bw / 2, bhY + 12);
        if (afford) upgrades.push({ x: bx, y: bhY, w: bw, h: 18, kind: cat.kind });
      }
    }
  } else {
    // TOOLS tab.
    const rowH = 34, top = 62;
    for (let i = 0; i < TOOL_SHOP.length; i++) {
      const it = TOOL_SHOP[i];
      const ly = top + i * rowH;
      const owned = ownsTool(life, it);
      // H1076: a durable already in the mail shows SHIPPING, not BUY.
      const shipping = !!life.pendingParts?.some(
        (p) => (p as { tool?: { id: string } }).tool?.id === it.id,
      );
      ctx.fillStyle = 'rgba(255,255,255,0.05)';
      ctx.fillRect(8, ly, GW - 16, 30);
      ctx.strokeStyle = C.amberDark; ctx.lineWidth = 1;
      ctx.strokeRect(8.5, ly + 0.5, GW - 17, 29);
      ctx.textAlign = 'left';
      ctx.fillStyle = owned ? '#888' : C.amber; ctx.font = 'bold 9px monospace';
      ctx.fillText(it.name, 12, ly + 12);
      ctx.fillStyle = C.textMute; ctx.font = '8px monospace';
      ctx.fillText(it.blurb, 12, ly + 23);
      const bw = 74, bx = GW - 8 - bw - 4, bhY = ly + 6;
      if (owned) {
        ctx.fillStyle = '#6a6'; ctx.font = 'bold 8px monospace'; ctx.textAlign = 'center';
        ctx.fillText('✓ OWNED', bx + bw / 2, bhY + 12);
      } else if (shipping && !it.consumable) {
        ctx.fillStyle = C.textMute; ctx.font = 'bold 8px monospace'; ctx.textAlign = 'center';
        ctx.fillText('⏳ SHIPPING', bx + bw / 2, bhY + 12);
      } else {
        const cost = mail ? it.price + MAIL_SHIPPING_FLAT : it.price;
        const afford = life.money >= cost;
        ctx.fillStyle = afford ? 'rgba(30,120,40,0.22)' : 'rgba(80,80,80,0.2)';
        ctx.fillRect(bx, bhY, bw, 18);
        ctx.strokeStyle = afford ? '#5c5' : '#555';
        ctx.strokeRect(bx + 0.5, bhY + 0.5, bw - 1, 17);
        ctx.fillStyle = afford ? '#8f8' : '#777';
        ctx.font = 'bold 8px monospace'; ctx.textAlign = 'center';
        ctx.fillText((mail ? 'ORDER ' : 'BUY ') + money(cost), bx + bw / 2, bhY + 12);
        if (afford) tools.push({ x: bx, y: bhY, w: bw, h: 18, idx: i });
      }
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
  (life as { _autoPartsHits?: AutoPartsHits })._autoPartsHits = {
    tabs, upgrades, tools, leave: { x: 30, y: leaveY, w: GW - 60, h: 24 },
  };
}

/** Route a tap through the auto-parts store. Returns true if consumed. */
export function handleAutoPartsClick(tx: number, ty: number, life: LifeState, clock: Clock): boolean {
  if (!life.autoPartsOpen) return false;
  const hits = (life as { _autoPartsHits?: AutoPartsHits })._autoPartsHits;
  if (!hits) return true;
  const inside = (r: Rect | null): boolean =>
    !!r && tx >= r.x && tx <= r.x + r.w && ty >= r.y && ty <= r.y + r.h;

  if (inside(hits.leave)) { life.autoPartsOpen = false; return true; }
  for (const t of hits.tabs) {
    if (inside(t)) { life._autoPartsTab = t.key; return true; }
  }
  for (const u of hits.upgrades) {
    if (inside(u)) {
      const car = activeCar(life);
      if (!car) return true;
      const kind = u.kind as import('@/config/cars/upgradeHeadroom').UpgradeKind;
      const stage = getCarUpgrades(life, car.id)[kind];
      const plan = getUpgradeStagePlan(car, kind, stage + 1, life);
      if (!plan) return true;
      const res = orderUpgrade(
        life, clock, car, plan, true /* shop */,
        life._autoPartsMailOrder ? MAIL_SHIPPING_DAYS : 0,
      );
      if (res.ok) {
        showNotif(life, '🔧 ' + kind + ' Stage ' + plan.toStage + ' ordered — ready day ' + res.readyDay, 200);
      } else if (res.reason === 'money') {
        showNotif(life, "✗ Can't afford that stage", 120);
      } else if (res.reason === 'pending') {
        showNotif(life, 'Already building that upgrade', 120);
      }
      return true;
    }
  }
  for (const to of hits.tools) {
    if (inside(to)) {
      const it = TOOL_SHOP[to.idx];
      // H1076: mail-order — charge now (+shipping), grant on arrival
      // via the pendingParts tool payload. Drive-in keeps buyTool.
      if (life._autoPartsMailOrder) {
        const cost = it.price + MAIL_SHIPPING_FLAT;
        if (life.money < cost) { showNotif(life, "✗ Can't afford " + it.name, 120); return true; }
        if (!it.consumable && life.pendingParts?.some((p) => p.tool?.id === it.id)) {
          showNotif(life, 'Already in the mail', 100);
          return true;
        }
        life.money -= cost;
        const readyDay = clock.day + MAIL_SHIPPING_DAYS;
        life.pendingParts.push({
          id: 'tool_' + it.id + '_' + clock.day,
          name: it.name,
          stat: 'engine',
          add: 0,
          readyDay,
          venue: 'diy',
          isDelivery: false,
          carId: '',
          tool: { id: it.id },
        });
        showNotif(life, '📦 ' + it.name + ' ordered — arrives Day ' + readyDay, 200);
      } else {
        buyTool(life, it);
      }
      return true;
    }
  }
  return true;
}
