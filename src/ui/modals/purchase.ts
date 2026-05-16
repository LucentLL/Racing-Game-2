/**
 * Purchase finance menu — modal for finalizing a car deal.
 *
 * Opens after PURCHASE on inspection / seller. Shows pre-computed
 * finance options (cash / loan / lease) as cards with affordability
 * coloring, current car payments header (so the player sees existing
 * monthly load before committing), and a BACK button.
 *
 * v8.99.122 desktop centering wraps the body — same pattern as the
 * inspection modal. Click handler subtracts _menuCenterOffX from tx.
 *
 * completePurchase finalizes the deal:
 *   - Saves current car's condition before switching (v8.25).
 *   - Deducts down payment.
 *   - Pushes to LIFE.carLoans if not cash.
 *   - Sets odometer from listing mileage (v8.25 — only if car is new
 *     to ownership).
 *   - Adds to LIFE.ownedCars + CAR_IDS.
 *   - Initializes engine/tires/carHP/paint/fuel based on isNew.
 *   - Splits preFaults: detected → LIFE.faults, hidden → LIFE._hiddenFaults
 *     with LIFE._hiddenFaultOdo for "drive N miles to surface" gating.
 *   - Saves new car's condition.
 *   - Removes listing from source array (carLot or LIFE.newspaper, with
 *     pin cleanup for the latter).
 *   - Closes purchase + inspection + sellerVisit modals.
 *
 * Ported from monolith L45971-46220 (completePurchase, drawPurchaseMenu,
 * handlePurchaseMenuClick).
 *
 * SCAFFOLD status: type contract + entry points stubbed with TODO line
 * refs.
 */

import type { PreFault } from './inspection';

/** One finance option row. */
export interface FinanceOption {
  /** 'cash' | 'loan' | 'lease'. */
  type: 'cash' | 'loan' | 'lease';
  label: string;
  desc: string;
  /** Down payment ($). */
  down: number;
  /** Monthly payment ($). 0 for cash. */
  monthly: number;
  /** Term in months (loan/lease). */
  term: number;
  /** Total paid over the term ($). */
  total: number;
  /** APR (decimal — loan/lease only). */
  rate?: number;
}

/** LIFE.purchaseMenu shape. */
export interface PurchaseMenuState {
  carId: string;
  carName: string;
  price: number;
  isNew: boolean;
  source: 'lot' | 'newspaper';
  index: number;
  /** Pre-faults from the source listing — flow through to completePurchase. */
  preFaults?: PreFault[];
  /** True when the deal flowed from a sellerVisit (closes that modal too). */
  sellerVisit?: boolean;
  /** Pre-computed finance options. */
  options: FinanceOption[];
  /** Source listing reference (drives odometer initialization). */
  listing?: { mileage: number };
}

/** Per-frame inputs for the purchase menu draw pass. */
export interface PurchaseOpts {
  state: PurchaseMenuState;
  money: number;
  /** Sum of all current car payments (header banner). */
  existingPayments: number;
  /** HUD canvas width / centering offset (v8.99.122). */
  HUD_W: number;
  menuCenterOffX: number;
  /** Canvas internal width / height. */
  GW: number;
  GH: number;
}

/** Side effects of choosing a finance option. */
export interface PurchaseDeps {
  /** Commits the chosen finance option — invokes completePurchase. */
  commit(option: FinanceOption): void;
  /** Closes the purchase menu without committing (BACK button). */
  cancel(): void;
}

/** Cached layout — written by drawPurchaseMenu, read by
 *  handlePurchaseMenuClick. Module-level so the click handler
 *  doesn't have to mirror the paint math. */
let _optYs: number[] = [];
let _cancelY = 0;

/** 1:1 port of monolith L45946-46012. Full-screen 96%-black modal
 *  with PURCHASE OPTIONS header, listing name + price subtitle,
 *  optional 'Current car payments' line, cash-on-hand readout, then
 *  a stack of finance-option cards. Cards color-coded by type (cash
 *  green / lease orange / loan cyan), greyed out + "Need $X" footer
 *  when unaffordable. BACK button at the bottom.
 *
 *  H207 SCOPE: layout + render only. v8.99.122's HUD_W desktop
 *  centering wrapper is omitted — the modular HUD canvas already
 *  centers on desktop via CSS so the `_menuCenterOffX` translate
 *  isn't needed here. Tap router also doesn't subtract that offset. */
