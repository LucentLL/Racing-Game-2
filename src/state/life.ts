/**
 * LifeState — the player's persistent "life sim" state. Type definition for
 * the runtime LIFE object. The singleton is built in Phase G integration;
 * this file is the type contract that save/load and the sim modules code
 * against.
 *
 * Fields are intentionally permissive (mostly optional) so the type can grow
 * incrementally as more subsystems are extracted from the monolith.
 */

import type { NewspaperListing } from '@/sim/newspaperGenerator';

export type Gender = 'M' | 'F';

export interface FoodStock {
  junk: number;
  regular: number;
  premium: number;
}

/** H180: player-placed map marker for a newspaper car listing. Pushed
 *  when the player taps "PIN IT" in the newspaper pin-picker (port
 *  pending); rendered on the minimap and full-map until the listing
 *  expires or the player unpins. Monolith schema at L7930 + L50296. */
export interface CarPin {
  /** World-space coords (pixels, not tiles) where the car is parked. */
  worldX: number;
  worldY: number;
  /** Pin dot color — from the PIN_COLORS palette (#f44, #4f4, etc). */
  color: string;
  /** Short label rendered inside the pin (e.g. "1", "2", "A"). */
  label: string;
  /** Newspaper-listing index for dedup when the pin-picker reopens. */
  index?: number;
  /** Day this pin auto-expires (mirrors the listing's expiresDay). */
  expiresDay?: number;
  /** Backreference to the source listing — set by the pin-creator path
   *  (newspaper UI). Typed as unknown here so the renderer can stay
   *  decoupled from the newspaper module. */
  listing?: unknown;
  /** Cached parked-car angle (deterministic from worldX/Y, set on first
   *  world-draw). Renderer-private; not persisted. */
  _parkAngle?: number;
}

export interface CarLoan {
  carId: string;
  balance: number;
  monthlyPayment: number;
  monthsRemaining: number;
  apr: number;
}

export interface BankLoan {
  amount: number;
  monthsRemaining: number;
  monthlyPayment: number;
  apr: number;
}

export interface CalendarEvent {
  /** H548: absolute in-game day the event landed on. Matches
   *  monolith CalendarEvent.day at L46319. month + dom are
   *  redundant but kept for compat — the calendar tab queries
   *  by (month, dom) for its monthly grid render. */
  day: number;
  month: number;
  dom: number;
  /** One-letter category tag: 'P' payday, 'B' bill, 'W' work,
   *  'C' cruise, 'R' race, 'A' arrest/activity. */
  type: string;
  /** Time-slot the event landed in: 'morning' / 'afternoon' /
   *  'night', or '' for slot-agnostic events (bills, races). */
  slot: string;
  /** Player-facing description ("Payday $X (tax -$Y)"). */
  label: string;
}

export interface GameplaySettings {
  volCarSfx?: number;
  volMenuSfx?: number;
  volMusic?: number;
  /** H154: X-Ray body toggle. When true, drawPlayerCarV2 forces the
   *  carBody dispatcher to the X-Ray branch (dashed cyan outline +
   *  yellow GT4-geometry tires) regardless of whether the chassis
   *  has a PNG sprite loaded. Flip-flopped via the X key during
   *  'playing'. Traffic stays on auto-fallback (sprite when loaded,
   *  X-Ray when not) — extending to NPCs would need an extra dispatch
   *  hop into drawTopCar's xrayToggle which is player-only. */
  xrayBody?: boolean;
  /** Scanlines overlay toggle (H198 OPT row). */
  scanlines?: boolean;
  /** H560: FPS counter toggle (v8.99.123.41). Render hook lands
   *  when the HUD overlay ports the FPS readout. */
  showFPS?: boolean;
  /** H560: camera tilt mode. 0 = top-down (default), 1 = 20° tilt.
   *  Resize / CSS-perspective wiring ports separately; the field
   *  persists so the OPT panel reads it back correctly. */
  cameraTiltMode?: number;
  /** H560: invert pedal direction (top of bar = full press). */
  invertPedals?: boolean;
  /** H560: PC-only — overlays the mobile touch UI on desktop for
   *  visual feedback (pointer-events:none). */
  pcShowMobileControls?: boolean;
  /** H560: PC render-scale ladder (0.5/0.75/1.0/1.25/1.5). */
  pcRenderScale?: number;
  /** Steering sensitivity overrides. The OPT slider edits one
   *  based on the runtime input mode (touch vs pad). */
  touchSteerSens?: number;
  padSteerSens?: number;
  /** Phase 0A bicycle-model toggle (H504). */
  bicycleModel?: boolean;
  /** Phase 0B dynamic-physics sub-toggle (H504). Requires bicycleModel. */
  dynPhysics0B?: boolean;
  /** H560: physics tuning knobs. Defaults applied in
   *  src/physics/tireCoefficients.ts + velocityAlign.ts +
   *  bicycleModel.ts when the field is unset. */
  physMuBase?: number;
  physMomentumCoef?: number;
  physMassMomentum?: number;
  physTopSpeedCap?: number;
  physDriftEnterThresh?: number;
  /** H560: live physics debug HUD toggle. Render hook lands later. */
  physDebugHUD?: boolean;
  [key: string]: number | boolean | undefined;
}

