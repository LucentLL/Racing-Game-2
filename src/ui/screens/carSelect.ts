/**
 * Starting-car select screen — third (final) step of character creation.
 *
 * Shown after job select (v8.99.40 split the flow). Reads up to four
 * pre-computed deal cards from the caller (originally LIFE._carSelect,
 * populated by generateStartingCarChoices). Layout: header with player
 * + credit summary, then up to 4 cards (BEATER / USED RELIABLE / NEW —
 * LOAN / LEASE), each with kind, car name, price (always total —
 * v8.99.43), cond%, mileage, transmission (v8.99.126.83), and a
 * finance-detail line (down + monthly × term).
 *
 * NOT to be confused with the in-game #carSelect modal (DOM-backed,
 * opened from STATUS tab via openCarSelect) — that one ships in
 * D31 modals/carPicker.ts.
 *
 * Picking a card commits the deal, sets gameState='playing', and runs
 * the game-start wiring: applyCssTilt, dayPhase='home', generate
 * newspaper + daily jobs, open home screen, init audio, fire monthly-
 * bills popup if dayOfMonth===1 (v8.99.42 — Day 1 = Friday = bills due).
 *
 * Ported from monolith L45035-45208.
 *
 * H5 status: body live. CarChoice extended with carName (required) so
 * the renderer doesn't have to reach into a CARS map — the caller
 * pre-resolves the display name when building the choice. Transmission
 * type also pre-resolved (transType: 'AUTO' | 'MANUAL') for the same
 * reason. Game-start wiring (applyCssTilt, dayPhase, newspaper, audio
 * init, monthly-bills popup) lives in caller's onPick.
 */

import { CAR_CATALOG } from '@/config/cars/catalog';
import { GT2_COLORS, drawGt2Backdrop } from '@/ui/gt2Chrome';
import { SCALE_MS } from '@/physics/physicsUnits';

/** Top of the card list, below the header. */
export const CAR_LIST_TOP = 100;
/** Card height. */
export const CAR_CARD_H = 70;
/** Bottom strip reserved for the scroll-hint chrome. */
export const CAR_BOTTOM_STRIP = 20;
/** Gap between cards. */
export const CAR_CARD_GAP = 6;

/** Pre-computed deal card shape (one per BEATER / USED / LOAN / LEASE). */
export interface CarChoice {
  /** 'BEATER' | 'USED RELIABLE' | 'NEW — LOAN' | 'LEASE'. */
  kind: string;
  /** Car ID (key into CARS map). May be null for placeholder/locked rows. */
  carId: string | null;
  /** Pre-resolved car display name (caller looked it up from CARS).
   *  '—' for null carId. */
  carName: string;
  /** Pre-resolved transmission type (caller looked it up from CARS
   *  defaultManual). v8.99.126.83. */
  transType: 'AUTO' | 'MANUAL';
  /** Total price in dollars (always shown top-right per v8.99.43). */
  price: number;
  /** Condition % (factory default — car not yet owned). */
  cond: number;
  /** Mileage in miles. */
  mileage: number;
  /** Sales-floor tagline shown when the deal is takeable. */
  tagline: string;
  /** Replaces tagline when locked / unaffordable. */
  blockReason?: string;
  /** True when player can't afford it. */
  canAfford: boolean;
  /** True when the deal is gated (e.g., credit too low for LEASE). */
  locked: boolean;
  /** 'cash' | 'loan' | 'lease' — drives the bottom-line wording. */
  financeType: 'cash' | 'loan' | 'lease';
  /** Down payment / due-at-signing ($, if loan/lease). H1287: paid in
   *  BACKSTORY (before day 1) — sets the carried loan balance, never
   *  deducted from starting cash. */
  down?: number;
  /** Monthly payment ($, if loan/lease). */
  monthly?: number;
  /** Term length (months, if loan/lease). */
  term?: number;
}

