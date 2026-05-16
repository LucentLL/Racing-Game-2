/**
 * Inspection modal — pre-purchase fault disclosure for used cars.
 *
 * Opens when the player taps INSPECT on a used car (lot or private
 * seller). Splits preFaults into:
 *   - detected (visual issues found on inspection — listed with tier,
 *     name, repair cost)
 *   - hidden (test-drive-only — never shown directly; "Some issues may
 *     only appear after driving" hint when present)
 *
 * Three terminal actions:
 *   - HAGGLE  → only visible when !haggled && detected.length>0.
 *               Discount per detected fault by tier:
 *                 cheap:     3-8%, moderate:  5-13%
 *                 extensive: 8-20%, severe:  10-25%
 *               Total discount capped at 40% off.
 *   - PURCHASE → opens the purchase finance menu at hagglePrice.
 *   - PASS     → walks away.
 *
 * v8.99.122 desktop centering: full-bleed black HUD, then translate to
 * center the GW-wide content. Click handler subtracts _menuCenterOffX
 * from tx symmetrically.
 *
 * Ported from monolith L43458-43580.
 *
 * SCAFFOLD status: type contract + entry points stubbed with TODO line
 * refs.
 */

/** Single pre-existing fault (from generateUsedCarFaults). */
export interface PreFault {
  name: string;
  /** Repair tier — drives color + label. */
  tier: 'cheap' | 'moderate' | 'extensive' | 'severe';
  /** Estimated repair cost ($). */
  cost: number;
  /** True when discoverable on inspection (visible on this modal). */
  detected: boolean;
  /** True when only the test drive surfaces this fault. */
  testDriveOnly?: boolean;
  /** Per-fault override on the random-detect roll the inspect button
   *  (L49599: 0.5 default) and the end-of-test-drive reveal pass
   *  (L49759: 0.4 default) use. Set by generateUsedCarFaults per fault
   *  type so well-disguised issues stay hidden longer. */
  detectChance?: number;
  /** Free-form fault identifier (monolith `f.id`) used by FAULT_EFFECTS
   *  lookups during the test-drive symptom stream. Optional because
   *  the symptom stream isn't ported yet. */
  id?: string;
  /** Mid-drive reveal latch — true after the symptom stream has
   *  surfaced this fault as a notif. Prevents double-reveal. */
  _revealed?: boolean;
}

/** Listing being inspected (the lot row or newspaper entry). */
export interface InspectListing {
  id: string;
  name: string;
  price: number;
  cond: number;
  mileage: number;
  isNew: boolean;
  preFaults?: PreFault[];
}

/** LIFE.inspectCar / inspectCar shape. */
export interface InspectState {
  listing: InspectListing;
  /** 'lot' | 'newspaper' — drives header and removal-on-purchase routing. */
  source: 'lot' | 'newspaper';
  /** Index back into the source array. */
  index: number;
  /** Current haggled price (starts equal to listing.price). */
  hagglePrice: number;
  /** True after the player haggled — disables HAGGLE button. */
  haggled: boolean;
}

/** Per-frame inputs for the inspection draw pass. */
export interface InspectOpts {
  state: InspectState;
  /** HUD canvas width / centering offset (v8.99.122). */
  HUD_W: number;
  menuCenterOffX: number;
  /** Canvas internal width / height. */
  GW: number;
  GH: number;
}

/** Side effects the click handler delegates to. */
export interface InspectDeps {
  /** Commit a haggle: applies the fault-tier discount, sets haggled=true. */
  applyHaggle(): void;
  /** Open the purchase finance menu at hagglePrice. */
  openPurchaseMenu(): void;
  /** Walk away — closes the modal without buying. */
  passOnDeal(): void;
  showNotif(msg: string): void;
}

/** Draws the dim backdrop + car/price header + KNOWN ISSUES list +
 *  hint about hidden faults + HAGGLE / PURCHASE / PASS buttons. Hidden
 *  faults are NEVER rendered directly — only counted into the hint.
 *  TODO(D31-followup): port from L43458-43534. */
export function drawInspection(
  _ctx: CanvasRenderingContext2D,
  _opts: InspectOpts,
): void {
  // TODO: L43458-43534. v8.99.122 desktop centering wraps the body in
  // ctx.save / translate(_menuCenterOffX) / ctx.restore.
}

/** Routes a tap to HAGGLE / PURCHASE / PASS. Subtracts _menuCenterOffX
 *  from tx FIRST (v8.99.122 desktop centering).
 *  TODO(D31-followup): port from L43536-end of inspection click. */
export function handleInspectionClick(
  _tx: number,
  _ty: number,
  _opts: InspectOpts,
  _deps: InspectDeps,
): boolean {
  // TODO: L43536+. Haggle discount: per-tier 3-8/5-13/8-20/10-25 %, cap 40%.
  return false;
}
