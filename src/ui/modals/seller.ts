/**
 * Seller visit overlay — private-seller dealership simulation.
 *
 * Lifecycle phases (LIFE.sellerVisit.phase):
 *   - 'driving'   → no overlay (just a map pin); player drives to the
 *                   seller's location.
 *   - 'menu'      → full-screen menu (PURCHASE / HAGGLE / INSPECT /
 *                   TEST DRIVE / WALK AWAY).
 *   - 'testdrive' → minimal HUD timer at top center; tap to abort.
 *
 * startSellerVisit places the seller on a random road tile (>20 tiles
 * from home — keeps drives interesting), generates pre-existing faults
 * via generateUsedCarFaults (used cars only), and discounts the listing
 * price by faultPriceDiscount(preFaults) into hagglePrice.
 *
 * Inspect / test drive flags:
 *   - sv._inspected unlocks visual fault disclosure (visual count +
 *     "Some issues only show during driving..." hint when test-drive-
 *     only faults remain undetected).
 *   - sv._testDriven adds the test-drive disclosure (count of felt
 *     issues, or "Drove fine" when none surfaced).
 *
 * Haggle flow:
 *   - haggleWithSeller is the side-effect path the HAGGLE button
 *     invokes. Mirrors inspection.ts haggle math but operates on
 *     LIFE.sellerVisit.hagglePrice instead of inspectCar.hagglePrice.
 *
 * Ported from monolith L49513 (startSellerVisit), L49560 (drawSellerOverlay),
 * L49645 (handleSellerClick), L49708 (haggleWithSeller).
 *
 * All four entry points are live as of H619 (the original SCAFFOLD
 * header is gone — file is ~580 lines of working seller-visit logic).
 */

import type { PreFault } from './inspection';
import { generateUsedCarFaults, faultPriceDiscount } from '@/sim/usedCarFaults';
import type { LifeState } from '@/state/life';
import {
  drawGt2TopBar, drawGt2BottomBar,
  gt2TopBarHitTest, gt2BottomBarHitTest,
  GT2_CHROME, GT2_COLORS,
} from '@/ui/gt2Chrome';

/** Lifecycle phase. */
export type SellerPhase = 'driving' | 'menu' | 'testdrive';

/** Action keys emitted by button taps. */
export type SellerAction = 'buy' | 'haggle' | 'inspect' | 'testdrive' | 'leave';

/** LIFE.sellerVisit shape. */
export interface SellerVisitState {
  listing: {
    id: string;
    name: string;
    price: number;
    cond: number;
    mileage: number;
    isNew: boolean;
  };
  source: 'newspaper' | 'lot';
  index: number;
  /** World coords of the seller location. */
  mapX: number;
  mapY: number;
  phase: SellerPhase;
  /** Pre-existing faults (mostly hidden until inspect / test drive). */
  preFaults: PreFault[];
  /** Test-drive countdown (seconds). */
  testDriveTimer: number;
  /** Saved player car for restore after test drive. */
  tdSavedCar: unknown | null;
  /** Haggle state. */
  haggled: boolean;
  hagglePrice: number;
  /** Inspect / test-drive done flags. */
  _inspected?: boolean;
  _testDriven?: boolean;
  /** H514: symptom-stream accumulator (seconds). The test-drive's
   *  3-second symptom-reveal tick uses this as its clock — every
   *  time it crosses 3 seconds we roll for a hidden-fault reveal
   *  and reset to 0. Resets implicitly between test drives because
   *  startTestDrive doesn't carry sv across visits (it's tied to
   *  sv.phase === 'testdrive' frames only). */
  _revealTimer?: number;
}

/** Lookup shape the renderer needs from the catalog. Decouples the
 *  overlay from CAR_CATALOG so tests can stub. Fields are a subset of
 *  CatalogCar — only what the menu paints. */
export interface CatalogLookup {
  color: string;
  hp: number;
  drv: string;
  /** Region-of-origin slug ('jpn' | 'usa' | 'eur') used for the flag
   *  emoji on the seller header. Optional because CatalogCar doesn't
   *  carry origin yet — the renderer falls through to the empty-flag
   *  branch the monolith's L49503 `||''` fallback already covers. */
  origin?: 'jpn' | 'usa' | 'eur';
}