/** Header inputs (player + credit summary). */
export interface CarSelectHeader {
  playerAlias: string;
  playerJob: string;
  money: number;
  gender: 'M' | 'F';
  fitness: number;
  skinTone: number;
  /** Credit display (color/tier from getCreditTier()). */
  credit: { tier: string; color: string };
  creditScore: number;
  /** Estimated monthly job income (sel.jobMo). */
  jobMo: number;
}

/** Per-frame inputs for the car-select draw pass. */
export interface CarSelectOpts {
  header: CarSelectHeader;
  /** The four (or fewer) deal cards in display order. */
  choices: CarChoice[];
  /** Scroll offset for the list. Caller owns + clamps. */
  scrollY: number;
  /** H1295: card index whose SPEC DETAIL view is open (null = list).
   *  Caller owns (ctx.carSelect.detailIdx). */
  detailIdx: number | null;
  /** Canvas internal width / height. */
  GW: number;
  GH: number;
}

/** Caller-supplied callbacks invoked on a successful car selection. */
export interface CarSelectDeps {
  /** Called when the player commits from the SPEC DETAIL view's TAKE
   *  THIS DEAL button (H1295 — a card tap only opens specs now). The
   *  caller commits applyStartingCarChoice + game-start wiring. */
  onPick(choice: CarChoice): void;
  /** Notification toast (e.g., "Can't take this deal: <reason>"). */
  showNotif(msg: string): void;
  /** H1295: open (index) or close (null) a card's spec detail view.
   *  Caller stores it on ctx.carSelect.detailIdx. */
  setDetailIdx(idx: number | null): void;
}

/** Format money with 2 decimals — mirrors monolith $$ at L7935. */
function formatMoney(v: number): string {
  return '$' + v.toFixed(2);
}

/** Total height of the card stack at the supplied choice count. */
function totalCardsHeight(count: number): number {
  return count * (CAR_CARD_H + CAR_CARD_GAP);
}

/** Returns the max scrollY for the supplied screen height + choice count.
 *  Exported so callers can clamp wheel/drag deltas. */
export function maxCarScroll(GH: number, choiceCount: number): number {
  const listBot = GH - CAR_BOTTOM_STRIP;
  const visibleHeight = listBot - CAR_LIST_TOP;
  return Math.max(0, totalCardsHeight(choiceCount) - visibleHeight);
}

/** H1295: detail-view button rects, shared by draw + hit-test + the
 *  gamepad tick (which presses TAKE/BACK by their centers). */
export function carDetailRects(GW: number, GH: number): {
  take: { x: number; y: number; w: number; h: number };
  back: { x: number; y: number; w: number; h: number };
} {
  return {
    take: { x: 40, y: GH - 152, w: GW - 80, h: 40 },
    back: { x: GW / 2 - 70, y: GH - 98, w: 140, h: 30 },
  };
}

/** H1295: the SPEC DETAIL view for one card — the "educated decision"
 *  screen (user ask). Real catalog specs + the deal terms + TAKE THIS
 *  DEAL / BACK. Committing a run now always goes through this view. */