export interface LifeState {
  money: number;
  fuel: number;
  fuelOctane: number;
  day: number;
  month: number;
  dayOfMonth: number;

  playerName: string;
  playerAlias: string;
  portrait: number;
  gender: Gender;
  skinTone: number;
  age: number;

  ownedCars: string[];

  /** Per-car odometer, keyed by car catalog id, value in raw game units
   *  (1 unit = 0.2056m, so miles = raw * 0.0001278 and km = raw * 0.0002056).
   *  Accumulated each frame from |pSpeed| * dt in the game loop. 1:1 with
   *  monolith `carOdometers` global at L8984. */
  carOdometers: Record<string, number>;

  playerJob: string;
  basePay: number;
  payMultiplier: number;
  workRep: number;
  workDaysTotal: number;
  workDaysPresent: number;
  consecutiveAbsences: number;
  lastRaiseDay: number;
  skipStrikes: number;
  _fired: boolean;

  streetRep: number;
  streetRacesTotal: number;
  streetRacesWon: number;
  lastRaceDay: number;

  mechanicVisits: number;
  mechanicDiscount: boolean;
  dispatcherTrust: boolean;
  sceneRegular: boolean;
  neighborhoodDays: number;
  localDeals: boolean;

  health: number;
  fitness: number;
  daysSinceEat: number;
  daysSinceSleep: number;
  ateToday: boolean;
  lastMealTier?: string;
  gymVisitedToday: boolean;
  lastWorkoutLevel: number;
  slotsActiveToday: number;
  foodStock: FoodStock;

  // Vehicle live-condition (active car). Mirrored to carConditions[id] on swap.
  engine: number;
  tires: number;
  carHP: number;
  paint: number;
  welded: boolean;
  supercharged: boolean;
  isManual: boolean;
  rhdOverride: boolean | null;
  faults: unknown[];
  _hiddenFaults?: unknown[];
  _hiddenFaultOdo?: number;
  bodyDamage?: unknown;

  // World position anchors
  homeX: number;
  homeY: number;
  officeX: number;
  officeY: number;

  // Housing + finance
  housingType: string;
  monthlyHousingCost: number;
  mortgageBalance: number;
  mortgageMonthsRemaining: number;
  mortgageRate: number;
  missedPayments: number;
  missedHomePayments?: number;
  missedCarPayments?: number;
  garageSlots: number;
  carLoans: CarLoan[];
  bankLoans: BankLoan[];

  // Pending and inventory
  impoundedCars: string[];
  pendingParts: unknown[];
  ownedParts: unknown[];
  mail: unknown[];
  jerryCans: number;
  carAds: unknown[];
  /** H180: player-placed map markers for newspaper car listings. Empty
   *  until the pin-picker UI ports. Already typed + defaulted so the
   *  minimap/full-map renderers can iterate without null guards. */
  carPins: CarPin[];