export function drawPurchaseMenu(
  ctx: CanvasRenderingContext2D,
  opts: PurchaseOpts,
): void {
  const { state: pm, money, existingPayments, GW, GH } = opts;

  // Full-screen 96%-black backdrop.
  ctx.fillStyle = 'rgba(0, 0, 0, 0.96)';
  ctx.fillRect(0, 0, GW, GH);
  ctx.textAlign = 'center';

  // Header.
  ctx.fillStyle = '#0f0';
  ctx.font = 'bold 14px monospace';
  ctx.fillText('💰 PURCHASE OPTIONS', GW / 2, 20);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 12px monospace';
  ctx.fillText(pm.carName, GW / 2, 40);
  ctx.fillStyle = '#aaa';
  ctx.font = '10px monospace';
  ctx.fillText(
    'Price: $' + pm.price.toLocaleString() + (pm.isNew ? ' (NEW)' : ' (USED)'),
    GW / 2, 56,
  );

  // Current car payments banner (only when player owes monthly).
  if (existingPayments > 0) {
    ctx.fillStyle = '#fa0';
    ctx.font = '9px monospace';
    ctx.fillText('Current car payments: $' + existingPayments + '/mo', GW / 2, 70);
  }

  // Cash on hand.
  ctx.fillStyle = '#0f0';
  ctx.font = '10px monospace';
  ctx.fillText(
    '$' + money.toLocaleString() + ' cash',
    GW / 2,
    existingPayments > 0 ? 82 : 70,
  );

  // Option cards.
  const startY = existingPayments > 0 ? 94 : 82;
  _optYs = [];
  pm.options.forEach((opt, i) => {
    const yy = startY + i * 52;
    _optYs.push(yy);
    const canAfford = money >= opt.down;
    ctx.fillStyle = canAfford ? 'rgba(255, 255, 255, 0.08)' : 'rgba(255, 255, 255, 0.03)';
    ctx.fillRect(10, yy, GW - 20, 46);
    ctx.strokeStyle = canAfford
      ? (opt.type === 'cash' ? '#0f0' : opt.type === 'lease' ? '#f80' : '#0ff')
      : '#444';
    ctx.lineWidth = 1;
    ctx.strokeRect(10, yy, GW - 20, 46);
    ctx.fillStyle = canAfford ? '#fff' : '#666';
    ctx.font = 'bold 12px monospace';
    ctx.fillText(opt.label, GW / 2, yy + 15);
    ctx.fillStyle = canAfford ? '#aaa' : '#555';
    ctx.font = '9px monospace';
    ctx.fillText(opt.desc, GW / 2, yy + 28);
    if (opt.monthly > 0) {
      ctx.fillStyle = canAfford ? '#ff0' : '#555';
      ctx.font = 'bold 9px monospace';
      ctx.fillText(
        'Monthly: $' + opt.monthly + ' • Total: $' + opt.total.toLocaleString(),
        GW / 2, yy + 40,
      );
    }
    if (!canAfford) {
      ctx.fillStyle = '#f44';
      ctx.font = '8px monospace';
      ctx.fillText(
        'Need $' + opt.down.toLocaleString() + ' (short $' + (opt.down - money).toFixed(0) + ')',
        GW / 2, yy + 40,
      );
    }
  });

  // BACK button.
  _cancelY = startY + pm.options.length * 52 + 6;
  ctx.fillStyle = 'rgba(255, 60, 60, 0.15)';
  ctx.fillRect(20, _cancelY, GW - 40, 26);
  ctx.strokeStyle = '#f44';
  ctx.strokeRect(20, _cancelY, GW - 40, 26);
  ctx.fillStyle = '#f44';
  ctx.font = 'bold 11px monospace';
  ctx.fillText('← BACK', GW / 2, _cancelY + 17);

  ctx.textAlign = 'left';
}

/** 1:1 port of monolith L46014-46045. Full-screen modal eats every
 *  tap. BACK closes; an option card commits (with affordability
 *  guard surfaced as a notif via deps). Returns true so the caller
 *  always consumes the tap when the modal is up. */
export function handlePurchaseMenuClick(
  tx: number,
  ty: number,
  opts: PurchaseOpts,
  deps: PurchaseDeps,
): boolean {
  const { state: pm, money, GW } = opts;
  // BACK.
  if (_cancelY && ty >= _cancelY && ty <= _cancelY + 26) {
    deps.cancel();
    return true;
  }
  // Options.
  for (let i = 0; i < pm.options.length; i++) {
    const yy = _optYs[i];
    if (yy != null && ty >= yy && ty <= yy + 46 && tx >= 10 && tx <= GW - 10) {
      const opt = pm.options[i];
      if (money < opt.down) {
        // Unaffordable tap — the card's "Need $X (short $Y)"
        // footer already signals this visually; eat the tap so
        // it doesn't leak to anything underneath.
        return true;
      }
      deps.commit(opt);
      return true;
    }
  }
  return true; // modal eats every tap
}

/** Finalizes the deal — saves current car condition, deducts down,
 *  pushes loan/lease, sets odometer from mileage, adds to ownedCars,
 *  splits faults into detected vs hidden, removes from source array,
 *  closes overlapping modals. TODO(D31-followup): port from L45971-46025. */
export function completePurchase(
  _carId: string,
  _carName: string,
  _price: number,
  _isNew: boolean,
  _finOpt: FinanceOption,
  _source: 'lot' | 'newspaper',
  _index: number,
  _preFaults: PreFault[] | undefined,
  _sellerVisit: boolean,
): void {
  // TODO: L45971-46025. v8.25 condition save before/after switch +
  // odometer-from-mileage. Hidden faults stored with _hiddenFaultOdo
  // baseline so "drive N miles to surface" gating works.
}