/** Per-frame inputs for the seller overlay. */
export interface SellerOpts {
  state: SellerVisitState;
  /** Canvas internal width / height. */
  GW: number;
  GH: number;
  /** Resolve the car catalog entry for a listing id. Returns null when
   *  the id isn't known — caller skips paint that would NaN. */
  getCar(id: string): CatalogLookup | null;
  /** H727: LifeState reference for the GT2 bottom status strip
   *  (days · Cr money · current car). Optional — the bottom bar
   *  hides the readouts when missing. */
  life?: LifeState | null;
}

/** Side effects the seller buttons invoke. */
export interface SellerDeps {
  /** PURCHASE — opens the finance menu at hagglePrice. */
  openPurchase(): void;
  /** HAGGLE — applies fault-tier discount via haggleWithSeller. */
  haggle(): void;
  /** INSPECT — sets _inspected, marks visible faults detected. */
  inspect(): void;
  /** TEST DRIVE — saves tdSavedCar, transitions to 'testdrive' phase. */
  startTestDrive(): void;
  /** End test drive early (tap on top HUD timer). */
  endTestDrive(): void;
  /** WALK AWAY — clears LIFE.sellerVisit. */
  walkAway(): void;
  /** H729: opens the GT2-style spec-sheet overlay for the listing's
   *  catalog id. Optional — pre-H729 callers can omit and the ⓘ
   *  hit-test no-ops. */
  viewSpec?(carId: string): void;
}

/** Tile-map shape startSellerVisit needs to find a road for the
 *  marker. Decoupled from src/world/tileMap.ts so tests can stub. */
export interface SellerTileMap {
  width: number;
  height: number;
  /** Returns 1..3 for any kind of road tile (modular only uses 1).
   *  Out-of-bounds reads must return 0. */
  getTile(tx: number, ty: number): number;
}

/** Dependencies startSellerVisit pulls in from the surrounding game.
 *  Tile-size in pixels comes through here so the module stays free
 *  of @/config/world/tiles direct imports (keeps the modal layer
 *  test-isolatable). */
export interface StartSellerVisitDeps {
  tileMap: SellerTileMap;
  /** TILE constant — game-pixels per tile. */
  tilePx: number;
  /** Toast banner — `showNotif` from the seller-visit lifecycle. */
  showNotif(msg: string): void;
}

/** Places the seller on a random road tile (away from home),
 *  initializes life.sellerVisit at phase='driving' (player drives
 *  to the marker), and drops the SELLER MARKED notif.
 *  1:1 port of monolith L49431-49465 minus the fault generation
 *  + price discount steps:
 *    - preFaults stays empty until generateUsedCarFaults ports.
 *    - hagglePrice stays at listing.price until faultPriceDiscount
 *      ports. The H185 menu still surfaces 'Looks clean outside' /
 *      'Drove fine' lines for an empty preFaults list — accurate
 *      reading of "no known issues" rather than a misleading
 *      "actually has issues but we haven't generated them yet". */
