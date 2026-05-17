/**
 * RACE state machine — 1v1 night street-race lifecycle.
 *
 * Phases (mirrors monolith RACE.phase):
 *   'setup'     — opponent picked, player tunes stake, taps ACCEPT
 *   'ready'     — confirmation modal; map / garage open for prep
 *   'countdown' — 3-2-1-GO! at center
 *   'racing'    — active race; finish-line + opp-position tracked
 *   'result'    — win/loss + payout / pink-slip handover
 *
 * H220 SCOPE: type contract + tier helper + opponent generator +
 * fillRaceTab. The H196 RACE tab placeholder gets replaced with the
 * setup-phase top section (opponent + tier match). Stake selector,
 * bet controls, accept/decline → ready phase, and the actual race
 * tick land in H221+ commits.
 */

import { CAR_CATALOG, ALL_CAR_IDS, type CatalogCar } from '@/config/cars/catalog';
import { HOUSING_TIERS, type HousingTierKey } from '@/config/housing';
import type { LifeState } from '@/state/life';

/** Race power-tier. 1:1 with monolith L7975-7982 (getRaceTier).
 *  Names mirror L34818 (ECONOMY / SPORT COMPACT / SPORT / MUSCLE/GT /
 *  SUPER / LM RACE). */
export const RACE_TIER_NAMES: readonly string[] = [
  'ECONOMY', 'SPORT COMPACT', 'SPORT', 'MUSCLE/GT', 'SUPER', 'LM RACE',
];

/** Map a hp number to its tier index 0..5. 1:1 with monolith
 *  L7975-7982. */
export function getRaceTier(hp: number): 0 | 1 | 2 | 3 | 4 | 5 {
  if (hp <= 140) return 0;
  if (hp <= 200) return 1;
  if (hp <= 280) return 2;
  if (hp <= 400) return 3;
  if (hp <= 550) return 4;
  return 5;
}

/** RACE.stakeType — driven by the 3-tab selector on the setup
 *  screen. CAR / HOUSE only become available when the player owns
 *  an eligible car / paid-off home (gating ports with the stake
 *  selector). */
export type RaceStakeType = 'money' | 'car' | 'house';

export type RacePhase = 'setup' | 'ready' | 'countdown' | 'racing' | 'result';

/** Top-level race state (subset for H220). Fields grow as the
 *  state machine ports phase-by-phase. */
export interface RaceState {
  /** True while a race is in any phase. Cleared on result-dismiss
   *  or forfeit. */
  active: boolean;
  phase: RacePhase;
  /** Catalog id of the opponent car (resolved through CAR_CATALOG). */
  oppId: string;
  /** Cached display name (saves a lookup per frame). */
  oppName: string;
  /** Selected stake type. Defaults 'money' on setup. */
  stakeType: RaceStakeType;
  /** Bet amount in dollars (money stake). */
  betInput: number;
  /** Selected car ID for car-stake races. Defaults to the player's
   *  first eligible car on tab entry; cycled via prev/next buttons
   *  when multiple eligible cars are owned. */
  stakeCarId?: string;
  /** Pink-slip flag for car/house stakes. */
  pinkSlip: boolean;
  /** Finish-line world coords (set when 'ready' starts; lazy-
   *  generated from majorRoads near the player). */
  finishX: number;
  finishY: number;
  /** Start-line world coords (snapshot of player.px/py on countdown
   *  start; drives the progress-bar math on the racing HUD). */
  startX: number;
  startY: number;
  /** Live opponent pose (driven by RACE AI tick; zeroed pre-race). */
  oppX: number;
  oppY: number;
  oppAngle: number;
  /** Countdown integer (3, 2, 1) or 0 → GO! Decremented each
   *  second during 'countdown'. */
  countdown: number;
  /** Winner discriminator — set when phase flips to 'result'. */
  winner: 'player' | 'opponent' | null;
}

/** Vehicle IDs that don't race — job vehicles get filtered out of
 *  the opponent candidate pool. 1:1 with monolith L7990. */
const NON_RACE_IDS = new Set([
  'ambulance',
  'tow_truck',
  'police_cruiser',
  'semi_truck',
  'box_truck',
]);

/** Roll a random opponent within ±1 tier of the player's car. 1:1
 *  port of monolith L7984-8000. Filters out job vehicles + same-
 *  car + bike/car cross-class. Returns null when nothing matches
 *  (extremely rare — the tier-±1 window covers most catalogs). */