function drawCarDetail(
  ctx: CanvasRenderingContext2D,
  cc: CarChoice,
  GW: number,
  GH: number,
  dy: number,
): void {
  const car = cc.carId ? CAR_CATALOG[cc.carId] : null;
  const top = CAR_LIST_TOP + dy;
  const panelH = GH - 170 - top;
  ctx.fillStyle = GT2_COLORS.panel;
  ctx.fillRect(10, top, GW - 20, panelH);
  ctx.strokeStyle = GT2_COLORS.amber;
  ctx.lineWidth = 1;
  ctx.strokeRect(10, top, GW - 20, panelH);

  ctx.textAlign = 'left';
  ctx.fillStyle = GT2_COLORS.amber;
  ctx.font = 'bold 11px monospace';
  ctx.fillText(cc.kind, 22, top + 18);
  ctx.textAlign = 'right';
  ctx.fillStyle = GT2_COLORS.active;
  ctx.fillText('$' + cc.price.toLocaleString(), GW - 22, top + 18);

  ctx.textAlign = 'center';
  ctx.fillStyle = GT2_COLORS.text;
  ctx.font = 'bold 12px monospace';
  const nm = cc.carName.length > 36 ? cc.carName.slice(0, 35) + '…' : cc.carName;
  ctx.fillText(nm, GW / 2, top + 38);

  // Spec grid — two columns of label:value rows from the catalog.
  const kmh = car ? Math.round((car.topSpeed / SCALE_MS) * 3.6) : 0;
  const mph = Math.round(kmh / 1.609);
  const rows: Array<[string, string]> = car ? [
    ['YEAR', String(car.modelYear)],
    ['DRIVETRAIN', car.drv],
    ['POWER', car.hp + ' hp'],
    ['WEIGHT', car.kg + ' kg'],
    ['TOP SPEED', `${kmh} km/h (${mph} mph)`],
    ['REDLINE', car.redline.toLocaleString() + ' rpm'],
    ['GEARBOX', `${car.gears}-speed ${cc.transType}`],
    ['ASPIRATION', car.asp || 'NA'],
    ['CONDITION', cc.cond + '%'],
    ['MILEAGE', cc.mileage.toLocaleString() + ' mi'],
  ] : [];
  const gridTop = top + 56;
  const rowH = 17;
  rows.forEach(([label, val], i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const cx = col === 0 ? 22 : GW / 2 + 8;
    const y = gridTop + row * rowH;
    ctx.textAlign = 'left';
    ctx.fillStyle = GT2_COLORS.textDim;
    ctx.font = '8px monospace';
    ctx.fillText(label, cx, y);
    ctx.fillStyle = GT2_COLORS.text;
    ctx.font = 'bold 10px monospace';
    ctx.fillText(val, cx, y + 9);
  });

  // Deal terms — same wording family as the list cards (H1287 backstory).
  const dealY = gridTop + Math.ceil(rows.length / 2) * rowH + 14;
  ctx.textAlign = 'center';
  ctx.fillStyle = GT2_COLORS.textMute;
  ctx.font = '9px monospace';
  const deal = cc.financeType === 'cash'
    ? 'Paid off — no monthly bill'
    : `$${cc.monthly}/mo × ${cc.term}mo · ${cc.financeType === 'lease' ? 'signing' : 'down'} paid`;
  ctx.fillText(deal, GW / 2, dealY);
  ctx.fillStyle = GT2_COLORS.textDim;
  ctx.font = '8px monospace';
  ctx.fillText(cc.tagline, GW / 2, dealY + 12);

  // TAKE THIS DEAL + BACK.
  const r = carDetailRects(GW, GH);
  ctx.fillStyle = GT2_COLORS.amber;
  ctx.fillRect(r.take.x, r.take.y, r.take.w, r.take.h);
  ctx.fillStyle = GT2_COLORS.bgDeep;
  ctx.font = 'bold 13px monospace';
  ctx.fillText('TAKE THIS DEAL', GW / 2, r.take.y + 25);
  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  ctx.fillRect(r.back.x, r.back.y, r.back.w, r.back.h);
  ctx.strokeStyle = GT2_COLORS.textMute;
  ctx.strokeRect(r.back.x, r.back.y, r.back.w, r.back.h);
  ctx.fillStyle = GT2_COLORS.textMute;
  ctx.font = 'bold 10px monospace';
  ctx.fillText('← BACK', GW / 2, r.back.y + 19);
  ctx.textAlign = 'left';
}

/** Draws the header + scrollable card list + scroll hint / scroll bar.
 *  Renders an ERROR fallback if `choices` is empty. Ported from monolith
 *  L45035-45165. */
