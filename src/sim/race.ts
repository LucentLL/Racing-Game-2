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
import { requestInAppReview } from '@/platform/mobile';
import {
  getStreetTier,
  STREET_TIER_WIN_REP_GAIN,
  STREET_TIER_LOSS_REP_GAIN,
} from '@/sim/streetTier';
import { gameUnitsToMiles } from '@/physics/physicsUnits';

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
  /** Opponent forward speed (wpx/s). Ramps from 0 to oppTopSpeed
   *  via oppAccel during 'racing' phase. */
  oppSpeed: number;
  /** Opponent's top speed (from catalog). Drives the speed cap. */
  oppTopSpeed: number;
  /** Opponent's acceleration (wpx/s²). Derived from car hp. */
  oppAccel: number;
  /** Straight-line race distance in tiles. Cached at phase='ready'
   *  so the HUD distance bar has a stable scale. */
  raceDistance: number;
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

/** Tile-coord shape the finish-line picker walks. Decoupled from
 *  src/render/worldMap.ts so this sim module stays test-friendly.
 *  The same RenderEntry data feeds the minimap + full-map; the
 *  isMajor flag lives at `row[1]` (1 = highway / arterial). */
export interface RaceFinishCandidate {
  /** Tile-coord polyline points: [x0, y0, x1, y1, ...]. */
  pts: number[];
  /** True when this is a major road (highway/arterial). */
  isMajor: boolean;
}

/** Picks a random highway point 80..250 tiles from the player
 *  position. Returns world-pixel coords. 1:1 port of monolith
 *  L8002-8022. Falls back to the highway midpoint when 200
 *  attempts can't find a tile in the range (very unlikely). */
export function generateRaceFinish(
  playerWorldX: number,
  playerWorldY: number,
  tilePx: number,
  candidates: readonly RaceFinishCandidate[],
): { x: number; y: number } {
  const highways = candidates.filter((r) => r.isMajor && r.pts.length >= 8);
  if (highways.length === 0) {
    return { x: playerWorldX + tilePx * 100, y: playerWorldY };
  }
  const ptx = playerWorldX / tilePx;
  const pty = playerWorldY / tilePx;
  for (let tries = 0; tries < 200; tries++) {
    const road = highways[Math.floor(Math.random() * highways.length)];
    const ptCount = road.pts.length / 2;
    const si = Math.floor(Math.random() * (ptCount - 1));
    const t = Math.random();
    const x0 = road.pts[si * 2];
    const y0 = road.pts[si * 2 + 1];
    const x1 = road.pts[(si + 1) * 2];
    const y1 = road.pts[(si + 1) * 2 + 1];
    const fx = x0 * (1 - t) + x1 * t;
    const fy = y0 * (1 - t) + y1 * t;
    const dx = fx - ptx;
    const dy = fy - pty;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist >= 80 && dist <= 250) {
      return { x: fx * tilePx + tilePx / 2, y: fy * tilePx + tilePx / 2 };
    }
  }
  // Fallback — any highway midpoint.
  const road = highways[Math.floor(Math.random() * highways.length)];
  const mi = Math.floor(road.pts.length / 4) * 2; // mid pair (snap to even idx)
  return {
    x: road.pts[mi] * tilePx + tilePx / 2,
    y: road.pts[mi + 1] * tilePx + tilePx / 2,
  };
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
  const odoMi = gameUnitsToMiles(life.carOdometers?.[carId] ?? 0);
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

/** Finishline radius (world-px²). 5 tiles. */
const RACE_FINISH_R2 = (18 * 5) * (18 * 5);

