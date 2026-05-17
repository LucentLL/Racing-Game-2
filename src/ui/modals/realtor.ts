/**
 * Realtor visit overlay — home purchase mirror of seller.ts.
 *
 * Same lifecycle (driving → menu → no test drive — homes don't drive).
 * Header / agent label varies by listing.isRental ('🏠 PROPERTY MANAGER'
 * vs '🏡 REAL ESTATE AGENT').
 *
 * completeHomePurchase has two paths:
 *   - Rentals: pay deposit + first month upfront (price × 2). Sets
 *     housingType, monthlyHousingCost, clears mortgage.
 *   - Owned: deduct down payment, set mortgageBalance to loan amount,
 *     set monthsRemaining to _HOUSE_LOAN_MONTHS (30yr). Sets
 *     housingType, monthlyHousingCost.
 * Either path: removes listing from LIFE.newspaper + carPins (with pin
 * index repair so remaining pins still resolve to their listings).
 *
 * checkRealtorArrival is the per-frame poll that flips phase from
 * 'driving' to 'menu' when player is within 2 tiles + nearly stopped.
 *
 * Ported from monolith L49928 (openRealtorVisit), L49940 (checkRealtorArrival),
 * L49951 (completeHomePurchase), L49990 (drawRealtorOverlay), L50106
 * (handleRealtorTap).
 *
 * SCAFFOLD status: type contract + entry points stubbed with TODO line
 * refs.
 */

import { HOUSE_DOWN_OPTIONS, HOUSE_LOAN_APR, HOUSE_LOAN_MONTHS } from '@/config/housing';
import { calcLoanPayment } from '@/sim/loanMath';

/** Pre-approval result for a single mortgage offer. */
export interface RealtorOffer {
  approved: boolean;
  /** Down payment $ (owned only). */
  downAmt: number;
  /** Loan amount $ (owned only). */
  loanAmt: number;
  /** Monthly payment $. */
  monthly: number;
  /** APR (decimal). */
  apr: number;
  /** Denial reason (when !approved). */
  reason?: string;
}

/** Real-estate listing being shown. */
export interface RealtorListing {
  name: string;
  address: string;
  /** Total price ($) for owned, monthly rent for rentals. */
  price: number;
  /** Housing tier this listing maps to (drives LIFE.housingType on
   *  completion). */
  tierKey: string;
  /** Garage slots this property provides. */
  slots: number;
  /** Description copy (e.g., "3BR / 2BA in Plaza Midwood"). */
  desc: string;
  /** True when listing is a rental. */
  isRental: boolean;
  /** World coords for the realtor visit. */
  worldX: number;
  worldY: number;
  /** Day the listing expires (drives pin auto-removal). */
  expiresDay: number;
}

/** LIFE.realtorVisit shape. */
export interface RealtorVisitState {
  listing: RealtorListing;
  /** Pin reference if visit was opened from a pin tap. */
  _fromPin: unknown | null;
  /** World coords of the realtor location. */
  mapX: number;
  mapY: number;
  phase: 'driving' | 'menu';
  /** Down-payment percentage slider (0.0-1.0). */
  downPct: number;
  /** Last evaluated offer (drives the COMMIT button enable). */
  lastOffer: RealtorOffer | null;
}

/** Per-frame inputs for the realtor overlay. */
export interface RealtorOpts {
  state: RealtorVisitState;
  /** Player credit + finance summary. */
  creditScore: number;
  creditTier: import('@/sim/credit').CreditTier;
  /** Annual income for the affordability check. */
  annualIncome: number;
  money: number;
  /** Canvas internal width / height. */
  GW: number;
  GH: number;
}

/** Side effects the realtor buttons invoke. */
export interface RealtorDeps {
  /** Re-evaluate offer when down% changes. */
  evaluateOffer(downPct: number): RealtorOffer;
  /** Commit the deal — runs completeHomePurchase. */
  commit(): void;
  /** Walk away — clears LIFE.realtorVisit. */
  walkAway(): void;
  showNotif(msg: string): void;
}

/** LIFE-shaped slot the entry/arrival paths write into. */
export interface RealtorLife {
  realtorVisit?: RealtorVisitState | null;
}