export function drawCarSelect(
  ctx: CanvasRenderingContext2D,
  opts: CarSelectOpts,
): void {
  const { header, choices, scrollY, GW, GH } = opts;

  ctx.fillStyle = GT2_COLORS.bg;
  ctx.fillRect(0, 0, GW, GH);
  // H780: GT2 grid backdrop overlay so this screen reads as the same
  // surface family as the dealer/garage flow.
  drawGt2Backdrop(ctx, GW, GH);
  ctx.textAlign = 'center';

  if (choices.length === 0) {
    // Fail-safe — shouldn't normally happen.
    ctx.fillStyle = GT2_COLORS.active;
    ctx.font = 'bold 12px monospace';
    ctx.fillText('ERROR: no car choices', GW / 2, 60);
    ctx.textAlign = 'left';
    return;
  }

  // Safe-top inset (see jobSelect.ts for rationale — push the title
  // and portrait clear of the upper 5 % camera-punch band).
  const safeTop = Math.max(GH * 0.05, 4);
  const dy = safeTop - 4;

  // --- HEADER --- H763: GT2 amber-on-charcoal palette.
  ctx.fillStyle = GT2_COLORS.amber;
  ctx.font = 'bold 15px monospace';
  ctx.fillText('CHOOSE YOUR CAR', GW / 2, 18 + dy);

  // Portrait placeholder — keep semantic gender background tint,
  // border + glyph follow the GT2 palette.
  ctx.fillStyle = header.gender === 'M' ? '#1a3a5a' : '#5a1a3a';
  ctx.fillRect(4, 4 + dy, 26, 26);
  ctx.fillStyle = GT2_COLORS.amber;
  ctx.font = 'bold 16px monospace';
  ctx.fillText(header.gender === 'M' ? '♂' : '♀', 17, 22 + dy);
  ctx.lineWidth = 1;
  ctx.strokeStyle = GT2_COLORS.amber;
  ctx.strokeRect(4, 4 + dy, 26, 26);

  ctx.fillStyle = GT2_COLORS.text;
  ctx.font = 'bold 10px monospace';
  ctx.fillText(header.playerAlias + ' • ' + header.playerJob, GW / 2, 38 + dy);
  ctx.fillStyle = GT2_COLORS.amber;
  ctx.font = 'bold 10px monospace';
  ctx.fillText('Cash on hand: ' + formatMoney(header.money), GW / 2, 51 + dy);
  // Credit line (color from tier).
  ctx.fillStyle = header.credit.color;
  ctx.font = 'bold 10px monospace';
  ctx.fillText(
    'Credit: ' + header.credit.tier + ' (' + header.creditScore + ')  •  ~$' + Math.round(header.jobMo) + '/mo income',
    GW / 2,
    64 + dy,
  );
  ctx.fillStyle = GT2_COLORS.textDim;
  ctx.font = '8px monospace';
  ctx.fillText('Tap a card for specs. Loans carry over.', GW / 2, 77 + dy);

  // H1295: spec detail view replaces the list while a card is open.
  const dIdx = opts.detailIdx;
  if (dIdx != null && choices[dIdx] && choices[dIdx].carId) {
    drawCarDetail(ctx, choices[dIdx], GW, GH, dy);
    return;
  }

  // --- CARDS ---
  const listTop = CAR_LIST_TOP + dy;
  const listBot = GH - CAR_BOTTOM_STRIP;
  const cardH = CAR_CARD_H;
  const gap = CAR_CARD_GAP;
  const totalH = totalCardsHeight(choices.length);
  const maxScroll = Math.max(0, totalH - (listBot - listTop));
  const clampedScroll = Math.max(0, Math.min(scrollY, maxScroll));

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, listTop, GW, listBot - listTop);
  ctx.clip();
  choices.forEach((cc, i) => {
    const yy = listTop + i * (cardH + gap) - clampedScroll;
    if (yy + cardH < listTop || yy > listBot) return;
    const usable = cc.canAfford && !cc.locked;
    // Card background
    ctx.fillStyle = usable ? GT2_COLORS.panel : 'rgba(38,38,38,0.4)';
    ctx.fillRect(10, yy, GW - 20, cardH);
    // Border: dim amber (locked / disabled) / amber (ready) / active orange (unaffordable).
    const borderCol = cc.locked ? GT2_COLORS.amberDim : usable ? GT2_COLORS.amber : GT2_COLORS.active;
    ctx.strokeStyle = borderCol;
    ctx.lineWidth = 1;
    ctx.strokeRect(10, yy, GW - 20, cardH);

    // H606: per-car color swatch on the left edge. Matches the
    // monolith's HTML carSelect listing (cs-swatch element) so the
    // player can see what color they're picking at a glance before
    // they commit the deal. Greyed when the row is locked /
    // unaffordable to match the card's overall dimming.
    const carEntry = cc.carId ? CAR_CATALOG[cc.carId] : null;
    if (carEntry) {
      ctx.fillStyle = usable ? carEntry.color : GT2_COLORS.textDim;
      ctx.fillRect(14, yy + 6, 6, CAR_CARD_H - 12);
      ctx.strokeStyle = usable ? GT2_COLORS.bgDeep : GT2_COLORS.panel;
      ctx.lineWidth = 0.5;
      ctx.strokeRect(14, yy + 6, 6, CAR_CARD_H - 12);
    }

    // Left kind label (shifted right past the swatch). All four kinds
    // share the GT2 amber palette — distinguish by label, not color.
    ctx.fillStyle = usable ? GT2_COLORS.amber : GT2_COLORS.textDim;
    ctx.font = 'bold 10px monospace';
    ctx.textAlign = 'left';
    ctx.fillText(cc.kind, 26, yy + 13);

    // Right: total price OR LOCKED label.
    ctx.textAlign = 'right';
    if (cc.locked) {
      ctx.fillStyle = GT2_COLORS.textDim;
      ctx.fillText('LOCKED', GW - 16, yy + 13);
    } else if (cc.financeType === 'cash') {
      ctx.fillStyle = usable ? GT2_COLORS.amber : GT2_COLORS.textDim;
      ctx.fillText('$' + cc.price.toLocaleString(), GW - 16, yy + 13);
    } else {
      ctx.fillStyle = usable ? GT2_COLORS.active : GT2_COLORS.textMute;
      ctx.fillText('$' + cc.price.toLocaleString(), GW - 16, yy + 13);
    }

    // Car name — center, truncated to 32 chars.
    ctx.textAlign = 'center';
    ctx.fillStyle = usable ? GT2_COLORS.text : GT2_COLORS.textDim;
    ctx.font = 'bold 10px monospace';
    const shown = cc.carName.length > 32 ? cc.carName.slice(0, 31) + '…' : cc.carName;
    ctx.fillText(shown, GW / 2, yy + 27);

    // Condition / mileage / transmission line.
    ctx.fillStyle = usable ? GT2_COLORS.textMute : GT2_COLORS.textDim;
    ctx.font = '9px monospace';
    if (cc.carId) {
      ctx.fillText(
        cc.cond + '% cond  •  ' + cc.mileage.toLocaleString() + ' mi  •  ' + cc.transType,
        GW / 2,
        yy + 40,
      );
    }

    // Tagline OR block reason.
    ctx.font = '9px monospace';
    if (cc.locked || !cc.canAfford) {
      ctx.fillStyle = GT2_COLORS.active;
      ctx.fillText('✕ ' + (cc.blockReason || cc.tagline), GW / 2, yy + 53);
    } else {
      ctx.fillStyle = GT2_COLORS.textMute;
      ctx.fillText(cc.tagline, GW / 2, yy + 53);
    }

    // Finance detail line — right-aligned to match the price column.
    ctx.textAlign = 'right';
    ctx.fillStyle = usable ? GT2_COLORS.textMute : GT2_COLORS.textDim;
    ctx.font = 'bold 8px monospace';
    // H1287: down / due-at-signing was paid in backstory — show only
    // the obligation that actually follows the player into the game.
    if (cc.financeType === 'loan') {
      ctx.fillText(
        '$' + cc.monthly + '/mo × ' + cc.term + 'mo · down paid',
        GW - 16,
        yy + 64,
      );
    } else if (cc.financeType === 'lease' && !cc.locked) {
      ctx.fillText(
        '$' + cc.monthly + '/mo × ' + cc.term + 'mo · signing paid',
        GW - 16,
        yy + 64,
      );
    } else if (cc.financeType === 'cash') {
      ctx.fillText('Paid off — no monthly bill', GW - 16, yy + 64);
    }
    ctx.textAlign = 'center';
  });
  ctx.restore();

  // Bottom strip + scroll hint + scroll bar.
  ctx.fillStyle = GT2_COLORS.bg;
  ctx.fillRect(0, listBot, GW, CAR_BOTTOM_STRIP);
  ctx.strokeStyle = GT2_COLORS.panel;
  ctx.beginPath();
  ctx.moveTo(0, listBot);
  ctx.lineTo(GW, listBot);
  ctx.stroke();
  if (maxScroll > 0) {
    ctx.fillStyle = GT2_COLORS.textMute;
    ctx.font = 'bold 9px monospace';
    if (clampedScroll < maxScroll) {
      ctx.fillText('▼ scroll down ▼', GW / 2, GH - 6);
    } else {
      ctx.fillText('▲ scroll up ▲', GW / 2, GH - 6);
    }
    const barH = Math.max(20, (listBot - listTop) * ((listBot - listTop) / totalH));
    const barY = listTop + (clampedScroll / maxScroll) * (listBot - listTop - barH);
    ctx.fillStyle = GT2_COLORS.amberDark;
    ctx.fillRect(GW - 4, barY, 3, barH);
  }
  ctx.textAlign = 'left';
}

