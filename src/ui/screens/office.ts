/**
 * Office day-flow menu — three-phase modal that drives the OFFICE JOB
 * workday. Opens when the player arrives at the office (arrival
 * detection lives in the main update loop).
 *
 * v8.98.50 introduction. Phases (LIFE.officeMenu.phase):
 *   - 'arrive':    ☕ COFFEE / 💼 START WORK / ✕ CANCEL
 *                  CANCEL is only available here — once WORK is picked,
 *                  the workday is locked in.
 *   - 'lunch':     🍴 LUNCH ($12, +2 health) / ⏭ SKIP LUNCH
 *   - 'afternoon': 💼 CONTINUE WORK (full pay) / 🚗 LEAVE EARLY (60% pay,
 *                  afternoon stays free)
 *
 * Side effects per action live in officeMenuAction (called from
 * handleOfficeMenuClick); completeOfficeDay finalizes the day with
 * salary capping and slot-bookkeeping rules (markSlotDone has an
 * office-specific branch that consumes BOTH morning + afternoon —
 * leaveEarly bypasses it and only marks morning).
 *
 * Coffee buff: 2 slots of relief vs. sleep debt. Stored in
 * LIFE.coffeeBuff (countdown).
 *
 * Hit rects emitted into LIFE._officeBtnRects.
 *
 * Ported from monolith L47156-47294.
 *
 * SCAFFOLD status: type contract + entry points stubbed with TODO line
 * refs. Mid-day mutations (officeMenuAction body) are called via
 * OfficeDeps callbacks so the screen stays presentation-only.
 */

/** Active phase of the office day flow. */
export type OfficePhase = 'arrive' | 'lunch' | 'afternoon';

/** Action keys emitted by button taps. */
export type OfficeAction =
  | 'coffee'
  | 'work'
  | 'cancel'
  | 'lunch'
  | 'skip'
  | 'continue'
  | 'leaveEarly';

/** LIFE.officeMenu shape. */
export interface OfficeMenuState {
  phase: OfficePhase;
  /** True after the player bought coffee this morning. */
  coffeeTaken: boolean;
  /** True after the player ate lunch this midday. */
  lunchTaken: boolean;
}

/** Per-frame inputs for the office menu. */
export interface OfficeMenuOpts {
  /** Active state — null hides the menu (early return at L47157). */
  menu: OfficeMenuState | null;
  /** Player money (gates coffee + lunch buttons). */
  money: number;
  /** Player health (header strip readout). */
  health: number;
  /** Active coffee buff slots remaining (LIFE.coffeeBuff). */
  coffeeBuff: number;
  /** Canvas internal width / height. */
  GW: number;
  GH: number;
}

/** Side-effect callbacks invoked by button taps. The screen stays
 *  presentation-only; the caller commits LIFE / showNotif side effects. */
export interface OfficeDeps {
  /** Routes a chosen action to the right side-effect path (coffee buy,
   *  work commit, lunch buy, etc.). Implements officeMenuAction body. */
  performAction(action: OfficeAction): void;
}

/** Draws the dim backdrop + header + stat strip + phase-driven button
 *  stack. Each addBtn call pushes into LIFE._officeBtnRects.
 *  TODO(D30-followup): port from L47156-47209. */
export function drawOfficeMenu(
  _ctx: CanvasRenderingContext2D,
  _opts: OfficeMenuOpts,
): void {
  // TODO: L47156-47209. Three button stacks per phase. Disabled buttons
  // (coffeeTaken / can't afford / lunchTaken) render with #444 borders +
  // #555 text and skip the action on tap (L47215 enabled gate).
}

/** Routes a tap through LIFE._officeBtnRects to the matching action key,
 *  then delegates to deps.performAction. Disabled buttons no-op.
 *  TODO(D30-followup): port from L47211-47220. */
export function handleOfficeMenuClick(
  _tx: number,
  _ty: number,
  _opts: OfficeMenuOpts,
  _deps: OfficeDeps,
): void {
  // TODO: L47211-47220.
}

/** Finalizes the office workday. leftEarly=true → morning slot only,
 *  60% salary cap, afternoon stays free. leftEarly=false → standard
 *  flow, both slots used (markSlotDone has an office branch),
 *  full salary. Logs a calendar entry in either case.
 *  TODO(D30-followup): port from L47272-47294. */
export function completeOfficeDay(_leftEarly: boolean): void {
  // TODO: L47272-47294. leftEarly bypasses markSlotDone's office branch
  // (which consumes both slots) and manually sets only LIFE.slotsUsed.morning.
}
