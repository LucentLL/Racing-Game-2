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

    gameplaySettings: {},
  };
}