/** Routes a tap to the right card. Locked / unaffordable cards toast a
 *  block reason instead of advancing. Ported from monolith L45167-45208. */
export function handleCarSelectClick(
  tx: number,
  ty: number,
  opts: CarSelectOpts,
  deps: CarSelectDeps,
): void {
  const { choices, scrollY, GW, GH } = opts;
  if (choices.length === 0) return;
  const within = (r: { x: number; y: number; w: number; h: number }): boolean =>
    tx >= r.x && tx <= r.x + r.w && ty >= r.y && ty <= r.y + r.h;

  // H1295: detail view — TAKE commits, BACK returns to the list,
  // anything else is eaten (modal).
  if (opts.detailIdx != null) {
    const cc = choices[opts.detailIdx];
    if (!cc) { deps.setDetailIdx(null); return; }
    const r = carDetailRects(GW, GH);
    if (within(r.take)) {
      if (cc.locked || !cc.canAfford) {
        deps.showNotif("Can't take this deal: " + (cc.blockReason || 'unavailable'));
        return;
      }
      deps.onPick(cc);
      return;
    }
    if (within(r.back)) deps.setDetailIdx(null);
    return;
  }

  // Match drawCarSelect's safe-top inset (5 % vh) so hit-test rows
  // align with the visually-shifted cards.
  const safeTop = Math.max(GH * 0.05, 4);
  const dy = safeTop - 4;
  const listTop = CAR_LIST_TOP + dy;
  const listBot = GH - CAR_BOTTOM_STRIP;
  if (ty < listTop || ty > listBot) return;
  const cardH = CAR_CARD_H;
  const gap = CAR_CARD_GAP;
  for (let i = 0; i < choices.length; i++) {
    const yy = listTop + i * (cardH + gap) - scrollY;
    if (ty >= yy && ty <= yy + cardH && tx >= 10 && tx <= GW - 10) {
      const cc = choices[i];
      // H1295: a card tap opens the SPEC DETAIL view — committing an
      // entire run on one stray tap was both uninformed and dangerous.
      if (!cc.carId) return;
      deps.setDetailIdx(i);
      return;
    }
  }
}