export function startSellerVisit(
  life: { sellerVisit?: SellerVisitState | null; homeX: number; homeY: number },
  listing: SellerVisitState['listing'],
  source: 'newspaper' | 'lot',
  index: number,
  deps: StartSellerVisitDeps,
): void {
  const { tileMap, tilePx, showNotif } = deps;
  // Random road-tile placement. Cap at 500 attempts (monolith L49438)
  // so an unlucky walk over grass doesn't hang the frame; the
  // distance-from-home nudge below pulls a non-road pick onto the
  // map regardless.
  let sx = 0;
  let sy = 0;
  for (let attempts = 0; attempts < 500; attempts++) {
    sx = Math.floor(Math.random() * tileMap.width);
    sy = Math.floor(Math.random() * tileMap.height);
    const t = tileMap.getTile(sx, sy);
    if (t >= 1 && t <= 3) break;
  }
  // Don't place too close to home. Manhattan distance < 20 tiles
  // bumps the location +25 tiles down-right (clamped 5 tiles inside
  // the map edge). 1:1 with monolith L49440-49441.
  const hx = life.homeX || 0;
  const hy = life.homeY || 0;
  if (Math.abs(sx - hx) + Math.abs(sy - hy) < 20) {
    sx = Math.min(tileMap.width - 5, sx + 25);
    sy = Math.min(tileMap.height - 5, sy + 25);
  }

  // H190: generate per-listing pre-existing faults + apply the
  // multiplicative price discount on the listing's sticker. New cars
  // bypass — they're rolling off the lot. 1:1 with monolith L49443-
  // 49461.
  const preFaults: PreFault[] = listing.isNew
    ? []
    : generateUsedCarFaults(listing.id, listing.mileage || 0, listing.cond);
  const disc = faultPriceDiscount(preFaults);

  life.sellerVisit = {
    listing,
    source,
    index,
    mapX: sx * tilePx + tilePx / 2,
    mapY: sy * tilePx + tilePx / 2,
    phase: 'driving',
    preFaults,
    testDriveTimer: 0,
    tdSavedCar: null,
    haggled: false,
    hagglePrice: Math.round(listing.price * disc),
  };

  showNotif('📍 SELLER MARKED — Drive to 🚗');
}

/** Per-frame proximity check for the 'driving' phase. When the
 *  player parks within 2 tiles of the marker, flips phase to 'menu'
 *  and zeros pSpeed so the menu doesn't open mid-drift. 1:1 port of
 *  monolith L49467-49476. No-op for any non-'driving' phase. */
export function checkSellerArrival(
  sv: SellerVisitState | null | undefined,
  player: { px: number; py: number; pSpeed: number; phase0B?: unknown },
  deps: { tilePx: number; showNotif(msg: string): void },
): void {
  if (!sv || sv.phase !== 'driving') return;
  const dx = player.px - sv.mapX;
  const dy = player.py - sv.mapY;
  const radius2 = deps.tilePx * deps.tilePx * 4;
  if (dx * dx + dy * dy < radius2 && Math.abs(player.pSpeed) < 3) {
    sv.phase = 'menu';
    player.pSpeed = 0;
    // H508: zero the Phase 0B integrator's residual velocity too.
    player.phase0B = undefined;
    deps.showNotif('You found the seller!');
  }
}

/** Direct-open seller visit from a near-pin tap (pin already in
 *  world; player has just driven up). Mirrors monolith L50386-50398
 *  / L50446-50461: sets phase='menu' immediately, copies pin.worldX/Y
 *  into mapX/Y, zeros pSpeed. preFaults / hagglePrice deferred for
 *  the same reasons as startSellerVisit. */
export function openSellerVisitFromPin(
  life: { sellerVisit?: SellerVisitState | null },
  pin: {
    worldX: number;
    worldY: number;
    listing: SellerVisitState['listing'];
    index?: number;
  },
  player: { pSpeed: number; phase0B?: unknown },
  showNotif: (msg: string) => void,
): void {
  // H190: same fault-gen + discount as startSellerVisit. 1:1 with
  // monolith L50384-50395.
  const L = pin.listing;
  const preFaults: PreFault[] = L.isNew
    ? []
    : generateUsedCarFaults(L.id, L.mileage || 0, L.cond);
  const disc = faultPriceDiscount(preFaults);

  life.sellerVisit = {
    listing: pin.listing,
    source: 'newspaper',
    index: pin.index ?? 0,
    mapX: pin.worldX,
    mapY: pin.worldY,
    phase: 'menu',
    preFaults,
    testDriveTimer: 0,
    tdSavedCar: null,
    haggled: false,
    hagglePrice: Math.round(L.price * disc),
  };
  player.pSpeed = 0;
  // H508: zero the Phase 0B integrator's residual velocity too —
  // the structural player type widens with `phase0B?: unknown` so
  // the assignment compiles whether or not the caller actually
  // carries a PlayerState.
  player.phase0B = undefined;
  showNotif('Meeting the seller...');
}