export function generateRaceOpponent(
  playerCarId: string,
  catalog: Readonly<Record<string, CatalogCar>> = CAR_CATALOG,
): string | null {
  const playerCar = catalog[playerCarId];
  if (!playerCar) return null;
  const playerTier = getRaceTier(playerCar.hp);
  const candidates: string[] = [];
  for (const id of ALL_CAR_IDS) {
    if (id === playerCarId) continue;
    if (NON_RACE_IDS.has(id)) continue;
    const c = catalog[id];
    if (!c) continue;
    if (c.isBike && !playerCar.isBike) continue;
    if (!c.isBike && playerCar.isBike) continue;
    const t = getRaceTier(c.hp);
    if (Math.abs(t - playerTier) <= 1) candidates.push(id);
  }
  if (candidates.length === 0) return null;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

/** True when the car is owned free + clear (no active loan/lease).
 *  Drives stake-CAR eligibility — a financed car can't be wagered.
 *  1:1 with monolith L45676-45679. */
export function isCarOwnedOutright(life: LifeState, carId: string): boolean {
  return !life.carLoans.some((l) => l.carId === carId);
}

/** Owned cars eligible for stake. 1:1 with monolith L45701-45703. */
export function getEligibleStakeCars(life: LifeState): string[] {
  return life.ownedCars.filter((id) => isCarOwnedOutright(life, id));
}

/** True when the home is owned (not a rental) AND the mortgage is
 *  paid off. Rentals have tier.price === 0 in HOUSING_TIERS so the
 *  price > 0 check filters them out cleanly. 1:1 with monolith
 *  L45685-45689. */
export function isHomeOwnedOutright(life: LifeState): boolean {
  const tier = HOUSING_TIERS[life.housingType as HousingTierKey];
  if (!tier || !tier.price || tier.price <= 0) return false;
  return (life.mortgageBalance || 0) <= 0;
}

/** Equity in the home, capped at zero. Drives stake-HOUSE
 *  eligibility (returning >0 means the player has something to
 *  wager). 1:1 with monolith L45704-45708. */
export function getHouseStakeValue(life: LifeState): number {
  if (!isHomeOwnedOutright(life)) return 0;
  const tier = HOUSING_TIERS[life.housingType as HousingTierKey];
  return Math.max(0, (tier.price || 0) - (life.mortgageBalance || 0));
}

/** Bet step in $. 1:1 with monolith implicit increments — the bet
 *  ± buttons move by $10. */
export const RACE_BET_STEP = 10;

/** Minimum bet allowed by the START RACE button. 1:1 with
 *  monolith L34909. */
export const RACE_BET_MIN = 10;

/** Used-car resale value estimator. Active car uses live LIFE
 *  condition stats (engine/tires/carHP/paint weighted); other
 *  owned cars assume 70%. Both pass through a mileage-based
 *  depreciation factor (floor 20%). 1:1 port of monolith
 *  L43661-43675. */
export function getCarValue(
  life: LifeState,
  carId: string,
  activeCarId: string | null,
): number {
  const c = CAR_CATALOG[carId];
  if (!c) return 0;
  const base = c.price;
  let condMult = 0.7;
  if (carId === activeCarId) {
    const eng = life.engine / 100;
    const tir = life.tires / 100;
    const bod = life.carHP / 100;
    const pnt = life.paint / 100;
    condMult = eng * 0.3 + tir * 0.15 + bod * 0.3 + pnt * 0.25;
  }
  const odoMi = (life.carOdometers?.[carId] ?? 0) * 0.0001278;
  const mileMult = Math.max(0.2, 1 - odoMi / 200000);
  return Math.round(base * condMult * mileMult);
}

/** Auto-snap stakeType to 'money' when the current selection has
 *  become ineligible (e.g. player sold their last outright car
 *  while the CAR stake was selected). Caller wraps the paint pass
 *  with this so the UI never paints a dead-end state. 1:1 with
 *  monolith L34853-34855. */
export function normalizeStakeType(life: LifeState): void {
  const r = life.race;
  if (!r) return;
  if (r.stakeType === 'car' && getEligibleStakeCars(life).length === 0) {
    r.stakeType = 'money';
  }
  if (r.stakeType === 'house' && getHouseStakeValue(life) <= 0) {
    r.stakeType = 'money';
  }
}

/** Build a fresh RaceState in 'setup' phase. Caller writes it to
 *  life.race. Called lazily on RACE-tab entry when the player's
 *  in the night slot and no race is active. */
export function newRaceSetup(playerCarId: string): RaceState | null {
  const oppId = generateRaceOpponent(playerCarId);
  if (!oppId) return null;
  const oppCar = CAR_CATALOG[oppId];
  return {
    active: true,
    phase: 'setup',
    oppId,
    oppName: oppCar?.name ?? oppId,
    stakeType: 'money',
    betInput: 50, // sensible default — gets tuned by the bet ± buttons in H222
    pinkSlip: false,
    finishX: 0,
    finishY: 0,
    startX: 0,
    startY: 0,
    oppX: 0,
    oppY: 0,
    oppAngle: 0,
    countdown: 0,
    winner: null,
  };
}
