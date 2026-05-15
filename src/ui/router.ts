/**
 * UI router — modal-priority overlay cascade and pointer-tap dispatcher.
 *
 * Two surfaces, one priority order:
 *
 *  - drawUiOverlays() — called from render() AFTER the world buffer is
 *    restored. Walks the priority cascade and draws whichever overlays
 *    LIFE/RACE/module flags say should be visible right now. Ported from
 *    monolith L34586–35872 (the "MENU OVERLAY" block at the tail of the
 *    render() function).
 *
 *  - handleUiTap() — called from the mouse-down / single-finger tap path.
 *    Same priority cascade, but routes the tap to the matching screen's
 *    click handler. Returns true if the tap was consumed, so the caller
 *    can fall through to world-marker / cruise-button / minimap handling
 *    only when no UI swallowed the event. Ported from monolith L21780+.
 *
 * The two surfaces share a priority order: an overlay that's visually on
 * top must also receive taps. Both functions read the same UiFlags snapshot
 * to avoid drift.
 *
 * SCAFFOLD status: type contract + cascade skeleton. Each branch routes to
 * a deps method stubbed with a TODO line reference. The matching
 * screen/modal modules land in follow-up commits:
 *
 *   D27 — hud/{speedoSvg,rpmGauge,minimap,canvasHud}
 *   D28 — screens/{title,nameEntry,jobSelect,carSelect}
 *   D29 — screens/home/{index,garage,mail,eat}
 *   D30 — screens/home/{housing,bills,newspaper,calendar} + office
 *   D31 — modals/{purchase,repair,inspection,seller,realtor,pinPicker,confirm}
 *   D32 — overlays/{fullMap,raceHud,notif}
 *
 * As each lands, this file imports their draw + handle exports and drops
 * the corresponding deps slot. Until then the deps interface is the
 * integration contract.
 */

/** Snapshot of the flags that drive overlay priority. The router reads
 *  this once per frame / per tap to avoid double-evaluating LIFE.* and
 *  module-scope booleans during the cascade. */
export interface UiFlags {
  /** Player home-screen tabs (garage/mail/eat/housing/bills/newspaper/calendar). */
  homeScreenOpen: boolean;
  /** Main tabbed menu (STATUS/JOBS/RACE/CAL/OPT). Owned by the menu module. */
  menuOpen: boolean;
  /** #carSelect modal (DOM-backed). */
  carSelectOpen: boolean;
  /** Gas station tabbed modal (fuel / paint / mechanic). */
  fuelMenuOpen: boolean;
  /** Full-screen map overlay (F-toggle). */
  fullMapOpen: boolean;
  /** Mid-breakdown — disables most input until tow arrives. */
  broken: boolean;
  /** Tow service menu (call/wait). */
  towMenuOpen: boolean;
  /** Office day-flow modal (work / skip). */
  officeMenu: boolean;
  /** Purchase finance modal (loan/lease/cash). */
  purchaseMenu: boolean;
  /** Seller dealership visit — phase decides whether overlay is up. */
  sellerVisitActive: boolean;
  /** Realtor home-purchase visit — phase decides whether overlay is up. */
  realtorVisitActive: boolean;
  /** Inspection modal for a single car (lot / pin / dealer). */
  inspectActive: boolean;
  /** v8.98.22 confirm-yes/no prompt (sits above everything else). */
  confirmPromptActive: boolean;
  /** Active race phase — 'setup'|'ready'|'countdown'|'running'|'result'|''. */
  racePhase: string;
}

/** Pointer-event payload for the tap dispatcher. Coordinates are in HUD
 *  canvas space; menu-local conversion (subtracting _menuCenterOffX) is
 *  the menu screen's responsibility. */
export interface UiTap {
  /** Tap x in HUD canvas coordinates. */
  tx: number;
  /** Tap y in HUD canvas coordinates. */
  ty: number;
}

/**
 * Per-overlay draw + tap-handler callbacks. The router holds no drawing or
 * input logic of its own — every branch delegates here. Each pair lands
 * with its matching D27–D32 commit; until then they're stubbed in the
 * caller.
 */
export interface UiRouterDeps {
  /** Seller dealership visit overlay. Monolith L49560+ / handler L49645+. */
  seller: { draw(): void; tap(tap: UiTap): boolean };
  /** Realtor home purchase overlay. Monolith L49990+ / handler L50106+. */
  realtor: { draw(): void; tap(tap: UiTap): boolean };
  /** Purchase finance modal. Monolith L46028+ / handler L46096+. */
  purchase: { draw(): void; tap(tap: UiTap): boolean };
  /** Office day-flow modal. Monolith L47156+ / handler L47297+. */
  office: { draw(): void; tap(tap: UiTap): boolean };
  /** Breakdown indicator + CALL TOW affordance. Monolith L34597-34608 /
   *  handler L21754-21758. */
  breakdown: { draw(): void; tap(tap: UiTap): boolean };
  /** Main tabbed menu (STATUS/JOBS/RACE/CAL/OPT). Monolith L34610-35858 /
   *  handler L21784-end-of-menu. */
  mainMenu: { draw(): void; tap(tap: UiTap): boolean };
  /** Home screen + sub-tabs (garage/mail/eat/housing/bills/...). Monolith
   *  L47297+ / handler L50563+. */
  homeScreen: { draw(): void; tap(tap: UiTap): boolean };
  /** Inspection modal. Monolith L43458+ / handler L43536+. */
  inspection: { draw(): void; tap(tap: UiTap): boolean };
  /** v8.98.22 confirm prompt (modal — wins over the main menu). Monolith
   *  L42026-42058. */
  confirmPrompt: { tap(tap: UiTap): boolean };
}