/** Opens a realtor visit at the listing's worldX/worldY, sets phase
 *  to 'menu' immediately. The home picker runs from the newspaper
 *  tab while the player is at home — no driving step needed (the
 *  driving phase exists on the state for symmetry with sellerVisit
 *  and for future startRealtorVisit-style entries; checkRealtorArrival
 *  handles that case). 1:1 port of monolith L49846-49856. */
export function openRealtorVisit(
  life: RealtorLife,
  listing: RealtorListing,
  pin: unknown | null,
  showNotif: (msg: string) => void,
): void {
  life.realtorVisit = {
    listing,
    _fromPin: pin ?? null,
    mapX: listing.worldX,
    mapY: listing.worldY,
    phase: 'menu',
    downPct: 0.20,
    lastOffer: null,
  };
  showNotif(listing.isRental ? '🏠 Property manager ready' : '🏡 Real estate agent ready');
}

/** Per-frame poll: when phase==='driving' and player is within 2
 *  tiles + nearly stopped (|pSpeed|<3), flip to 'menu'. 1:1 port of
 *  monolith L49858-49866. */
export function checkRealtorArrival(
  rv: RealtorVisitState | null | undefined,
  player: { px: number; py: number; pSpeed: number },
  deps: { tilePx: number; showNotif(msg: string): void },
): void {
  if (!rv || rv.phase !== 'driving') return;
  const dx = player.px - rv.mapX;
  const dy = player.py - rv.mapY;
  const radius2 = deps.tilePx * deps.tilePx * 4;
  if (dx * dx + dy * dy < radius2 && Math.abs(player.pSpeed) < 3) {
    rv.phase = 'menu';
    player.pSpeed = 0;
    deps.showNotif('You arrived at the property!');
  }
}

/** Action type for the rect cache below. */
type RealtorAction =
  | 'accept_rental'
  | 'accept_purchase'
  | 'make_offer'
  | 'leave'
  | 'setdown';

/** Tap-rect entry — modal layout caches positions here so the click
 *  router doesn't re-derive them. */
export interface RealtorBtnRect {
  x: number;
  y: number;
  w: number;
  h: number;
  action: RealtorAction;
  /** Only set for action='setdown' — the chosen down-payment fraction. */
  value?: number;
}

/** Module-scope cache. Written by drawRealtorOverlay, read by
 *  handleRealtorTap. 1:1 with monolith LIFE._realtorBtns at L49938. */
let _realtorBtns: RealtorBtnRect[] = [];

/** Exposed for the click router. Read-only — the renderer
 *  rebuilds the cache every frame. */
export function getRealtorBtns(): readonly RealtorBtnRect[] {
  return _realtorBtns;
}

/** 1:1 port of monolith L49908-50022. Full-screen 94%-black modal
 *  with purple-accented header, listing summary, credit/income
 *  summary, then branches:
 *
 *  - Rental: 'Move-in cost' line ($2 × price = deposit + first
 *    month), big yellow/red price stamp by affordability, SIGN
 *    LEASE button (greyed when unaffordable).
 *  - Owned: 5-button DOWN PAYMENT row (5/10/15/20/30%) with the
 *    selected pct purple-stroked; live loan breakdown (down /
 *    loan / APR / monthly × 30yr); last-offer disclosure when set
 *    (green APPROVED with terms, red DECLINED with reason); then
 *    either MAKE OFFER (no offer yet / declined) or ACCEPT &
 *    CLOSE (approved).
 *
 *  Common ← LEAVE button at the bottom. All button rects cached
 *  on the module-scope _realtorBtns array. */
