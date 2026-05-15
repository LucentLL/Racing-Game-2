/**
 * Repair popup — v8.98.44 modal venue picker for repairs / mods.
 *
 * Modal-strict (per home/index.ts dispatcher): while LIFE.repairPopup is
 * up, it intercepts ALL taps before any tab-row hit-test runs. The
 * v8.98.44 fix moved this check to the top of handleHomeScreenClick to
 * stop the popup's venue buttons from triggering garage rows beneath.
 *
 * Three venues offered (DIY / Mechanic / Dealer). Aftermarket mods skip
 * the dealer (v8.62/v8.63 — no real dealership welds diffs or bolts on
 * superchargers; v8.99.126.80 trans swaps too — same logic). The mod
 * stat list lives in two places (drawRepairPopup _MOD_STATS and
 * handleRepairPopupClick _MOD_STATS) and they MUST stay in sync — the
 * scaffold exports the constant once so future implementors can't drift.
 *
 * Per-venue economics:
 *   - DIY      : cheapest, slowest, requires skill, GAINS skill on completion.
 *   - Mechanic : mid-price, mid-time, no skill req, tracks visits for connections.
 *   - Dealer   : most expensive, sometimes instant, no skill req.
 *
 * processRepair routes the chosen venue. Instant repairs (v.time===0)
 * applyPart immediately; queued repairs push into LIFE.pendingParts with
 * carId tag (v8.99.32 — survives car swaps) and venueKey/isDelivery tags
 * (v8.98.47 — DIY-ordered delivery routes to ownedParts inventory
 * instead of auto-installing).
 *
 * Ported from monolith L42702-42940.
 *
 * SCAFFOLD status: type contract + entry points stubbed with TODO line
 * refs.
 */

/** Stats that mark an item as an aftermarket mod (skip-dealer rule).
 *  Single source of truth — drawRepairPopup AND handleRepairPopupClick
 *  both consult this. */
export const MOD_STATS = [
  'welded',
  'supercharged',
  'manual_swap',
  'auto_swap',
  'steering_swap',
] as const;

/** Venue keys in display order. */
export type VenueKey = 'diy' | 'mechanic' | 'dealer';

/** One venue option (from getVenueOptions). */
export interface VenueOption {
  label: string;
  price: number;
  /** Time in days. 0 = instant repair. */
  time: number;
  /** Mech-skill required (DIY only — others 0). */
  skillReq: number;
  /** False when blocked by skill. */
  canDo: boolean;
}

/** Item being repaired or installed. */
export interface RepairItem {
  name: string;
  /** Stat key — drives label + mod detection. */
  stat: string;
  /** Stat boost percentage (when not a mod). */
  add?: number;
  /** Difficulty (drives DIY skill gain). */
  diff?: number;
  /** 'delivery' marks DIY-ordered parts that route to ownedParts. */
  type?: string;
}

/** LIFE.repairPopup shape. */
export interface RepairPopupState {
  item: RepairItem;
  /** True when the item is a fault being repaired (vs. an install / mod). */
  isFault: boolean;
}

/** Per-frame inputs for the popup draw. */
export interface RepairPopupOpts {
  state: RepairPopupState;
  /** Player money + skill (drives can-afford / skillReq coloring). */
  money: number;
  mechSkill: number;
  /** Computed venue options for this item (getVenueOptions(item)). */
  venues: Record<VenueKey, VenueOption>;
  /** Active car ID (used by getEffectiveRHD for steering_swap label). */
  activeCar: string;
  /** True when the active car renders right-hand-drive — drives
   *  steering_swap label ('Convert to LHD' vs 'Convert to RHD'). */
  isRhd: boolean;
  /** Canvas internal width / height. */
  GW: number;
  GH: number;
}

/** Side effects processRepair invokes (the screen stays presentation-only). */
export interface RepairPopupDeps {
  /** Spends money and applies/queues the part. Implements processRepair body. */
  processRepair(venueKey: VenueKey): void;
  /** Closes the popup (LIFE.repairPopup=null). */
  cancel(): void;
}

/** Draws the dim backdrop + title + skill bar + venue stack + cancel
 *  button. Each venue row pushes into rp._venueY for hit-testing.
 *  TODO(D31-followup): port from L42702-42789. */
export function drawRepairPopup(
  _ctx: CanvasRenderingContext2D,
  _opts: RepairPopupOpts,
): void {
  // TODO: L42702-42789. Mod stat detection skips the dealer venue —
  // venueKeys = isMod ? ['diy','mechanic'] : ['diy','mechanic','dealer'].
}

/** Routes a tap to a venue button or the cancel button. Returns true
 *  when consumed. TODO(D31-followup): port from L42919-42940. */
export function handleRepairPopupClick(
  _tx: number,
  _ty: number,
  _opts: RepairPopupOpts,
  _deps: RepairPopupDeps,
): boolean {
  // TODO: L42919-42940. Use MOD_STATS to mirror the draw-side venue list.
  return false;
}

/** Spends money, runs the venue-specific repair (instant or queued),
 *  awards DIY skill on completion, tracks mechanic visits, and clears
 *  LIFE.repairPopup. TODO(D31-followup): port from L42867-42916. */
export function processRepair(
  _venueKey: VenueKey,
  _opts: RepairPopupOpts,
): void {
  // TODO: L42867-42916. v8.99.32 carId tag, v8.98.47 venueKey + isDelivery
  // tags survive car swaps and route delivery parts to ownedParts.
}
