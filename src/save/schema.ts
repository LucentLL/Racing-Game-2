import type { CarConditionData } from './carCondition';
import type { FoodStock, Gender, CarLoan, BankLoan, CalendarEvent, GameplaySettings } from '@/state/life';

export const SAVE_KEY = 'driverCitySave';
export const SAVE_VERSION = '9.0.0';

/**
 * Schema of the JSON blob written to localStorage.driverCitySave.
 *
 * All fields are optional because loadGame reads with `if (d.x !== undefined)`
 * guards — missing fields fall back to the LIFE defaults seeded at game start.
 *
 * Some fields are DEPRECATED but preserved for back-compat with pre-v9 saves:
 *   - `portrait`: superseded by gender + skinTone (v8.99.122.46)
 *   - `meals`:    superseded by foodStock (legacy migration in loadGame)
 *   - `skipStrikes`: superseded by workRep (legacy migration in loadGame)
 */
export interface SaveDataV1 {
  // === Core economy / clock ===
  money?: number;
  fuel?: number;
  fuelOctane?: number;
  day?: number;
  month?: number;
  dayOfMonth?: number;

  // === Player identity ===
  playerName?: string;
  playerAlias?: string;
  /** DEPRECATED v8.99.122.46. Use gender + skinTone. */
  portrait?: number;
  gender?: Gender;
  skinTone?: number;
  age?: number;

  // === Garage ===
  activeCar?: string;
  ownedCars?: string[];
  carOdometers?: Record<string, number>;
  carConditions?: Record<string, CarConditionData>;
  /** H875/H879: per-car upgrade stages (0-4) by category. */
  carUpgrades?: Record<string, { power: number; weight: number; brakes?: number; suspension?: number }>;
  /** Active car's live condition snapshot — also persisted via carConditions. */
  engine?: number;
  tires?: number;
  carHP?: number;
  paint?: number;
  faults?: unknown[];

  // === Health / fitness ===
  health?: number;
  fitness?: number;
  daysSinceEat?: number;
  daysSinceSleep?: number;
  ateToday?: boolean;
  lastMealTier?: string;
  gymVisitedToday?: boolean;
  lastWorkoutLevel?: number;
  slotsActiveToday?: number;
  foodStock?: FoodStock;
  /** DEPRECATED legacy field. Replaced by foodStock; loadGame migrates. */
  meals?: number;

  // === Work / pay / rep ===
  playerJob?: string;
  basePay?: number;
  payMultiplier?: number;
  workRep?: number;
  workDaysTotal?: number;
  workDaysPresent?: number;
  consecutiveAbsences?: number;
  lastRaiseDay?: number;
  /** DEPRECATED legacy field. Replaced by workRep; loadGame migrates. */
  skipStrikes?: number;
  _fired?: boolean;

  // === Street racing ===
  streetRep?: number;
  streetRacesTotal?: number;
  streetRacesWon?: number;
  lastRaceDay?: number;

  // === Connections ===
  mechanicVisits?: number;
  mechanicDiscount?: boolean;
  dispatcherTrust?: boolean;
  sceneRegular?: boolean;
  neighborhoodDays?: number;
  localDeals?: boolean;

  // === World anchors ===
  homeX?: number;
  homeY?: number;
  officeX?: number;
  officeY?: number;

  // === Inventory / pending ===
  impoundedCars?: string[];
  pendingParts?: unknown[];
  ownedParts?: unknown[];
  mail?: unknown[];
  jerryCans?: number;
  carAds?: unknown[];

  // === Day-flow / office UI state (persisted so mid-flow save/load is safe) ===
  officeMenu?: unknown;
  officeLeaveEarly?: boolean;
  coffeeBuff?: number;

  // === Player pose (world position) ===
  px?: number;
  py?: number;
  pAngle?: number;

  // === Housing / finance ===
  housingType?: string;
  monthlyHousingCost?: number;
  mortgageBalance?: number;
  mortgageMonthsRemaining?: number;
  missedPayments?: number;
  garageSlots?: number;
  carLoans?: CarLoan[];
  bankLoans?: BankLoan[];

  // === Time-slot bookkeeping ===
  timeSlot?: unknown;
  slotsUsed?: unknown;
  sessionTimer?: number;

  // === Weekly pay / mech skill / calendar ===
  pendingSalary?: number;
  /** H544: cumulative gross + tax this calendar year. */
  ytdGross?: number;
  ytdTax?: number;
  /** H544: per-day "salary accumulated today" latch. */
  dailyPaid?: boolean;
  mechSkill?: number;
  calendarLog?: CalendarEvent[];
  newspaperSection?: 'cars' | 'homes';

  gameplaySettings?: GameplaySettings;
}