export function drawRealtorOverlay(
  ctx: CanvasRenderingContext2D,
  opts: RealtorOpts,
): void {
  const { state: rv, creditScore, creditTier, annualIncome, money, GW, GH } = opts;
  if (rv.phase === 'driving') return;
  const L = rv.listing;

  // Reset rect cache for this frame.
  _realtorBtns = [];

  // Full-screen 94%-black backdrop.
  ctx.fillStyle = 'rgba(0, 0, 0, 0.94)';
  ctx.fillRect(0, 0, GW, GH);
  ctx.textAlign = 'center';

  // Header.
  ctx.fillStyle = '#c8f';
  ctx.font = 'bold 14px monospace';
  ctx.fillText(L.isRental ? '🏠 PROPERTY MANAGER' : '🏡 REAL ESTATE AGENT', GW / 2, 22);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 12px monospace';
  ctx.fillText(L.name, GW / 2, 42);
  ctx.fillStyle = '#aaa';
  ctx.font = '10px monospace';
  ctx.fillText(L.address, GW / 2, 56);

  // Price + key stats.
  ctx.fillStyle = '#0f0';
  ctx.font = 'bold 16px monospace';
  const priceTxt = L.isRental ? '$' + L.price + '/mo' : '$' + L.price.toLocaleString();
  ctx.fillText(priceTxt, GW / 2, 82);
  ctx.fillStyle = '#888';
  ctx.font = '9px monospace';
  ctx.fillText(L.slots + ' parking slot' + (L.slots > 1 ? 's' : '') + ' • ' + L.desc, GW / 2, 96);

  // Player summary (credit + income).
  ctx.fillStyle = '#aaa';
  ctx.font = '10px monospace';
  ctx.fillText(
    'Credit: ' + creditTier.tier + ' (' + creditScore + ')  •  Income: ~$' + annualIncome.toLocaleString() + '/yr',
    GW / 2, 114,
  );
  ctx.fillText('Cash: $' + money.toLocaleString(), GW / 2, 128);

  // Branch on rental vs ownership.
  if (L.isRental) {
    // ---- RENTAL ----
    const upfront = L.price * 2;
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 11px monospace';
    ctx.fillText('Move-in cost: 1 month deposit + 1st month', GW / 2, 158);
    ctx.fillStyle = money >= upfront ? '#ff0' : '#f44';
    ctx.font = 'bold 14px monospace';
    ctx.fillText('$' + upfront, GW / 2, 178);
    ctx.fillStyle = '#888';
    ctx.font = '9px monospace';
    ctx.fillText('Then $' + L.price + '/mo starting on the 1st', GW / 2, 192);

    const canAfford = money >= upfront;
    const sbX = GW / 2 - 70;
    const sbY = 210;
    const sbW = 140;
    const sbH = 28;
    ctx.fillStyle = canAfford ? 'rgba(0, 200, 100, 0.25)' : 'rgba(80, 80, 80, 0.2)';
    ctx.fillRect(sbX, sbY, sbW, sbH);
    ctx.strokeStyle = canAfford ? '#0f0' : '#555';
    ctx.lineWidth = 1;
    ctx.strokeRect(sbX, sbY, sbW, sbH);
    ctx.fillStyle = canAfford ? '#0f0' : '#888';
    ctx.font = 'bold 12px monospace';
    ctx.fillText('✓ SIGN LEASE', GW / 2, sbY + 18);
    if (canAfford) _realtorBtns.push({ x: sbX, y: sbY, w: sbW, h: sbH, action: 'accept_rental' });
  } else {
    // ---- OWNED ----
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 10px monospace';
    ctx.fillText('DOWN PAYMENT', GW / 2, 152);

    const bW = 42;
    const bGap = 4;
    const totalW = HOUSE_DOWN_OPTIONS.length * (bW + bGap) - bGap;
    const bX0 = (GW - totalW) / 2;
    HOUSE_DOWN_OPTIONS.forEach((pct, i) => {
      const bx = bX0 + i * (bW + bGap);
      const by = 158;
      const sel = Math.abs(rv.downPct - pct) < 0.001;
      ctx.fillStyle = sel ? 'rgba(200, 130, 255, 0.35)' : 'rgba(255, 255, 255, 0.08)';
      ctx.fillRect(bx, by, bW, 22);
      ctx.strokeStyle = sel ? '#c8f' : '#555';
      ctx.lineWidth = 1;
      ctx.strokeRect(bx, by, bW, 22);
      ctx.fillStyle = sel ? '#c8f' : '#888';
      ctx.font = 'bold 10px monospace';
      ctx.fillText(Math.round(pct * 100) + '%', bx + bW / 2, by + 15);
      _realtorBtns.push({ x: bx, y: by, w: bW, h: 22, action: 'setdown', value: pct });
    });

    // Live loan breakdown preview (not yet submitted).
    const downAmt = Math.round(L.price * rv.downPct);
    const loanAmt = L.price - downAmt;
    const apr = Math.max(0.04, HOUSE_LOAN_APR + creditTier.aprAdj);
    const monthly = Math.round(calcLoanPayment(loanAmt, apr, HOUSE_LOAN_MONTHS));
    ctx.fillStyle = '#ccc';
    ctx.font = '10px monospace';
    ctx.fillText(
      'Down $' + downAmt.toLocaleString() + ' • Loan $' + loanAmt.toLocaleString(),
      GW / 2, 196,
    );
    ctx.fillText(
      'APR ' + (apr * 100).toFixed(2) + '% • Monthly: $' + monthly + ' × 30yr',
      GW / 2, 210,
    );

    // Last-offer disclosure.
    if (rv.lastOffer) {
      ctx.fillStyle = rv.lastOffer.approved ? '#0f0' : '#f44';
      ctx.font = 'bold 11px monospace';
      ctx.fillText(
        (rv.lastOffer.approved ? '✓ APPROVED — ' : '✗ DECLINED: ') + (rv.lastOffer.reason ?? ''),
        GW / 2, 228,
      );
    }

    // MAKE OFFER / ACCEPT button.
    const btnY = 244;
    if (rv.lastOffer && rv.lastOffer.approved) {
      const abX = GW / 2 - 70;
      const abY = btnY;
      const abW = 140;
      const abH = 26;
      ctx.fillStyle = 'rgba(0, 200, 100, 0.25)';
      ctx.fillRect(abX, abY, abW, abH);
      ctx.strokeStyle = '#0f0';
      ctx.lineWidth = 1;
      ctx.strokeRect(abX, abY, abW, abH);
      ctx.fillStyle = '#0f0';
      ctx.font = 'bold 12px monospace';
      ctx.fillText('✓ ACCEPT & CLOSE', GW / 2, abY + 17);
      _realtorBtns.push({ x: abX, y: abY, w: abW, h: abH, action: 'accept_purchase' });
    } else {
      const obX = GW / 2 - 70;
      const obY = btnY;
      const obW = 140;
      const obH = 26;
      ctx.fillStyle = 'rgba(200, 130, 255, 0.25)';
      ctx.fillRect(obX, obY, obW, obH);
      ctx.strokeStyle = '#c8f';
      ctx.lineWidth = 1;
      ctx.strokeRect(obX, obY, obW, obH);
      ctx.fillStyle = '#c8f';
      ctx.font = 'bold 12px monospace';
      ctx.fillText('📋 MAKE OFFER', GW / 2, obY + 17);
      _realtorBtns.push({ x: obX, y: obY, w: obW, h: obH, action: 'make_offer' });
    }
  }

  // ← LEAVE button (common).
  const lbX = GW / 2 - 50;
  const lbY = GH - 44;
  const lbW = 100;
  const lbH = 24;
  ctx.fillStyle = 'rgba(255, 60, 60, 0.15)';
  ctx.fillRect(lbX, lbY, lbW, lbH);
  ctx.strokeStyle = '#f44';
  ctx.lineWidth = 1;
  ctx.strokeRect(lbX, lbY, lbW, lbH);
  ctx.fillStyle = '#f44';
  ctx.font = 'bold 11px monospace';
  ctx.fillText('← LEAVE', GW / 2, lbY + 16);
  _realtorBtns.push({ x: lbX, y: lbY, w: lbW, h: lbH, action: 'leave' });

  ctx.textAlign = 'left';
}

/** Routes a tap (down-pct slider, COMMIT, WALK).
 *  TODO(D31-followup): port from L50106+. */
export function handleRealtorTap(
  _tx: number,
  _ty: number,
  _opts: RealtorOpts,
  _deps: RealtorDeps,
): boolean {
  // TODO: L50106+.
  return false;
}

/** Finalizes the deal — rentals pay 2× upfront, owneds set mortgage,
 *  both paths remove listing + repair pin indices.
 *  TODO(D31-followup): port from L49951-49988. */
export function completeHomePurchase(): void {
  // TODO: L49951-49988. Pin index repair walks remaining LIFE.carPins
  // and re-resolves pin.index = LIFE.newspaper.indexOf(pin.listing).
}