  // Day-flow / office UI state
  /** H216: office-job arrival modal. Set when the player parks at
   *  the office (life.job.type === 'OFFICE JOB' arrival); cleared
   *  on completeOfficeDay or CANCEL. */
  officeMenu?: import('@/ui/modals/officeMenu').OfficeMenuState | null;
  officeLeaveEarly: boolean;
  coffeeBuff: number;
  /** H214: current time slot. Advances morning → afternoon → night
   *  on SLEEP/RELAX; day rollover resets to 'morning'. Drives the
   *  RACE-tab night-only gate (H196) + the SLEEP/RELAX UI. */
  timeSlot: 'morning' | 'afternoon' | 'night';
  /** H214: per-slot used latch. Both SLEEP and RELAX mark the
   *  current slot true. Day rollover (H201 extends to clear this)
   *  resets all three to false. */
  slotsUsed: { morning: boolean; afternoon: boolean; night: boolean };
  sessionTimer: number;

  // Misc
  pendingSalary: number;
  /** H544: cumulative gross + cumulative tax withheld this calendar
   *  year. Both fed by [[runFridayPayout]]; reset on year rollover
   *  (port pending — currently grow unbounded). Used by the future
   *  W-2 summary screen at year end. Matches monolith
   *  LIFE.ytdGross / LIFE.ytdTax. */
  ytdGross: number;
  ytdTax: number;
  /** H544: per-day latch — true once the salary accumulator has
   *  added today's gross to pendingSalary. Prevents double-pay if
   *  the player works multiple slots in one day. Cleared on day
   *  rollover alongside the other H201 latches (jobDoneToday,
   *  gymVisitedToday, ateToday). */
  dailyPaid: boolean;
  mechSkill: number;
  calendarLog: CalendarEvent[];
  /** H575: bills receipt popup gate. Flipped true by
   *  fireMonthlyBills when a non-zero bill cycle resolves; the
   *  billsReceipt modal in the home overlay reads it + the
   *  billsReceipt snapshot to render. Dismiss clears both.
   *  Mirrors monolith LIFE.billsDuePrompt at L7825 (renamed
   *  semantically — modular's auto-pay flow means this is more
   *  "receipt acknowledgment" than "due-prompt"; full pay/skip
   *  interactive controls port in a follow-up hop). */
  billsDuePrompt?: boolean;
  /** H575: snapshot of the most recent monthly-bills cycle.
   *  Filled by fireMonthlyBills alongside billsDuePrompt. */
  billsReceipt?: import('@/ui/modals/billsReceipt').BillsReceiptSnapshot | null;

  /** H571: gas station menu modal flag. Set by the H541-era pump
   *  proximity check when the player parks at a pump; cleared by
   *  the LEAVE STATION button. While true, the tabbed FUEL / PAINT
   *  / MECH modal eats every tap (matches monolith convention). */
  fuelMenuOpen?: boolean;
  /** H571: active tab inside the gas station modal. Defaults to
   *  'fuel' on open. */
  stationTab?: import('@/ui/modals/gasStation').StationTab;

  /** H570: repair popup state. Set when the player taps a fault
   *  row in the REPAIRS sub-view; cleared by the popup's CANCEL
   *  or a successful fix. Modal eats every tap while up. Mirrors
   *  monolith LIFE.repairPopup at L42620. */
  repairPopup?: import('@/ui/modals/repairPopup').RepairPopupState | null;

  /** H569: bank loan offer modal state. Set when the player taps
   *  GET BANK LOAN on the BILLS tab; cleared by the modal's own
   *  ACCEPT / CANCEL. Carries amount + term selections; APR /
   *  monthly / approval state are derived each frame by
   *  evaluateBankLoan. Mirrors monolith LIFE.bankLoanOffer at
   *  L50843. */
  bankLoanOffer?: import('@/ui/modals/bankLoanOffer').BankLoanOfferState | null;

