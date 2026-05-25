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
  /** Down payment ($, if loan/lease). */
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
  /** Canvas internal width / height. */
  GW: number;
  GH: number;
}

/** Caller-supplied callbacks invoked on a successful car selection. */
export interface CarSelectDeps {
  /** Called when the player taps a usable card. The screen has already
   *  filtered out locked / unaffordable rows and showNotif'd the block
   *  reason. The caller commits applyStartingCarChoice + the rest of
   *  game-start wiring. */
  onPick(choice: CarChoice): void;
  /** Notification toast (e.g., "Can't take this deal: <reason>"). */
  showNotif(msg: string): void;
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

/** Draws the header + scrollable card list + scroll hint / scroll bar.
 *  Renders an ERROR fallback if `choices` is empty. Ported from monolith
 *  L45035-45165. */
export function drawCarSelect(
  ctx: CanvasRenderingContext2D,
  opts: CarSelectOpts,
): void {
  const { header, choices, scrollY, GW, GH } = opts;

  ctx.fillStyle = '#0a0a12';
  ctx.fillRect(0, 0, GW, GH);
  ctx.textAlign = 'center';

  if (choices.length === 0) {
    // Fail-safe — shouldn't normally happen.
    ctx.fillStyle = '#f44';
    ctx.font = 'bold 12px monospace';
    ctx.fillText('ERROR: no car choices', GW / 2, 60);
    ctx.textAlign = 'left';
    return;
  }

  // --- HEADER ---
  ctx.fillStyle = '#0ff';
  ctx.font = 'bold 15px monospace';
  ctx.fillText('CHOOSE YOUR CAR', GW / 2, 18);

  // Portrait placeholder (same convention as nameEntry / jobSelect).
  ctx.fillStyle = header.gender === 'M' ? '#1a3a5a' : '#5a1a3a';
  ctx.fillRect(4, 4, 26, 26);
  ctx.fillStyle = '#0ff';
  ctx.font = 'bold 16px monospace';
  ctx.fillText(header.gender === 'M' ? '♂' : '♀', 17, 22);
  ctx.lineWidth = 1;
  ctx.strokeStyle = '#0ff';
  ctx.strokeRect(4, 4, 26, 26);

  ctx.fillStyle = '#fff';
  ctx.font = 'bold 10px monospace';
  ctx.fillText(header.playerAlias + ' • ' + header.playerJob, GW / 2, 38);
  ctx.fillStyle = '#0f0';
  ctx.font = 'bold 10px monospace';
  ctx.fillText('Cash on hand: ' + formatMoney(header.money), GW / 2, 51);
  // Credit line (color from tier).
  ctx.fillStyle = header.credit.color;
  ctx.font = 'bold 10px monospace';
  ctx.fillText(
    'Credit: ' + header.credit.tier + ' (' + header.creditScore + ')  •  ~$' + Math.round(header.jobMo) + '/mo income',
    GW / 2,
    64,
  );
  ctx.fillStyle = '#888';
  ctx.font = '8px monospace';
  ctx.fillText('Tap a card to take the deal.', GW / 2, 77);

  // --- CARDS ---
  const listTop = CAR_LIST_TOP;
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
    ctx.fillStyle = usable ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.03)';
    ctx.fillRect(10, yy, GW - 20, cardH);
    // Border: gray (locked) / amber (unaffordable) / green (ready).
    const borderCol = cc.locked ? '#555' : usable ? '#0f0' : '#f80';
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
      ctx.fillStyle = usable ? carEntry.color : '#444';
      ctx.fillRect(14, yy + 6, 6, CAR_CARD_H - 12);
      ctx.strokeStyle = usable ? '#000' : '#222';
      ctx.lineWidth = 0.5;
      ctx.strokeRect(14, yy + 6, 6, CAR_CARD_H - 12);
    }

    // Left kind label (shifted right past the swatch).
    const kindCol =
      cc.kind === 'BEATER' ? '#fa8' :
      cc.kind === 'USED RELIABLE' ? '#ff0' :
      cc.kind === 'NEW — LOAN' ? '#0f8' :
      '#0cf';
    ctx.fillStyle = usable ? kindCol : '#777';
    ctx.font = 'bold 10px monospace';
    ctx.textAlign = 'left';
    ctx.fillText(cc.kind, 26, yy + 13);

    // Right: total price OR LOCKED label.
    ctx.textAlign = 'right';
    if (cc.locked) {
      ctx.fillStyle = '#666';
      ctx.fillText('LOCKED', GW - 16, yy + 13);
    } else if (cc.financeType === 'cash') {
      ctx.fillStyle = usable ? '#0f0' : '#666';
      ctx.fillText('$' + cc.price.toLocaleString() + ' cash', GW - 16, yy + 13);
    } else {
      ctx.fillStyle = usable ? '#ff0' : '#888';
      ctx.fillText('$' + cc.price.toLocaleString(), GW - 16, yy + 13);
    }

    // Car name — center, truncated to 32 chars.
    ctx.textAlign = 'center';
    ctx.fillStyle = usable ? '#fff' : '#777';
    ctx.font = 'bold 10px monospace';
    const shown = cc.carName.length > 32 ? cc.carName.slice(0, 31) + '…' : cc.carName;
    ctx.fillText(shown, GW / 2, yy + 27);

    // Condition / mileage / transmission line.
    ctx.fillStyle = usable ? '#aaa' : '#555';
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
      ctx.fillStyle = '#f80';
      ctx.fillText('✕ ' + (cc.blockReason || cc.tagline), GW / 2, yy + 53);
    } else {
      ctx.fillStyle = '#aaa';
      ctx.fillText(cc.tagline, GW / 2, yy + 53);
    }

    // Finance detail line — right-aligned to match the price column.
    ctx.textAlign = 'right';
    ctx.fillStyle = usable ? '#8c8' : '#555';
    ctx.font = 'bold 8px monospace';
    if (cc.financeType === 'loan') {
      ctx.fillText(
        '$' + (cc.down || 0).toLocaleString() + ' down + $' + cc.monthly + '/mo × ' + cc.term + 'mo',
        GW - 16,
        yy + 64,
      );
    } else if (cc.financeType === 'lease' && !cc.locked) {
      ctx.fillText(
        '$' + (cc.down || 0).toLocaleString() + ' due + $' + cc.monthly + '/mo × ' + cc.term + 'mo',
        GW - 16,
        yy + 64,
      );
    } else if (cc.financeType === 'cash') {
      ctx.fillText('No monthly bill', GW - 16, yy + 64);
    }
    ctx.textAlign = 'center';
  });
  ctx.restore();

  // Bottom strip + scroll hint + scroll bar.
  ctx.fillStyle = '#0a0a12';
  ctx.fillRect(0, listBot, GW, CAR_BOTTOM_STRIP);
  ctx.strokeStyle = '#222';
  ctx.beginPath();
  ctx.moveTo(0, listBot);
  ctx.lineTo(GW, listBot);
  ctx.stroke();
  if (maxScroll > 0) {
    ctx.fillStyle = '#888';
    ctx.font = 'bold 9px monospace';
    if (clampedScroll < maxScroll) {
      ctx.fillText('▼ scroll down ▼', GW / 2, GH - 6);
    } else {
      ctx.fillText('▲ scroll up ▲', GW / 2, GH - 6);
    }
    const barH = Math.max(20, (listBot - listTop) * ((listBot - listTop) / totalH));
    const barY = listTop + (clampedScroll / maxScroll) * (listBot - listTop - barH);
    ctx.fillStyle = 'rgba(255,255,255,0.2)';
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
  const listTop = CAR_LIST_TOP;
  const listBot = GH - CAR_BOTTOM_STRIP;
  if (ty < listTop || ty > listBot) return;
  const cardH = CAR_CARD_H;
  const gap = CAR_CARD_GAP;
  for (let i = 0; i < choices.length; i++) {
    const yy = listTop + i * (cardH + gap) - scrollY;
    if (ty >= yy && ty <= yy + cardH && tx >= 10 && tx <= GW - 10) {
      const cc = choices[i];
      if (cc.locked || !cc.canAfford) {
        deps.showNotif("Can't take this deal: " + (cc.blockReason || 'unavailable'));
        return;
      }
      deps.onPick(cc);
      return;
    }
  }
}
