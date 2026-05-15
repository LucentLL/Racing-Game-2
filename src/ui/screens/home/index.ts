/**
 * Home screen orchestrator — header + tab bar + sub-tab dispatch + the
 * top-level click router for everything that happens while
 * LIFE.homeScreenOpen is true.
 *
 * The home screen is the largest UI cluster in the game (~3,600 lines
 * across L47297-50972). This file is just the orchestrator; each tab
 * lives in its own module:
 *
 *   - 'main' / sub-tab nav  → this file (header strip + tabs row)
 *   - 'mail'    → ./mail
 *   - 'garage'  → ./garage  (dispatches further to specs/repairs/parts)
 *   - 'eat'     → ./eat     (HEALTH & FITNESS tab — eating + shop + gym)
 *   - 'housing' → ../housing       [D30]
 *   - 'bills'   → ../bills         [D30]
 *   - 'newspaper' → ../newspaper   [D30]
 *   - 'cal'     → ../calendar      [D30]
 *
 * Click dispatcher contract — handleHomeScreenClick is MODAL-AWARE and
 * the priority order matters:
 *   1. Bills-due prompt (LIFE.billsDuePrompt) intercepts ALL clicks.
 *   2. Purchase / inspection / sell-confirm / repair-popup intercepts.
 *      These layer ABOVE tab content and must steal the tap before any
 *      row hit-test runs (v8.98.44 + v8.99.34 fixes).
 *   3. BACK button (priority before tab content — v8.98.45/46 fixes —
 *      uses GH_BASE not GH so tilt mode doesn't break the hit-box).
 *   4. Tab-specific row hit-tests (delegated to the active tab module).
 *
 * v8.99.122 desktop centering: the home screen is GW-wide centered on a
 * full-bleed black HUD canvas; the click handler subtracts
 * _menuCenterOffX from tx before any per-tab dispatch.
 *
 * Ported from monolith L47297-47877 (drawHomeScreen header/tabs) +
 * L50563-50972 (handleHomeScreenClick dispatcher).
 *
 * SCAFFOLD status: type contract + entry points stubbed with TODO line
 * refs.
 */

/** All tabs the home screen can route to. 'main' is the dashboard. */
export type HomeTab =
  | 'main'
  | 'mail'
  | 'garage'
  | 'eat'
  | 'housing'
  | 'bills'
  | 'newspaper'
  | 'cal';

/** Per-frame inputs for the home screen orchestrator. */
export interface HomeScreenOpts {
  /** Active tab. */
  tab: HomeTab;
  /** Player display state for the header. */
  playerAlias: string;
  age: number;
  money: number;
  gender: 'M' | 'F';
  fitness: number;
  skinTone: number;
  health: number;
  /** Date string from getDateString(). */
  dateString: string;
  /** Active time slot — drives sub-tab compact header. */
  timeSlot: 'morning' | 'afternoon' | 'night';
  /** Slots not yet consumed today — drives "N slots left" hint. */
  slotsRemaining: number;
  /** HUD canvas width / centering offset (v8.99.122 desktop centering). */
  HUD_W: number;
  menuCenterOffX: number;
  /** Canvas internal width / height. */
  GW: number;
  GH: number;
}

/** Modal flag bag the click dispatcher consults before any tab handler.
 *  Each flag, when true, fully steals the click. Order matches the
 *  monolith priority (v8.98.44 / v8.99.34 / v8.98.45). */
export interface HomeModalFlags {
  /** Bills-due prompt overlays the whole screen. */
  billsDuePrompt: boolean;
  /** Purchase finance modal overlay. */
  purchaseMenu: boolean;
  /** Inspection overlay (inspectCar truthy). */
  inspectActive: boolean;
  /** v8.99.34 sell-to-lot confirm overlay. */
  sellConfirm: boolean;
  /** v8.98.44 repair popup overlay. */
  repairPopup: boolean;
}

/** Caller-supplied callbacks for click dispatch. The orchestrator owns
 *  modal precedence; each callback is the tab/modal-specific handler. */
export interface HomeScreenDeps {
  /** Tab handlers — each may consume the tap or no-op. */
  handleMail(tx: number, ty: number): void;
  handleGarage(tx: number, ty: number): void;
  handleEat(tx: number, ty: number): void;
  handleHousing(tx: number, ty: number): void;
  handleBills(tx: number, ty: number): void;
  handleNewspaper(tx: number, ty: number): void;
  handleCalendar(tx: number, ty: number): void;
  /** Modal handlers (invoked when matching flag is set). */
  handleBillsPrompt(tx: number, ty: number): void;
  handlePurchaseMenu(tx: number, ty: number): void;
  handleInspection(tx: number, ty: number): void;
  handleSellConfirm(tx: number, ty: number): void;
  handleRepairPopup(tx: number, ty: number): void;
  /** Switches to a tab (sets LIFE.homeTab and resets per-tab scroll). */
  switchTab(tab: HomeTab): void;
  /** Closes the home screen (sets LIFE.homeScreenOpen=false). */
  closeHome(): void;
}

/** Draws the header (full on 'main', compact on sub-tabs) and the tab
 *  navigation row. Per-tab content is drawn by the matching tab module
 *  (the caller invokes drawHomeMail / drawHomeGarage / etc. after this).
 *  TODO(D29-followup): port from L47297-47877. */
export function drawHomeScreen(
  _ctx: CanvasRenderingContext2D,
  _opts: HomeScreenOpts,
): void {
  // TODO: L47297-47877. Header layout differs per tab — full player +
  // bills + debt summary on 'main', compact $ + slot indicator on sub-tabs.
  // Tabs row (icons + labels): MAIL, GARAGE, EAT, HOUSING, BILLS, NEWS, CAL.
}

/** Routes a click. Modal precedence runs first (bills → sell-confirm →
 *  repair-popup → purchase → inspect), then BACK button, then per-tab
 *  delegation via deps.handleX(tx, ty).
 *  TODO(D29-followup): port from L50563-50972. */
export function handleHomeScreenClick(
  _tx: number,
  _ty: number,
  _opts: HomeScreenOpts,
  _flags: HomeModalFlags,
  _deps: HomeScreenDeps,
): void {
  // TODO: L50563-50972. Subtract _menuCenterOffX from tx FIRST, then
  // walk modal precedence, then BACK (uses GH_BASE not GH per v8.98.46),
  // then per-tab dispatch.
}