  /** H566: month-view offset for the calendar tab. 0 = current month,
   *  -1 = previous, +1 = next. Wraps via modulo when rendering month
   *  names. Mirrors monolith LIFE.calViewMonth at L46338. Persisted
   *  across menu opens so the player's nav state survives a tab
   *  switch. Both the pause-menu CAL tab and the home-overlay
   *  Calendar tab read this. */
  calViewMonth?: number;
  /** H566: cached ◀ ▶ nav-arrow hit rects from the last calendar
   *  paint. The click router uses these to test taps without
   *  re-running layout. Cleared each frame the calendar isn't
   *  visible (so a stray tap below the closed calendar doesn't
   *  hit a stale rect). */
  _calNavRects?: import('@/ui/overlays/calendarBadges').CalNavRects | null;
  newspaperSection: 'cars' | 'homes';
  /** H35: the current page of classifieds, generated on home-overlay
   *  open if empty. Refreshes once per session for now (per-day expiry
   *  + fillNewspaper port still pending). */
  newspaper: NewspaperListing[];
  /** H209: home-purchase realtor visit state. Set by the H183 near-
   *  pin tap when the pin's listing.type === 'house'. Mirrors the
   *  H185 sellerVisit pattern. Phase machine: driving → menu →
   *  (commit or null). Typed as RealtorVisitState so the renderer
   *  reads it without an as-cast. */
  realtorVisit?: import('@/ui/modals/realtor').RealtorVisitState | null;

  /** H185: private-seller visit state. Set by startSellerVisit (port
   *  pending) and the near-pin "VIEW CAR" tap; cleared by the WALK
   *  AWAY button or a successful PURCHASE handoff. Phase machine:
   *  driving → menu → testdrive → menu → (purchase or null).
   *  Typed as the seller module's SellerVisitState so the overlay
   *  renderer can read it without an as-cast at the call site. */
  sellerVisit?: import('@/ui/modals/seller').SellerVisitState | null;

  /** H189: pin-picker modal state. Set when the player taps an
   *  unpinned newspaper row; cleared on PIN IT (after pushing to
   *  carPins) or CANCEL. Overlays the home-overlay newspaper tab
   *  at full opacity — only the picker's own taps fire while it's
   *  open. Mirrors monolith LIFE.pinPicker (L50220). */
  pinPicker?: import('@/ui/modals/pinPicker').PinPickerState | null;

  /** H207: purchase finance modal state. Set when the player taps
   *  PURCHASE on the seller-visit menu (H185); cleared on BACK or
   *  on a committed deal. Carries the listing + pre-computed
   *  finance options (cash/loan/lease) so the modal renders without
   *  re-deriving them per frame. Mirrors monolith LIFE.purchaseMenu
   *  at L49581 / L43479. */
  purchaseMenu?: import('@/ui/modals/purchase').PurchaseMenuState | null;

  /** H220: 1v1 night street-race state. Set on RACE-tab entry
   *  during the night slot (lazy-fill via fillRaceTab). Phase
   *  machine: setup → ready → countdown → racing → result.
   *  Cleared on result-dismiss or forfeit. */
  race?: import('@/sim/race').RaceState | null;

  /** H232: in-app review prompt latch. Set to true the first time
   *  the player wins a race so the Google Play Review API isn't
   *  spammed with subsequent wins. The OS-side throttle handles
   *  the deeper "show vs not show" decision; this is a client-
   *  side don't-ask-twice. */
  _reviewAsked?: boolean;

  /** H195: current job assignment. Set on accept; cleared on
   *  complete / QUIT / fire. Subset of the monolith's LIFE.job shape
   *  — fields ports grow as the per-job pickup/delivery flows port.
   *  H200 grew the type with world-space pickup/delivery coords so
   *  the in-world destination arrow / arrival check can read them. */
  job?: {
    type: string;
    pay: number;
    pickedUp?: boolean;
    fromX?: number;
    fromY?: number;
    toX?: number;
    toY?: number;
  } | null;
  /** H195: end-of-workday latch — true once today's shift was done,
   *  reset on day-rollover. Drives the green "JOB DONE TODAY" line
   *  on the JOBS tab. */
  jobDoneToday?: boolean;
  /** H195: pending job applications for an unemployed player. Filled
   *  by [[H200]] generateJobListings on JOBS-tab open when empty;
   *  cleared on APPLY tap (the picked job becomes playerJob). */
  _jobListings?: { name: string; pay: string; perk?: string }[];
  /** H200: today's available assignments for the JOBS tab's
   *  has-job-not-yet-worked branch. Filled lazily by generateDailyJob
   *  on JOBS-tab open when empty; cleared on ACCEPT (the picked
   *  job becomes life.job) and on day-rollover (TODO when the
   *  rollover hook ports). */
  _availJobs?: { type: string; pay: number; fromX: number; fromY: number; toX: number; toY: number; pickedUp: boolean }[];

