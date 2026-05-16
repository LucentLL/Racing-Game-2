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
  month: number;
  dom: number;
  type: string;
  slot: string;
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
  officeMenu: unknown;
  officeLeaveEarly: boolean;
  coffeeBuff: number;
  timeSlot: unknown;
  slotsUsed: unknown;
  sessionTimer: number;

  // Misc
  pendingSalary: number;
  mechSkill: number;
  calendarLog: CalendarEvent[];
  newspaperSection: 'cars' | 'homes';
  /** H35: the current page of classifieds, generated on home-overlay
   *  open if empty. Refreshes once per session for now (per-day expiry
   *  + fillNewspaper port still pending). */
  newspaper: NewspaperListing[];
  realtorVisit: unknown;

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
    timeSlot: null,
    slotsUsed: null,
    sessionTimer: 0,

    pendingSalary: 0,
    mechSkill: 15,
    calendarLog: [],
    newspaperSection: 'cars',
    newspaper: [],
    realtorVisit: null,

    notif: '',
    notifTimer: 0,

    gameplaySettings: {},
  };
}
