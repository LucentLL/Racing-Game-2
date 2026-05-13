/**
 * LifeState — the player's persistent "life sim" state. Type definition for
 * the runtime LIFE object. The singleton is built in Phase G integration;
 * this file is the type contract that save/load and the sim modules code
 * against.
 *
 * Fields are intentionally permissive (mostly optional) so the type can grow
 * incrementally as more subsystems are extracted from the monolith.
 */

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