  /** H593: today's used-car-lot listings shown on the LOT pause-
   *  menu tab. Filled lazily by generateCarLot on LOT-tab open
   *  when empty; cleared when a row is bought (purchase modal
   *  splices the picked listing). Persists across pause/play
   *  toggles so the lot doesn't reshuffle on every menu open. */
  _carLot?: { id: string; name: string; price: number; cond: number; mileage: number; isNew: boolean }[];

  /** H206: snapshot of the player's personal car taken when ACCEPT
   *  swaps into a job vehicle (PARAMEDIC → ambulance, TOW TRUCK →
   *  tow_truck, etc). Restored on QUIT JOB / delivery completion.
   *  Mirrors monolith LIFE.savedCar at L27584. Field-level snapshot
   *  rather than carConditions[] keying because GameContext doesn't
   *  carry a carConditions map yet — same approach H187 uses for
   *  the test-drive swap. */
  savedCar?: {
    carId: string;
    engine: number;
    tires: number;
    carHP: number;
    paint: number;
    fuel: number;
    faults: unknown[];
  } | null;

  /** H181: notification toast — single message + frame countdown.
   *  showNotif() writes here; tickNotif() decrements each frame;
   *  drawNotif() paints when timer > 0. Toast appears as a yellow-on-
   *  black band ~22% from the top of the HUD canvas during 'playing'.
   *  Monolith stores both as plain LIFE.notif / LIFE.notifTimer
   *  globals (L7834). */
  notif: string;
  notifTimer: number;

  /** H182: home-entry hint flag. Set each frame when the player is
   *  within ~44px of the home pin and no modal is up; tapping the
   *  resulting cyan button opens the home overlay. Monolith stores as
   *  LIFE._homeHint (L42232). Underscore-prefixed to match the
   *  monolith convention for "render-only / not persisted" flags. */
  _homeHint?: boolean;

  /** H184: broken-car state. The fault system flips `broken` true on
   *  a terminal failure (engine seize, tire blowout w/ no spare, etc.);
   *  the HUD then paints a red BREAKDOWN! line plus the orange CALL
   *  TOW button at GH*0.42. `breakdownType` is the optional
   *  failure-specific headline ("ENGINE FAILURE"). `breakdownTimer`
   *  is the "auto-recover" countdown for minor stalls — while >0 the
   *  car is stopped but the tow button is suppressed. `towMenuOpen`
   *  is the tow-pricing modal flag (modal itself not ported yet);
   *  `incomingTow` is the dispatched tow truck (port lives in
   *  render/tow.ts; that side is already wired). Monolith stores
   *  these as plain LIFE.broken / .breakdownType / .breakdownTimer /
   *  .towMenuOpen / .incomingTow globals. */
  broken?: boolean;
  breakdownType?: string;
  breakdownTimer?: number;
  towMenuOpen?: boolean;
  incomingTow?: unknown;

  /** H704: TRAFFIC COP job sim state. Set on job pickup, cleared
   *  on ISSUE TICKET (end-of-shift) or QUIT/fire. Phase machine:
   *  'radar' (scan from parked) → 'chasing' (player accepted
   *  alert) → 'bumped' (player rear-ended target) → null on
   *  ticket issued. Shape mirrors monolith L7885. Typed
   *  `unknown` on LifeState matching the [[incomingTow]] /
   *  [[realtorVisit]] convention; the sim module owns the
   *  richer CopJobState type. */
  copJob?: unknown;

  /** H257: garage-tab scroll offset (pixels). Persists across paint
   *  frames + tab switches so re-entering the GARAGE tab keeps the
   *  player's scroll position. Wheel-input handler in gameLoop
   *  clamps against _garageScrollMax, which drawGarageTab writes
   *  each frame from the total content height. Mirrors monolith's
   *  per-tab _scrollY/_scrollMax pair at L22216-22217 + L48142-48143.
   *  Scoped to the garage tab so it doesn't conflict with the OPT
   *  tab's _menuTabScrollY (a separate scroll subsystem). */
  _garageScrollY?: number;
  _garageScrollMax?: number;
  /** H246: confirmation modal state. Set by destructive pause-menu
   *  actions (RESTART for now; QUIT could share once that becomes
   *  destructive) and consumed by drawConfirmPrompt /
   *  handleConfirmPromptTap. Mirrors monolith LIFE._confirmPrompt at
   *  L21427 + L41943. _confirmYesRect / _confirmNoRect cache the
   *  YES/NO button rects from the last draw so the tap handler can
   *  hit-test without re-running layout. */
  _confirmPrompt?: import('@/ui/modals/confirm').ConfirmPromptState | null;
  _confirmYesRect?: { x: number; y: number; w: number; h: number };
  _confirmNoRect?: { x: number; y: number; w: number; h: number };

