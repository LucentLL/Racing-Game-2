/**
 * H708 + H709: Car-switch modal — owned-car list with tap-to-pick.
 *
 * H708 introduced the modal to replace the H245 interim auto-cycle
 * that only ping-ponged between ownedCars[0] and ownedCars[1]. H709
 * dressed it up to match the garage tab — sprite previews, drivetrain
 * + transmission + mileage row info, scroll support so fleets bigger
 * than ~7 cars are reachable. User reported: "I can switch cars
 * now... but there is no way to scroll or view the cars like in the
 * garage."
 *
 * 1:1 in INTENT with monolith openCarSelect (L7686-L7715) and visual
 * parity with the modular home-overlay GARAGE tab (overlay.ts:657+).
 * Uses the same spriteForCarName cache + odometer formatter the
 * garage row uses, so the two surfaces read identical.
 *
 * Trigger: pause-menu STATUS tab's SWITCH CAR button sets
 * life.carSwitchOpen=true. drawCarSwitchMenu paints the modal next
 * frame; handleCarSwitchClick routes the tap. Scroll wheel is
 * routed in gameLoop's main wheel handler, clamped against
 * life._carSwitchScrollMax which the render writes each paint.
 */

import type { LifeState } from '@/state/life';
import type { GameContext } from '@/state/gameState';
import { CAR_CATALOG } from '@/config/cars/catalog';
import { switchCar } from '@/sim/switchCar';
import { showNotif } from '@/ui/notif';
import { spriteForCarName } from '@/render/carSprites';
import { MILES_PER_GAME_UNIT, KM_PER_GAME_UNIT } from '@/physics/physicsUnits';

/** One row in the cached list — name resolved, hit-test rect
 *  populated by the render pass for the click handler. */
export interface CarSwitchRow {
  carId: string;
  name: string;
  hp: number;
  kg: number;
  drv: string;
  rhd: boolean;
  defaultManual: boolean;
  color: string;
  isActive: boolean;
  /** Filled in by drawCarSwitchMenu — top-Y of the painted rect
   *  AFTER scroll offset has been applied. Negative / off-screen
   *  rows still get a value so the hit-test can dismiss them. */
  _renderY?: number;
}

/** Build the row list from life.ownedCars. Active car first,
 *  rest in current array order (which is the user's recent-switch
 *  order from runSwitchCar's rotate-on-swap behavior). */
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
      rhd: car.rhd,
      defaultManual: car.defaultManual,
      color: car.color,
      isActive: cid === life.ownedCars[0],
    });
  }
  return rows;
}

/** Per-row dimensions — match the garage tab's 56 px row + 6 px gap
 *  + 56×40 sprite preview so the two surfaces feel like the same
 *  widget. */
const ROW_H = 56;
const ROW_GAP = 6;
const LIST_TOP = 50;
const ROW_MARGIN_X = 12;
const SPRITE_W = 56;
const SPRITE_H = 40;
const SPRITE_PAD = 8;
const CANCEL_H = 26;
const FOOTER_H = 36;

/** Hit-test box for the CANCEL button — anchored to the bottom
 *  of the modal so it doesn't move when more cars are added. */
export function cancelRect(GW: number, GH: number): {
  x: number; y: number; w: number; h: number;
} {
  return { x: GW / 2 - 50, y: GH - FOOTER_H, w: 100, h: CANCEL_H };
}

/** Format an odometer reading in game units to a short mi/km label
 *  matching the garage row formatter at overlay.ts:846. */
function formatOdometer(odoRaw: number, rhd: boolean): string {
  const dist = odoRaw * (rhd ? KM_PER_GAME_UNIT : MILES_PER_GAME_UNIT);
  const suffix = rhd ? 'km' : 'mi';
  if (dist >= 1000) return (dist / 1000).toFixed(1) + 'k' + suffix;
  return Math.round(dist) + suffix;
}

/** Render the modal. No-op when life.carSwitchOpen is unset.
 *  Caches the row list on life._carSwitchRows so the click handler
 *  hit-tests the exact rows that were painted. */