/** Apply race result side effects — payout / pink-slip handover /
 *  streetRep adjustment / race-day stamp. 1:1 simplified port of
 *  monolith L8522-8615.
 *
 *  Player win:
 *    money:    money += bet
 *    house:    money += house equity (opponent matches collateral)
 *    car:      adds oppId to ownedCars with mid-grade condition
 *  Player loss:
 *    money:    money -= bet (clamp 0)
 *    house:    downgrade to apt1br, clear mortgage
 *    car:      splice staked car from ownedCars; if it was the
 *              active car, rotate to next or fall back to oppId
 *  Both:
 *    streetRacesTotal++, lastRaceDay = day
 *    win → streetRacesWon++, streetRep += 4 (mid-tier value)
 *    loss → streetRep += 1 (showed up)
 *
 *  DEFERRED from monolith: carConditions Record (we use
 *  the H187 snapshot pattern; won car condition writes inline to
 *  life.engine/etc only when it becomes the active car), pending-
 *  parts cleanup on lost car (cancelPendingForCar — pending-parts
 *  system not ported), calendar event-log writes. */
export function applyRaceResult(
  life: LifeState,
  day: number,
): { prize: number; lostCarName: string | null; wonCarName: string | null } {
  const race = life.race;
  if (!race || !race.winner) {
    return { prize: 0, lostCarName: null, wonCarName: null };
  }
  life.streetRacesTotal = (life.streetRacesTotal || 0) + 1;
  life.lastRaceDay = day;

  if (race.winner === 'player') {
    life.streetRacesWon = (life.streetRacesWon || 0) + 1;
    // H513: tier-gated rep gain. OPEN tier wins fast (+6/win),
    // INNER CIRCLE wins barely move the meter (+2). Mirrors monolith
    // L8525 `tier.idx>=2 ? 2 : (tier.idx===1 ? 4 : 6)`. Replaces the
    // flat +4 placeholder; the "DEFERRED tier-gated repGain" note in
    // the docstring above is closed by this hop.
    const tier = getStreetTier(life);
    const repGain = STREET_TIER_WIN_REP_GAIN[tier.idx];
    life.streetRep = Math.min(100, (life.streetRep || 0) + repGain);

    // H232: ask for an in-app store review on the player's FIRST
    // race win. Positive-moment timing matches Play Store best
    // practice (request after a success, never near a paywall
    // or failure). The _reviewAsked latch keeps subsequent wins
    // silent; the OS-side throttle decides whether the dialog
    // actually shows. No-op on web / Tauri / Capacitor builds
    // without the in-app-review plugin installed.
    if (!life._reviewAsked && life.streetRacesWon === 1) {
      life._reviewAsked = true;
      requestInAppReview();
    }

    if (race.stakeType === 'house') {
      const prize = getHouseStakeValue(life);
      life.money += prize;
      return { prize, lostCarName: null, wonCarName: null };
    }
    if (race.stakeType === 'car') {
      const won = race.oppId;
      if (!life.ownedCars.includes(won)) life.ownedCars.push(won);
      return { prize: 0, lostCarName: null, wonCarName: race.oppName };
    }
    life.money += race.betInput;
    return { prize: race.betInput, lostCarName: null, wonCarName: null };
  }

  // Player lost — flat showed-up rep bump (no tier scaling on
  // losses; matches monolith).
  life.streetRep = Math.min(100, (life.streetRep || 0) + STREET_TIER_LOSS_REP_GAIN);

  if (race.stakeType === 'house') {
    life.housingType = 'apt1br';
    life.mortgageBalance = 0;
    life.mortgageMonthsRemaining = 0;
    const apt = HOUSING_TIERS.apt1br;
    life.monthlyHousingCost = apt.rent ?? 0;
    return { prize: 0, lostCarName: null, wonCarName: null };
  }
  if (race.stakeType === 'car') {
    const lostId = race.stakeCarId ?? life.ownedCars[0];
    if (!lostId) return { prize: 0, lostCarName: null, wonCarName: null };
    const lostCar = CAR_CATALOG[lostId];
    const lostName = lostCar?.name ?? lostId;
    const wasActive = life.ownedCars[0] === lostId;
    life.ownedCars = life.ownedCars.filter((id) => id !== lostId);
    if (life.ownedCars.length === 0) {
      // Edge case: lost only car. Player gets the opponent's car
      // as compensation (matches monolith's L8598 fallback).
      life.ownedCars.push(race.oppId);
    }
    if (wasActive) {
      // First remaining slot becomes active. Reset condition to
      // fresh values since carConditions isn't ported — caller
      // can layer the H187 snapshot pattern later.
      life.engine = 70;
      life.tires = 70;
      life.carHP = 70;
      life.paint = 70;
      life.fuel = 50;
      life.faults = [];
    }
    return { prize: 0, lostCarName: lostName, wonCarName: null };
  }
  life.money = Math.max(0, life.money - race.betInput);
  return { prize: race.betInput, lostCarName: null, wonCarName: null };
}