  gameplaySettings: GameplaySettings;

  // Migration markers
  _v89_isManualMigrated?: boolean;

  // Other transient runtime flags (rendering, UI, etc.) - not exhaustively typed
  [key: string]: unknown;
}

export interface PlayerPose {
  px: number;
  py: number;
  pAngle: number;
}

/** Factory for a default LifeState. Most fields are zeroed / empty
 *  because the full economy isn't ported yet — they exist on the type
 *  so future H commits can populate them without changing the shape.
 *  Caller applies starting conditions + job + car choice on top of
 *  this. */
export function createDefaultLife(): LifeState {
  return {
    money: 0,
    fuel: 100,
    fuelOctane: 87,
    day: 1,
    month: 1,
    dayOfMonth: 1,

    playerName: '',
    playerAlias: '',
    portrait: 0,
    gender: 'M',
    skinTone: 1,
    age: 25,

    ownedCars: [],
    carOdometers: {},

    playerJob: '',
    basePay: 0,
    payMultiplier: 1.0,
    workRep: 25,
    workDaysTotal: 0,
    workDaysPresent: 0,
    consecutiveAbsences: 0,
    lastRaiseDay: 0,
    skipStrikes: 0,
    _fired: false,

    streetRep: 0,
    streetRacesTotal: 0,
    streetRacesWon: 0,
    lastRaceDay: 0,

    mechanicVisits: 0,
    mechanicDiscount: false,
    dispatcherTrust: false,
    sceneRegular: false,
    neighborhoodDays: 0,
    localDeals: false,

    health: 100,
    fitness: 50,
    daysSinceEat: 0,
    daysSinceSleep: 0,
    ateToday: false,
    gymVisitedToday: false,
    lastWorkoutLevel: 0,
    slotsActiveToday: 0,
    foodStock: { junk: 0, regular: 0, premium: 0 },

    engine: 100,
    tires: 100,
    carHP: 100,
    paint: 100,
    welded: false,
    supercharged: false,
    isManual: false,
    rhdOverride: null,
    faults: [],

    homeX: 1000,
    homeY: 1100,
    officeX: 1200,
    officeY: 1100,

    housingType: 'apt1br',
    monthlyHousingCost: 425,
    mortgageBalance: 0,
    mortgageMonthsRemaining: 0,
    mortgageRate: 0.075,
    missedPayments: 0,
    garageSlots: 1,
    carLoans: [],
    bankLoans: [],

    impoundedCars: [],
    pendingParts: [],
    ownedParts: [],
    mail: [],
    jerryCans: 0,
    carAds: [],
    carPins: [],

    officeMenu: null,
    officeLeaveEarly: false,
    coffeeBuff: 0,
    timeSlot: 'morning',
    slotsUsed: { morning: false, afternoon: false, night: false },
    sessionTimer: 0,

    pendingSalary: 0,
    ytdGross: 0,
    ytdTax: 0,
    dailyPaid: false,
    mechSkill: 15,
    calendarLog: [],
    newspaperSection: 'cars',
    newspaper: [],
    realtorVisit: null,

    notif: '',
    notifTimer: 0,

    // H671: Bicycle Model + Dynamic Physics (0B) ON by default. The
    // OPT panel still exposes both toggles so a player can flip them
    // off (independently — Dynamic Physics requires Bicycle Model
    // ON, enforced in the click router) but the out-of-the-box
    // experience now uses the proper Phase 0B integrator instead of
    // the H6 arcade stop-gap.
    gameplaySettings: {
      bicycleModel: true,
      dynPhysics0B: true,
    },
  };
}