export function drawCarSwitchMenu(
  ctx: CanvasRenderingContext2D,
  life: LifeState,
  GW: number,
  GH: number,
): void {
  if (!life.carSwitchOpen) return;

  ctx.fillStyle = 'rgba(0,0,0,0.94)';
  ctx.fillRect(0, 0, GW, GH);
  ctx.textAlign = 'center';

  // Header.
  ctx.fillStyle = '#0ff';
  ctx.font = 'bold 14px monospace';
  ctx.fillText('SWITCH CAR', GW / 2, 20);
  ctx.fillStyle = '#888';
  ctx.font = '10px monospace';
  ctx.fillText(life.ownedCars.length + ' owned · tap a row to switch', GW / 2, 36);

  const rows = buildCarSwitchRows(life);
  (life as { _carSwitchRows?: CarSwitchRow[] })._carSwitchRows = rows;

  // Scroll math — content height vs visible band between list top
  // and the CANCEL footer. Same shape the garage tab uses
  // (overlay.ts:730).
  const listTop = LIST_TOP;
  const listBottom = GH - FOOTER_H - 4;
  const visibleH = listBottom - listTop;
  const totalH = rows.length * (ROW_H + ROW_GAP);
  const scrollMax = Math.max(0, totalH - visibleH);
  life._carSwitchScrollMax = scrollMax;
  const scrollY = Math.max(0, Math.min(scrollMax, life._carSwitchScrollY ?? 0));
  life._carSwitchScrollY = scrollY;

  // Clip the list region so off-screen rows don't paint over the
  // header or CANCEL footer.
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, listTop, GW, visibleH);
  ctx.clip();

  const rowW = GW - ROW_MARGIN_X * 2;
  let yy = listTop - scrollY;
  for (const r of rows) {
    r._renderY = yy;
    // Row background.
    ctx.fillStyle = r.isActive
      ? 'rgba(0,255,100,0.14)'
      : 'rgba(120,120,140,0.10)';
    ctx.fillRect(ROW_MARGIN_X, yy, rowW, ROW_H);
    ctx.strokeStyle = r.isActive ? '#0f0' : '#555';
    ctx.lineWidth = r.isActive ? 2 : 1;
    ctx.strokeRect(ROW_MARGIN_X, yy, rowW, ROW_H);

    // Sprite preview on the left — fallback to colored swatch when
    // the sprite hasn't streamed in (boot race) or doesn't exist
    // for this catalog row. Same path overlay.ts:785 uses.
    const sprite = spriteForCarName(r.name);
    const spriteX = ROW_MARGIN_X + SPRITE_PAD;
    const spriteY = yy + SPRITE_PAD;
    if (sprite && sprite.complete && sprite.naturalWidth > 0) {
      const sm = ctx.imageSmoothingEnabled;
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(sprite, spriteX, spriteY, SPRITE_W, SPRITE_H);
      ctx.imageSmoothingEnabled = sm;
    } else {
      ctx.fillStyle = r.color;
      ctx.fillRect(spriteX, spriteY, SPRITE_W, SPRITE_H);
    }

    const textX = spriteX + SPRITE_W + 10;
    ctx.textAlign = 'left';

    // Name — truncate if it overflows the right-edge ACTIVE chip.
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 11px monospace';
    const NAME_MAX = 32;
    const shown = r.name.length > NAME_MAX
      ? r.name.slice(0, NAME_MAX - 1) + '…'
      : r.name;
    ctx.fillText(shown, textX, yy + 16);

    // Stats line: drivetrain · transmission · hp · kg.
    ctx.fillStyle = '#aaa';
    ctx.font = '10px monospace';
    const tags = [r.drv, r.defaultManual ? 'M' : 'A', r.hp + 'hp', r.kg + 'kg'];
    ctx.fillText(tags.join(' · '), textX, yy + 32);

    // Mileage — same formatter the garage row uses.
    const odo = life.carOdometers?.[r.carId] ?? 0;
    ctx.fillStyle = '#9af';
    ctx.font = '9px monospace';
    ctx.fillText(formatOdometer(odo, r.rhd), textX, yy + 47);

    // ACTIVE chip on the right (right-aligned so it stays put as
    // the name truncates).
    if (r.isActive) {
      ctx.fillStyle = '#0f0';
      ctx.font = 'bold 9px monospace';
      ctx.textAlign = 'right';
      ctx.fillText('ACTIVE', ROW_MARGIN_X + rowW - 8, yy + 16);
    }

    ctx.textAlign = 'left';
    yy += ROW_H + ROW_GAP;
  }

  ctx.restore();

  // Scroll indicator on the right edge when there's overflow —
  // small light bar showing scroll position.
  if (scrollMax > 0) {
    const trackX = GW - 4;
    const trackTop = listTop + 2;
    const trackH = visibleH - 4;
    ctx.fillStyle = 'rgba(255,255,255,0.10)';
    ctx.fillRect(trackX, trackTop, 2, trackH);
    const thumbH = Math.max(12, (visibleH / totalH) * trackH);
    const thumbY = trackTop + (scrollY / scrollMax) * (trackH - thumbH);
    ctx.fillStyle = '#0ff';
    ctx.fillRect(trackX, thumbY, 2, thumbH);
  }

  // CANCEL footer.
  const { x, y, w, h } = cancelRect(GW, GH);
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(255,80,80,0.2)';
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = '#f44';
  ctx.lineWidth = 1;
  ctx.strokeRect(x, y, w, h);
  ctx.fillStyle = '#f44';
  ctx.font = 'bold 11px monospace';
  ctx.fillText('CANCEL', GW / 2, y + 17);

  ctx.textAlign = 'left';
}

/** Click handler. Modal always eats taps (returns true) so
 *  clicks don't leak through to the world / HUD underneath.
 *  Rows whose _renderY landed outside the clipped visible band
 *  are filtered out of the hit-test so a tap on the dimmed
 *  background doesn't accidentally fire an off-screen row. */
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

  const listTop = LIST_TOP;
  const listBottom = GH - FOOTER_H - 4;

  const rows = (life as { _carSwitchRows?: CarSwitchRow[] })._carSwitchRows ?? [];
  for (const r of rows) {
    const yy = r._renderY ?? -9999;
    // Only hit-test rows that landed inside the clipped visible
    // band — scrolled-off rows still have a _renderY value but
    // shouldn't be tappable.
    if (yy + ROW_H < listTop || yy > listBottom) continue;
    if (
      ty >= yy && ty <= yy + ROW_H
      && tx >= ROW_MARGIN_X && tx <= GW - ROW_MARGIN_X
    ) {
      if (r.isActive) {
        // Re-picking the current car just closes the modal, matching
        // the monolith's openCarSelect behavior.
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
      // Reset scroll so the next open starts at the top — the
      // active car just moved to slot 0, which is already visible
      // without scroll.
      life._carSwitchScrollY = 0;
      return true;
    }
  }

  // Modal eats every tap — player can't click past it.
  return true;
}
