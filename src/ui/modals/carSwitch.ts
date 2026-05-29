/**
 * H708: Car-switch modal — owned-car list with tap-to-pick.
 *
 * Replaces the H245 interim auto-cycle that hardcoded
 * `ownedCars[1]` as the switch target. Because [[switchCar]]
 * rotates the array on every swap, that cycle could only ping-
 * pong between the first two owned cars — the third onward
 * were unreachable. User reported: "When I try to switch cars
 * from Status tab, it automatically switches to an NSX and
 * doesn't give me a choice."
 *
 * 1:1 in INTENT with monolith openCarSelect (L7686-L7715): a
 * scrollable list of all owned cars showing name + key stats,
 * tap on a row to commit the switch. The monolith uses a DOM
 * overlay (.cs-list innerHTML); modular renders to the canvas
 * HUD to match the rest of the modal pattern (towMenu,
 * gasStation, etc.).
 *
 * Trigger: pause-menu STATUS tab's SWITCH CAR button sets
 * life.carSwitchOpen=true (instead of immediately calling
 * runSwitchCar). drawCarSwitchMenu paints the modal next frame;
 * handleCarSwitchClick routes the tap.
 */

import type { LifeState } from '@/state/life';
import type { GameContext } from '@/state/gameState';
import { CAR_CATALOG } from '@/config/cars/catalog';
import { switchCar } from '@/sim/switchCar';
import { showNotif } from '@/ui/notif';

/** One row in the cached list — name resolved, hit-test rect
 *  populated by the render pass for the click handler. */
export interface CarSwitchRow {
  carId: string;
  name: string;
  hp: number;
  kg: number;
  drv: string;
  isActive: boolean;
  /** Filled in by drawCarSwitchMenu — top-Y of the painted rect. */
  _renderY?: number;
}

/** Build the row list from life.ownedCars. Active car first,
 *  rest in current array order (which is the user's recent-
 *  switch order from runSwitchCar's rotate-on-swap behavior). */
export function buildCarSwitchRows(life: LifeState): CarSwitchRow[] {
  const rows: CarSwitchRow[] = [];
  for (const cid of life.ownedCars) {
    const car = CAR_CATALOG[cid];
    if (!car) continue;
    rows.push({
      carId: cid,
      name: car.name,
      hp: car.hp,
      kg: car.kg,
      drv: car.isBike ? 'BIKE' : car.drv,
      isActive: cid === life.ownedCars[0],
    });
  }
  return rows;
}

const ROW_H = 38;
const ROW_GAP = 4;
const LIST_TOP = 60;
const CANCEL_H = 26;

/** Hit-test box for the CANCEL button — anchored to the bottom
 *  of the modal so it doesn't move when more cars are added. */
export function cancelRect(GW: number, GH: number): {
  x: number; y: number; w: number; h: number;
} {
  return { x: GW / 2 - 50, y: GH - 36, w: 100, h: CANCEL_H };
}

/** Render the modal. No-op when life.carSwitchOpen is unset.
 *  Caches the row list on life._carSwitchRows so the click
 *  handler hit-tests the exact rows that were painted. */
export function drawCarSwitchMenu(
  ctx: CanvasRenderingContext2D,
  life: LifeState,
  GW: number,
  GH: number,
): void {
  if (!life.carSwitchOpen) return;

  ctx.fillStyle = 'rgba(0,0,0,0.92)';
  ctx.fillRect(0, 0, GW, GH);
  ctx.textAlign = 'center';

  ctx.fillStyle = '#0ff';
  ctx.font = 'bold 14px monospace';
  ctx.fillText('SWITCH CAR', GW / 2, 22);
  ctx.fillStyle = '#aaa';
  ctx.font = '9px monospace';
  ctx.fillText(life.ownedCars.length + ' owned', GW / 2, 36);

  const rows = buildCarSwitchRows(life);
  (life as { _carSwitchRows?: CarSwitchRow[] })._carSwitchRows = rows;

  rows.forEach((r, i) => {
    const yy = LIST_TOP + i * (ROW_H + ROW_GAP);
    r._renderY = yy;
    const fill = r.isActive ? 'rgba(0,255,255,0.15)' : 'rgba(255,255,255,0.08)';
    ctx.fillStyle = fill;
    ctx.fillRect(12, yy, GW - 24, ROW_H);
    ctx.strokeStyle = r.isActive ? '#0ff' : '#555';
    ctx.lineWidth = 1;
    ctx.strokeRect(12, yy, GW - 24, ROW_H);

    ctx.fillStyle = r.isActive ? '#0ff' : '#fff';
    ctx.font = 'bold 10px monospace';
    ctx.fillText(r.name, GW / 2, yy + 14);
    ctx.fillStyle = '#888';
    ctx.font = '9px monospace';
    ctx.fillText(
      r.hp + 'hp · ' + r.kg + 'kg · ' + r.drv,
      GW / 2, yy + 27,
    );
    if (r.isActive) {
      ctx.fillStyle = '#0ff';
      ctx.font = 'bold 8px monospace';
      ctx.fillText('ACTIVE', GW - 36, yy + 14);
    }
  });

  // CANCEL button.
  const { x, y, w, h } = cancelRect(GW, GH);
  ctx.fillStyle = 'rgba(255,80,80,0.2)';
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = '#f44';
  ctx.strokeRect(x, y, w, h);
  ctx.fillStyle = '#f44';
  ctx.font = 'bold 11px monospace';
  ctx.fillText('CANCEL', GW / 2, y + 17);

  ctx.textAlign = 'left';
}

/** Click handler. Modal always eats taps (returns true) so
 *  clicks don't leak through to the world / HUD underneath. */
export function handleCarSwitchClick(
  tx: number,
  ty: number,
  life: LifeState,
  gameCtx: GameContext,
  GW: number,
  GH: number,
): boolean {
  if (!life.carSwitchOpen) return false;

  // CANCEL hit.
  const c = cancelRect(GW, GH);
  if (tx >= c.x && tx <= c.x + c.w && ty >= c.y && ty <= c.y + c.h) {
    life.carSwitchOpen = false;
    return true;
  }

  // Row hit.
  const rows = (life as { _carSwitchRows?: CarSwitchRow[] })._carSwitchRows ?? [];
  for (const r of rows) {
    const yy = r._renderY ?? -9999;
    if (ty >= yy && ty <= yy + ROW_H && tx >= 12 && tx <= GW - 12) {
      if (r.isActive) {
        // Tapping the active car is a no-op close — matches the
        // monolith's behavior where re-picking the owned car
        // simply closes the modal.
        life.carSwitchOpen = false;
        return true;
      }
      const result = switchCar(life, gameCtx, r.carId);
      if (result.kind === 'swapped') {
        const car = CAR_CATALOG[result.toCarId];
        showNotif(life, 'Switched to ' + (car?.name ?? result.toCarId));
      } else if (result.kind === 'noop' && result.reason === 'savedCar') {
        showNotif(life, 'Return job vehicle first — go home!');
      }
      life.carSwitchOpen = false;
      return true;
    }
  }

  // Modal eats every tap — player can't click past it.
  return true;
}