/** Per-frame race tick. Owns the countdown decrement + the racing-
 *  phase opponent AI + finishline check. Returns a notification
 *  string when the caller should surface a toast ('3…', '2…', '1…',
 *  'GO!', 'YOU WIN!', 'OPPONENT WINS'), or null when nothing
 *  changed this frame.
 *
 *  Player position is threaded through so the finishline check
 *  can fire on player-arrival; opponent AI runs from the race
 *  state's own oppX/Y. */
export function tickRace(
  race: RaceState,
  dt: number,
  playerX: number,
  playerY: number,
  mapWPx: number,
  mapHPx: number,
): string | null {
  // ---- COUNTDOWN ----
  if (race.phase === 'countdown') {
    const prev = Math.ceil(race.countdown);
    race.countdown -= dt;
    const next = Math.ceil(race.countdown);
    if (race.countdown <= 0) {
      race.phase = 'racing';
      race.countdown = 0;
      return 'GO!';
    }
    if (next !== prev && next > 0) {
      return next + '…';
    }
    return null;
  }

  // ---- RACING ----
  if (race.phase === 'racing') {
    // Steer toward finishline. Lerp oppAngle toward atan2 of
    // (finishY - oppY, finishX - oppX) at 1.5 rad/s. 1:1 with
    // monolith L8463-8474 simplified path (no avoid-target /
    // stuck-detect for H225).
    const fdx = race.finishX - race.oppX;
    const fdy = race.finishY - race.oppY;
    const targetAng = Math.atan2(fdy, fdx);
    let ad = targetAng - race.oppAngle;
    while (ad > Math.PI) ad -= Math.PI * 2;
    while (ad < -Math.PI) ad += Math.PI * 2;
    race.oppAngle += ad * dt * 1.5;
    // Accelerate up to top speed.
    race.oppSpeed = Math.min(race.oppTopSpeed, race.oppSpeed + race.oppAccel * dt);
    // Move.
    race.oppX += Math.cos(race.oppAngle) * race.oppSpeed * dt;
    race.oppY += Math.sin(race.oppAngle) * race.oppSpeed * dt;
    // Clamp to map bounds. 1:1 with monolith L8481.
    race.oppX = Math.max(18, Math.min(mapWPx - 18, race.oppX));
    race.oppY = Math.max(18, Math.min(mapHPx - 18, race.oppY));

    // Finishline check — 5-tile radius from either side. Player
    // wins on tie via the player-first check ordering.
    const pdx = playerX - race.finishX;
    const pdy = playerY - race.finishY;
    if (pdx * pdx + pdy * pdy < RACE_FINISH_R2) {
      race.winner = 'player';
      race.phase = 'result';
      return 'YOU WIN!';
    }
    const odx = race.oppX - race.finishX;
    const ody = race.oppY - race.finishY;
    if (odx * odx + ody * ody < RACE_FINISH_R2) {
      race.winner = 'opponent';
      race.phase = 'result';
      return 'OPPONENT WINS';
    }
    return null;
  }

  return null;
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
    oppSpeed: 0,
    oppTopSpeed: oppCar?.topSpeed ?? 50,
    // Arcade-style accel: top speed in ~4 seconds. Simpler than
    // the monolith's `power * 0.85` since modular CatalogCar's
    // hp/power split isn't 1:1 with the monolith.
    oppAccel: (oppCar?.topSpeed ?? 50) / 4,
    raceDistance: 0,
    countdown: 0,
    winner: null,
  };
}