/** INSPECT button handler — rolls each undetected non-test-drive
 *  fault against its detectChance. Found faults flip detected=true
 *  and the listing's hagglePrice is re-derived from the new discount.
 *  Returns the count of newly-detected faults so the caller can
 *  pick the right notif. 1:1 port of monolith L49593-49612. */
export function inspectSellerCar(sv: SellerVisitState): number {
  if (sv._inspected) return 0;
  sv._inspected = true;
  let found = 0;
  for (const f of sv.preFaults) {
    if (!f.detected && !f.testDriveOnly && Math.random() < (f.detectChance ?? 0.5)) {
      f.detected = true;
      found++;
    }
  }
  if (found > 0) {
    const disc = faultPriceDiscount(sv.preFaults);
    sv.hagglePrice = Math.round(sv.listing.price * disc);
  }
  return found;
}

/** Order matters — same as the monolith's L49543-49549 btns array.
 *  Both the renderer and click router walk this list. */
const SELLER_ACTIONS: readonly SellerAction[] = [
  'buy',
  'haggle',
  'inspect',
  'testdrive',
  'leave',
] as const;

/** GT2 breadcrumb trail for the seller menu — short single-tab path
 *  ("PRIVATE SELLER") since this isn't a multi-screen dealer flow. */
const SELLER_CRUMBS = ['PRIVATE SELLER'];

/** Y-band layout — chrome at top, header below, then variable info
 *  band, then 5 amber action buttons. Heights tuned to match the
 *  old 24-px button + 30-px pitch so sellerButtonY math survives. */
const SELLER_HEADER_BASE = GT2_CHROME.TOP_H + 76; // top of price/info band
const SELLER_HEADER_HAGGLED = SELLER_HEADER_BASE + 10;
const SELLER_BUTTON_PITCH = 30;
const SELLER_BUTTON_H = 24;

/** Computes the Y-pixel offset where the action-button strip starts.
 *  Reads sv.haggled / detected-fault count / sv._inspected /
 *  sv._testDriven — the same sources the H727 paint pass uses to
 *  advance infoY. Shared by renderer + click router so positions
 *  can't drift between paint and hit-test. */
function sellerButtonStartY(sv: SellerVisitState): number {
  let infoY = sv.haggled ? SELLER_HEADER_HAGGLED : SELLER_HEADER_BASE;
  const detected = sv.preFaults.filter((f) => f.detected);
  if (detected.length > 0) {
    infoY += 12; // header line "⚠ KNOWN ISSUES:"
    infoY += detected.length * 11; // one line per detected fault
    infoY += 4; // trailing spacer
  }
  if (sv._inspected) {
    infoY += 12; // "🔍 Visual: ..." line
    const tdOnlyRemain = sv.preFaults.filter(
      (f) => !f.detected && f.testDriveOnly,
    ).length;
    if (!sv._testDriven && tdOnlyRemain > 0) infoY += 10;
  }
  if (sv._testDriven) {
    infoY += 14; // "🚗 Test drive: ..." line
  }
  return infoY;
}

/** Y-pixel position of action button `i` (0..4). */
function sellerButtonY(sv: SellerVisitState, i: number): number {
  return sellerButtonStartY(sv) + i * SELLER_BUTTON_PITCH;
}

/** 1:1 port of monolith L49481-49643. 'driving' renders nothing (the
 *  map pin owns that phase); 'testdrive' renders the slim countdown
 *  bar at the top; 'menu' renders the full-screen seller menu. */