/**
 * Draw the modal-priority cascade. Called once per frame from render()
 * AFTER world-buffer phases (and AFTER the HUD context swap from
 * src/render/index.ts phase 15). Each branch is gated by the same flag
 * that gates its tap handler, so the visual stack and the input stack
 * stay in sync.
 *
 * Priority order (back to front):
 *   1. Seller visit overlay     (L34586)
 *   2. Realtor visit overlay    (L34588)
 *   3. Purchase finance modal   (L34591)  ← early-out for office flow
 *   4. Office day-flow menu     (L34594)
 *   5. Breakdown indicator      (L34597)
 *   6. Main tabbed menu         (L34610)  ← largest block
 *   7. Home screen overlay      (L35861)
 *   8. Inspection overlay       (L35866)
 *   9. Purchase finance modal   (L35871)  ← second site for non-office flow
 *
 * NOTE: the monolith has TWO `if(LIFE.purchaseMenu) drawPurchaseMenu()`
 * sites (L34591 and L35871). The first runs before the main menu so the
 * purchase modal renders behind the menu when both are open during the
 * office-purchase flow; the second runs after the home screen so the
 * modal renders ABOVE the home screen for the dealership-purchase flow.
 * Preserve both call sites until D31 confirms only one is reachable.
 */
export function drawUiOverlays(
  _flags: UiFlags,
  _deps: UiRouterDeps,
): void {
  // TODO(D26-followup): port cascade from L34586-35872.
  //
  // if (flags.sellerVisitActive) deps.seller.draw();
  // if (flags.realtorVisitActive) deps.realtor.draw();
  // if (flags.purchaseMenu) deps.purchase.draw();              // early
  // if (flags.officeMenu) deps.office.draw();
  // if (flags.broken) deps.breakdown.draw();
  // mctrl visibility computation (L34611-34615) is NOT the router's job —
  //   it belongs in the mobile-controls visibility module. The router only
  //   owns the priority cascade.
  // if (flags.menuOpen) deps.mainMenu.draw();
  // if (flags.homeScreenOpen) deps.homeScreen.draw();
  // if (flags.inspectActive) deps.inspection.draw();
  // if (flags.purchaseMenu) deps.purchase.draw();              // late
}

/**
 * Route a pointer tap to the correct overlay. Returns true if the tap was
 * consumed by any UI surface — the caller (mouse/touch handler) should
 * then skip world-marker / cruise-button / minimap-toggle / menu-bar fall
 * through.
 *
 * Priority order matches drawUiOverlays(). The confirm prompt is checked
 * BEFORE the main-menu handler because it draws above the menu (L21789-
 * 21791). Tab/scroll handling inside each surface stays in that surface's
 * module — the router only decides which surface gets the tap.
 *
 * Ported from monolith L21780+ (mouse path). The touch handler at L8505
 * mirrors this cascade; both will call into this same function once
 * touch input is converted in D27 (input wiring).
 */
export function handleUiTap(
  _tap: UiTap,
  _flags: UiFlags,
  _deps: UiRouterDeps,
): boolean {
  // TODO(D26-followup): port dispatcher from L21780+.
  //
  // if (flags.confirmPromptActive && deps.confirmPrompt.tap(tap)) return true;
  // if (flags.homeScreenOpen) return deps.homeScreen.tap(tap);
  // if (flags.menuOpen) return deps.mainMenu.tap(tap);
  // if (flags.fuelMenuOpen) return false;        // D31 — fuel modal owns its taps
  // if (flags.carSelectOpen) return false;       // DOM-backed; handled by carSelect module
  // if (flags.purchaseMenu) return deps.purchase.tap(tap);
  // if (flags.officeMenu) return deps.office.tap(tap);
  // if (flags.inspectActive) return deps.inspection.tap(tap);
  // if (flags.sellerVisitActive) return deps.seller.tap(tap);
  // if (flags.realtorVisitActive) return deps.realtor.tap(tap);
  // if (flags.broken) return deps.breakdown.tap(tap);
  // if (flags.fullMapOpen) { closeFullMap(); return true; }   // L21730 — trivial close
  return false;
}