export function drawSellerOverlay(
  ctx: CanvasRenderingContext2D,
  opts: SellerOpts,
): void {
  const { state: sv, GW, GH, getCar } = opts;
  if (sv.phase === 'driving') return;

  // H186: testdrive-phase HUD. 1:1 port of monolith L49481-49489.
  // 110×20 black-translucent bar at top-center with cyan stroke and
  // "TEST DRIVE Xs" countdown (ceil so the last partial-second reads
  // as 1, not 0). Returns before the menu pass so the menu backdrop
  // doesn't paint during the test drive.
  if (sv.phase === 'testdrive') {
    const tLeft = Math.ceil(sv.testDriveTimer);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.fillRect(GW / 2 - 55, 4, 110, 20);
    ctx.strokeStyle = '#0ff';
    ctx.strokeRect(GW / 2 - 55, 4, 110, 20);
    ctx.fillStyle = '#0ff';
    ctx.font = 'bold 11px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('TEST DRIVE ' + tLeft + 's', GW / 2, 18);
    ctx.textAlign = 'left';
    return;
  }

  if (sv.phase !== 'menu') return;
  const L = sv.listing;
  const c = getCar(L.id);
  if (!c) return;

  // GT2 charcoal backplate + chrome strips.
  ctx.fillStyle = GT2_COLORS.bg;
  ctx.fillRect(0, 0, GW, GH);
  drawGt2TopBar(ctx, GW, { crumbs: SELLER_CRUMBS, activeIcon: null });
  drawGt2BottomBar(ctx, opts.life ?? null, GW, GH);

  ctx.textAlign = 'center';

  // Italic display name — GT2's "SKYLINE" treatment. The listing name
  // already arrives capitalized in the catalog; upper-case for the
  // poster-style header.
  ctx.fillStyle = GT2_COLORS.text;
  ctx.font = 'italic bold 18px monospace';
  ctx.fillText(L.name.toUpperCase(), GW / 2, GT2_CHROME.TOP_H + 22);

  // Color swatch immediately below the title.
  ctx.fillStyle = c.color;
  ctx.fillRect(GW / 2 - 22, GT2_CHROME.TOP_H + 28, 44, 6);

  // Spec line + mileage + condition.
  const originLabel =
    c.origin === 'jpn' ? '🇯🇵' : c.origin === 'usa' ? '🇺🇸' : c.origin === 'eur' ? '🇪🇺' : '';
  const mi = L.isNew
    ? '0 mi'
    : L.mileage >= 1000
      ? (L.mileage / 1000).toFixed(0) + 'k mi'
      : L.mileage + ' mi';
  ctx.fillStyle = GT2_COLORS.textMute;
  ctx.font = '10px monospace';
  ctx.fillText(
    (originLabel ? originLabel + ' ' : '') +
      c.hp + 'hp · ' + c.drv + ' · ' + mi + ' · Cond ' + L.cond + '%',
    GW / 2,
    GT2_CHROME.TOP_H + 48,
  );

  // Price block — big amber number with Cr disc, like GT2's BUY
  // price. Haggled-from sub-line in dim grey directly under it.
  ctx.fillStyle = GT2_COLORS.amber;
  ctx.font = 'bold 18px monospace';
  ctx.fillText('Cr ' + sv.hagglePrice.toLocaleString(), GW / 2, GT2_CHROME.TOP_H + 68);
  if (sv.haggled) {
    ctx.fillStyle = GT2_COLORS.textDim;
    ctx.font = '9px monospace';
    ctx.fillText(
      'haggled from Cr ' + L.price.toLocaleString(),
      GW / 2, GT2_CHROME.TOP_H + 78,
    );
  }

  // H729: ⓘ spec-sheet tap target — amber disc to the right of the
  // price block. Mirrors GT2's small info circle next to BUY. Tap
  // routes through deps.viewSpec which sets life.specSheetOpenId.
  drawInfoDisc(ctx, GW - 28, GT2_CHROME.TOP_H + 62, 11);

  // Detected faults / inspection / test-drive disclosures sit in the
  // info band; sellerButtonStartY duplicates the same Y advance so
  // the buttons line up.
  const detected = sv.preFaults.filter((f) => f.detected);
  let infoY = sv.haggled ? SELLER_HEADER_HAGGLED : SELLER_HEADER_BASE;
  if (detected.length > 0) {
    ctx.fillStyle = '#ff7070';
    ctx.font = 'bold 9px monospace';
    ctx.fillText('⚠ KNOWN ISSUES', GW / 2, infoY);
    infoY += 12;
    for (const f of detected) {
      ctx.fillStyle = '#e85a5a';
      ctx.font = '8px monospace';
      ctx.fillText('• ' + f.name, GW / 2, infoY);
      infoY += 11;
    }
    infoY += 4;
  }
  if (sv._inspected) {
    const visualFound = sv.preFaults.filter(
      (f) => f.detected && !f.testDriveOnly,
    ).length;
    const tdOnlyRemain = sv.preFaults.filter(
      (f) => !f.detected && f.testDriveOnly,
    ).length;
    ctx.fillStyle = GT2_COLORS.amber;
    ctx.font = '9px monospace';
    if (visualFound > 0) {
      ctx.fillText(
        '🔍 Visual: ' + visualFound + ' issue' + (visualFound > 1 ? 's' : '') + ' spotted',
        GW / 2,
        infoY,
      );
    } else {
      ctx.fillText('🔍 Visual: Looks clean outside', GW / 2, infoY);
    }
    infoY += 12;
    if (!sv._testDriven && tdOnlyRemain > 0) {
      ctx.fillStyle = GT2_COLORS.textDim;
      ctx.font = '8px monospace';
      ctx.fillText('Some issues only show during driving...', GW / 2, infoY);
      infoY += 10;
    }
  }
  if (sv._testDriven) {
    const tdFound = sv.preFaults.filter(
      (f) => f.detected && f.testDriveOnly,
    ).length;
    ctx.fillStyle = GT2_COLORS.amber;
    ctx.font = '9px monospace';
    if (tdFound > 0) {
      ctx.fillText(
        '🚗 Test drive: ' + tdFound + ' issue' + (tdFound > 1 ? 's' : '') + ' felt',
        GW / 2,
        infoY,
      );
    } else {
      ctx.fillText('🚗 Test drive: Drove fine', GW / 2, infoY);
    }
    infoY += 14;
  }

  // 5 amber action buttons, GT2's rounded-rect style. Disabled
  // (already-haggled / already-inspected) buttons go to the muted
  // amberDim palette so they read greyed without changing layout.
  const labels: Record<SellerAction, string> = {
    buy: '💰 PURCHASE  Cr ' + sv.hagglePrice.toLocaleString(),
    haggle: '🤝 HAGGLE',
    inspect: '🔍 INSPECT',
    testdrive: '🚗 TEST DRIVE',
    leave: '❌ WALK AWAY',
  };
  const disabled: Record<SellerAction, boolean> = {
    buy: false,
    haggle: !!sv.haggled,
    inspect: !!sv._inspected,
    testdrive: false,
    leave: false,
  };
  SELLER_ACTIONS.forEach((action, i) => {
    const by = sellerButtonY(sv, i);
    const isDis = disabled[action];
    const isBuy = action === 'buy';
    const fill = isDis
      ? GT2_COLORS.amberDim
      : isBuy
        ? GT2_COLORS.active
        : GT2_COLORS.amber;
    ctx.fillStyle = fill;
    fillRoundRect(ctx, 14, by, GW - 28, SELLER_BUTTON_H, 4);
    ctx.fillStyle = isDis ? GT2_COLORS.textDim : GT2_COLORS.bgDeep;
    ctx.font = 'bold 10px monospace';
    ctx.fillText(labels[action], GW / 2, by + 15);
  });

  ctx.textAlign = 'left';
}

/** Geometry for the H729 ⓘ spec-sheet tap target — exported via
 *  the click router's hit-test, not as a public symbol. */
const INFO_DISC_R = 11;
function infoDiscRect(GW: number): { cx: number; cy: number; r: number } {
  return { cx: GW - 28, cy: GT2_CHROME.TOP_H + 62, r: INFO_DISC_R };
}

/** Paints the ⓘ disc — amber filled circle with a serif lower-case
 *  "i" knocked out. */
function drawInfoDisc(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number, r: number,
): void {
  ctx.fillStyle = GT2_COLORS.amber;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = GT2_COLORS.bgDeep;
  ctx.font = 'bold italic 14px serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('i', cx, cy + 1);
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
}

/** Inline rounded-rect fill helper — the seller module only needs
 *  one shape, not worth re-exporting from gt2Chrome. */
function fillRoundRect(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
  ctx.fill();
}

/** Hit-tests the action-button strip and dispatches to deps. Returns
 *  true when a button was hit (caller stops the tap). Mirrors monolith
 *  L49566-49623: testdrive-phase tap on the top bar ends the drive
 *  early; menu-phase taps route to the 5 action buttons. */
export function handleSellerClick(
  tx: number,
  ty: number,
  opts: SellerOpts,
  deps: SellerDeps,
): boolean {
  const { state: sv, GW } = opts;

  // H186: testdrive-phase tap. 1:1 port of monolith L49566-49571 —
  // tap inside the 110-wide top bar ends the drive early. The bar
  // itself is y=4..24 but the hit-zone widens to y<30 to give thumbs
  // a forgiving target. Other taps during testdrive pass through
  // (return false) so the player can still steer.
  if (sv.phase === 'testdrive') {
    if (ty < 30 && tx > GW / 2 - 55 && tx < GW / 2 + 55) {
      deps.endTestDrive();
      return true;
    }
    return false;
  }

  if (sv.phase !== 'menu') return false;

  // H727: GT2 chrome consumes top-strip + bottom-strip taps. Home
  // icon, the active SELLER crumb, and the bottom exit arrow all
  // walk away from the seller.
  const { GH } = opts;
  if (gt2TopBarHitTest(tx, ty, GW, SELLER_CRUMBS.length, {
    onHome: deps.walkAway,
  })) return true;
  if (gt2BottomBarHitTest(tx, ty, GH, { onExit: deps.walkAway })) return true;

  // H729: ⓘ spec-sheet disc tap — opens the spec-sheet sub-screen
  // for the seller's listing. No-ops when deps.viewSpec is unbound.
  if (deps.viewSpec) {
    const { cx, cy, r } = infoDiscRect(GW);
    const dx = tx - cx;
    const dy = ty - cy;
    if (dx * dx + dy * dy <= r * r) {
      deps.viewSpec(sv.listing.id);
      return true;
    }
  }

  // Buttons span x=14 .. GW-14. Quick X reject so taps in the side
  // gutters don't accidentally hit-test as button rows.
  if (tx < 14 || tx > GW - 14) return false;
  for (let i = 0; i < SELLER_ACTIONS.length; i++) {
    const by = sellerButtonY(sv, i);
    if (ty >= by && ty <= by + SELLER_BUTTON_H) {
      const action = SELLER_ACTIONS[i];
      // Per-button suppress flags mirror the renderer's grey-out tint:
      // a greyed button is non-functional. Monolith enforces this
      // inside haggleWithSeller / inspect (the action functions
      // themselves no-op when already done) — we mirror at the
      // dispatch layer instead so deps stay side-effect-free for the
      // disabled state.
      if (action === 'haggle' && sv.haggled) return true;
      if (action === 'inspect' && sv._inspected) return true;
      switch (action) {
        case 'buy': deps.openPurchase(); break;
        case 'haggle': deps.haggle(); break;
        case 'inspect': deps.inspect(); break;
        case 'testdrive': deps.startTestDrive(); break;
        case 'leave': deps.walkAway(); break;
      }
      return true;
    }
  }
  return false;
}

/** HAGGLE button handler. Once-per-visit price negotiation: 30%
 *  chance the seller refuses; 70% chance hagglePrice drops to
 *  80-95% of its current value (uniform). Returns the new price
 *  when accepted, or null when refused — caller picks the right
 *  notif. No-op when sv.haggled is already true (button greys out
 *  in the H185 menu after first use). 1:1 port of monolith
 *  L49626-49637.
 *
 *  NOTE: the multiplier compounds with whatever discount
 *  faultPriceDiscount + INSPECT/test-drive reveals have already
 *  applied — the monolith doesn't separately track sticker vs.
 *  haggled, so a heavily inspected car that haggles down can land
 *  meaningfully below sticker. */
export function haggleWithSeller(sv: SellerVisitState): number | null {
  if (sv.haggled) return null;
  sv.haggled = true;
  if (Math.random() < 0.3) return null; // seller won't budge
  const disc = 0.80 + Math.random() * 0.15;
  sv.hagglePrice = Math.round(sv.hagglePrice * disc);
  return sv.hagglePrice;
}
