/**
 * Seller-visit test-drive transitions + tick.
 *
 * Activates the H186 testdrive HUD by flipping life.sellerVisit.phase
 * from 'menu' → 'testdrive' for 45 seconds. While the timer is alive
 * the player drives the LISTED car (swapped into ownedCars[0]) with
 * the listing's condition values; on expiry — or on an early tap on
 * the top-bar — the original car is restored and any testDriveOnly
 * faults the roll happens to surface become `detected`, refreshing
 * the H185 menu's KNOWN ISSUES section on the next paint.
 *
 * Ported from monolith L49684-L49770 (startTestDrive /
 * updateTestDrive / endTestDrive). Sub-system status:
 *   - H514 wired the L49716-L49730 mid-drive symptom stream — every
 *     3s during the drive, 25% chance to surface a hidden fault's
 *     FAULT_EFFECTS.desc as a `⚠ <hint>` notif. Gated on
 *     |pSpeed| > 5 so symptoms only fire while the player is
 *     actually driving.
 *   - The L49764 faultPriceDiscount re-application on found-faults
 *     is already wired in endTestDrive (H190) — both halves of the
 *     drive-end pipeline run as expected.
 *
 * The car-swap operates on ownedCars[0] in place. During the drive
 * the listed car is technically "in" the player's owned-cars array;
 * endTestDrive restores the original. This matches the monolith's
 * `activeCar = L.id` mutation pattern (the monolith's CAR_IDS array
 * gain is a no-op on our side because CAR_CATALOG is a static map,
 * not a runtime registry).
 */

import type { LifeState } from '@/state/life';
import type { PlayerState } from '@/state/player';
import type { SellerVisitState } from '@/ui/modals/seller';
import type { PreFault } from '@/ui/modals/inspection';
import { faultPriceDiscount } from '@/sim/usedCarFaults';
import { FAULT_EFFECTS } from '@/sim/faultEffects';
import { makeFreshBodyDamage, type BodyDamage, type DamageZone } from '@/sim/faults';
import { TILE, WPX_PER_M } from '@/config/world/tiles';
import { milesToGameUnits } from '@/physics/physicsUnits';

/**
 * H1265: a test drive ends when you have DRIVEN it and brought it BACK.
 *
 * It used to be a 45-second stopwatch that started the moment you took the
 * keys, which meant it could expire while you were parked reading the menu —
 * the user's "the test drive only lasted about twenty seconds and expired
 * while I was typing this and I didn't drive anywhere". A stopwatch measures
 * the wrong thing: what makes a test drive over is that you have formed an
 * opinion and returned the car, not that time passed.
 *
 * So: drive at least TEST_DRIVE_MIN_M, then come back within
 * TEST_DRIVE_RETURN_TILES of where you met the seller and it wraps up on its
 * own. Tapping the HUD bar still ends it anywhere, any time. The timeout
 * remains only as a runaway backstop, and it is long enough that nobody
 * driving normally will ever meet it.
 */
export const TEST_DRIVE_DURATION_SEC = 600;
/** Metres you must cover before the seller considers it a real test drive. */
export const TEST_DRIVE_MIN_M = 400;
/** How close to the meeting point counts as "brought it back", in tiles. */
export const TEST_DRIVE_RETURN_TILES = 5;

// --- H1264: asking for the keys, and answering for the car -----------------

/** Base chance the seller says no. They do not know you. */
const TD_REFUSE_BASE = 0.22;
/** Extra refusal on an expensive car — nobody hands a stranger the keys to
 *  something they cannot replace. Scales to the cap at TD_PRICEY. */
const TD_REFUSE_PRICEY = 0.23;
const TD_PRICEY = 60000;

/** Damage weights per zone axis. Structural is what actually costs money;
 *  cosmetic is paint and plastic. */
const DMG_W_COSMETIC = 0.25;
const DMG_W_FUNCTIONAL = 1.0;
const DMG_W_STRUCTURAL = 2.2;
/** Below this total weighted score the seller waves it off — a scuffed kerb
 *  on a used car is not a bill. */
const DMG_IGNORE_SCORE = 14;
/** Repair cost as a fraction of the car's ASKING price per unit of weighted
 *  damage score, and the ceiling as a fraction of that price. */
const DMG_COST_PER_POINT = 0.0016;
const DMG_COST_CAP_FRAC = 0.65;

const ALL_ZONES: readonly DamageZone[] = [
  'headlightL', 'headlightR', 'frontBumper',
  'taillightL', 'taillightR', 'rearBumper',
  'fenderFL', 'fenderFR', 'hood',
  'quarterRL', 'quarterRR', 'trunk',
  'doorL', 'doorR',
];

/** Total weighted damage across every zone of a body-damage record. */
export function bodyDamageScore(dmg: BodyDamage | null | undefined): number {
  if (!dmg) return 0;
  let s = 0;
  for (const z of ALL_ZONES) {
    const zd = dmg[z];
    if (!zd) continue;
    s += zd.cosmetic * DMG_W_COSMETIC
      + zd.functional * DMG_W_FUNCTIONAL
      + zd.structural * DMG_W_STRUCTURAL;
  }
  return s;
}

/** What the seller bills for the damage you did. Pure — exported for
 *  headless verification. */
export function testDriveRepairBill(score: number, askingPrice: number): number {
  if (score <= DMG_IGNORE_SCORE) return 0;
  const raw = askingPrice * DMG_COST_PER_POINT * (score - DMG_IGNORE_SCORE);
  return Math.max(1, Math.round(Math.min(raw, askingPrice * DMG_COST_CAP_FRAC)));
}

/** Whether the seller hands over the keys. Pure — exported for verification.
 *  `roll` is injected so the decision is testable. */
export function sellerAllowsTestDrive(askingPrice: number, roll: number): boolean {
  const pricey = Math.max(0, Math.min(1, askingPrice / TD_PRICEY));
  return roll >= TD_REFUSE_BASE + TD_REFUSE_PRICEY * pricey;
}

/** Snapshot taken on test-drive start. Restored on end. Mirrors
 *  monolith L49690-49692 (`sv.tdSavedCar = {...}`) + the implicit
 *  per-field state monolith carries on LIFE.engine/tires/etc. */
export interface TdSavedCar {
  carId: string;
  px: number;
  py: number;
  pAngle: number;
  engine: number;
  tires: number;
  carHP: number;
  paint: number;
  fuel: number;
  faults: unknown[];
  /** H1264: the player's own dents. This was NOT saved before, so a test drive
   *  ran on the player's body damage and any panel you creased in the seller's
   *  car stayed creased on YOURS after the drive ended. Saved and restored now,
   *  and the test car starts fresh — the listing isn't dented because you are. */
  bodyDamage: BodyDamage | null;
  /** H1288: the PLAYER car's mileage-reveal state, parked for the drive.
   *  The wear tick hands the ACTIVE car's odometer to tickHiddenFaultReveal,
   *  and during a test drive that is the LISTING car's (now seeded from its
   *  advertised mileage) — against the player-car baseline that delta is
   *  huge, which would instantly "reveal" one of the PLAYER's hidden faults
   *  onto the test car's fault list, where the end-of-drive restore discards
   *  it (the fault silently vanishes). Parked + restored instead. */
  hiddenFaults: unknown[];
  hiddenFaultOdo: number;
}

/** Begin the test drive. Swaps the player's active car for the
 *  listing's, overwrites condition stats with listing.cond, seeds a
 *  fresh fault list from sv.preFaults, sets phase + timer. 1:1 port
 *  of monolith L49684-49708. */
export function startTestDrive(
  life: LifeState,
  sv: SellerVisitState,
  player: PlayerState,
  showNotif: (msg: string) => void,
): void {
  const prevCarId = life.ownedCars[0];
  if (!prevCarId) return;
  const L = sv.listing;

  // H1264: the seller gets a say. Decided ONCE per visit and remembered —
  // re-tapping the button must not re-roll until they say yes, or a refusal
  // would just be a button you press twice.
  if (sv._tdVerdict === undefined) {
    sv._tdVerdict = sellerAllowsTestDrive(L.price, Math.random());
  }
  if (!sv._tdVerdict) {
    showNotif('Seller: "Sorry — not without a deposit."');
    return;
  }

  sv.tdSavedCar = {
    carId: prevCarId,
    px: player.px,
    py: player.py,
    pAngle: player.pAngle,
    engine: life.engine,
    tires: life.tires,
    carHP: life.carHP,
    paint: life.paint,
    fuel: life.fuel,
    faults: JSON.parse(JSON.stringify(life.faults ?? [])) as unknown[],
    bodyDamage: life.bodyDamage
      ? JSON.parse(JSON.stringify(life.bodyDamage)) as BodyDamage
      : null,
    hiddenFaults: life._hiddenFaults ?? [],
    hiddenFaultOdo: life._hiddenFaultOdo ?? 0,
  } satisfies TdSavedCar;
  // The seller's car is not carrying your dents. Starting fresh also makes the
  // end-of-drive score a clean measure of what YOU did to it.
  life.bodyDamage = makeFreshBodyDamage();

  // Swap ownedCars[0] in place — matches monolith's `activeCar = L.id`.
  life.ownedCars[0] = L.id;
  // H1288: seed the listing car's odometer from its advertised mileage
  // (same "new to ownership" guard as completePurchase) so the gauge
  // reads true DURING the drive and the post-drive purchase keeps the
  // advertised base. Before this, the drive accrued a few units on a
  // zero odometer, which tripped completePurchase's <100-unit guard and
  // the car delivered with a test-drive-length odometer instead of the
  // advertised mileage.
  const odos = life.carOdometers ?? (life.carOdometers = {});
  if ((L.mileage ?? 0) > 0 && (!odos[L.id] || odos[L.id] < 100)) {
    odos[L.id] = Math.round(milesToGameUnits(L.mileage));
  }
  // Park the player car's mileage-reveal state (see TdSavedCar.hiddenFaults)
  // and re-baseline to the test car's odometer — no mileage reveals belong
  // to a test drive; the listing's issues surface via the symptom stream +
  // end-of-drive roll instead.
  life._hiddenFaults = [];
  life._hiddenFaultOdo = odos[L.id] ?? 0;
  life.engine = L.cond;
  life.tires = L.cond;
  life.carHP = L.cond;
  life.paint = L.isNew ? 100 : L.cond;
  life.fuel = 80;
  // Seed faults from preFaults so the player feels detected + hidden
  // issues during the drive. Deep-copy so mutating per-frame fault
  // state doesn't leak back into sv.preFaults.
  life.faults = sv.preFaults.map((f) => ({ ...f }));

  sv.phase = 'testdrive';
  sv.testDriveTimer = TEST_DRIVE_DURATION_SEC;
  sv.tdDistanceM = 0;
  sv.tdLeftMeet = false;
  player.pSpeed = 0;
  // H508: drop the Phase 0B integrator state so the test-drive
  // car doesn't inherit the previous car's pVx/pVy/pYawRate/etc.
  // See switchCar (H507) for the broader rationale; this is the
  // same fix at the test-drive entry point.
  player.phase0B = undefined;
  showNotif('Test drive — drive it, then bring it back here.');
}

/** End the test drive (called by tap-to-end OR timer-expiry). Restores
 *  the player's original car + position, rolls testDriveOnly faults
 *  for end-of-drive detection, surfaces a result notif. 1:1 port of
 *  monolith L49737-49770 minus the L49764 faultPriceDiscount call
 *  (table not ported; sv.haggled still gets reset so the player can
 *  re-haggle once that lands). */
export function endTestDrive(
  life: LifeState,
  sv: SellerVisitState,
  player: PlayerState,
  showNotif: (msg: string) => void,
): void {
  const saved = sv.tdSavedCar as TdSavedCar | null;
  if (!saved) return;

  // H1264: what you did to the seller's car, measured before the swap back.
  const dmgScore = bodyDamageScore(life.bodyDamage as BodyDamage | null);
  const bill = testDriveRepairBill(dmgScore, sv.listing.price);

  life.ownedCars[0] = saved.carId;
  life.engine = saved.engine;
  life.tires = saved.tires;
  life.carHP = saved.carHP;
  life.paint = saved.paint;
  life.fuel = saved.fuel;
  life.faults = saved.faults;
  life.bodyDamage = saved.bodyDamage;
  // H1288: un-park the player car's mileage-reveal state (see startTestDrive).
  life._hiddenFaults = saved.hiddenFaults;
  life._hiddenFaultOdo = saved.hiddenFaultOdo;
  player.px = saved.px;
  player.py = saved.py;
  player.pAngle = saved.pAngle;
  player.pSpeed = 0;
  // H508: drop the Phase 0B integrator state on test-drive exit
  // for the same reason as the test-drive entry — the original car
  // is back, position teleported, integrator pVx/pVy and rear-axle
  // tracking would otherwise carry the test car's mid-motion state
  // into the restored car.
  player.phase0B = undefined;

  sv.phase = 'menu';
  sv.tdSavedCar = null;
  sv._testDriven = true;

  // End-of-drive testDriveOnly fault reveal. Each undetected
  // testDriveOnly fault gets one Math.random() roll against
  // detectChance (default 0.4 — monolith L49759).
  let found = 0;
  for (const f of sv.preFaults as PreFault[]) {
    if (!f.detected && f.testDriveOnly && Math.random() < (f.detectChance ?? 0.4)) {
      f.detected = true;
      found++;
    }
  }
  if (found > 0) {
    // H190: re-derive hagglePrice from the new detected-fault set,
    // and reset haggled so the player can re-haggle with the
    // updated info. 1:1 with monolith L49764-49766.
    const disc = faultPriceDiscount(sv.preFaults);
    sv.hagglePrice = Math.round(sv.listing.price * disc);
    sv.haggled = false;
    showNotif(
      'Test drive: ' + found + ' issue' + (found > 1 ? 's' : '') + ' felt while driving!',
    );
  } else if (bill <= 0) {
    // Only "drove fine" if it actually did — otherwise the damage line below
    // is the story, and this read as "drove fine / you damaged it" back to back.
    showNotif('Test drive done — drove fine');
  }

  // H1264: you break it, you pay for it — whether or not you buy it.
  //
  // The bill is charged immediately and is NOT a lien on the purchase: walking
  // away does not walk away from it. And crucially the asking price goes back
  // to FULL and haggling is closed for the visit, so wrecking a car can never
  // become a discount route. That is the whole point of the rule — the damage
  // you caused is your liability, not a negotiating position, and it is
  // applied AFTER the fault-reveal block above so it overrides any discount
  // that reveal just granted.
  if (bill > 0) {
    life.money -= bill;
    life.atFaultIncidents = (life.atFaultIncidents ?? 0) + 1;
    sv.hagglePrice = sv.listing.price;
    sv.haggled = true;
    sv._tdDamaged = true;
    showNotif(
      'You damaged it — $' + bill.toLocaleString()
      + ' for repairs. Price back to full asking.',
    );
  }
}

/** Symptom-stream reveal-check cadence (seconds). Every time the
 *  accumulator crosses this we roll for a hidden-fault hint. 3s is
 *  slow enough that the player has a chance to feel the symptom
 *  through driving before the notif fires, but fast enough that the
 *  45s test drive can surface several hidden faults if the listing
 *  has many. Matches monolith `sv._revealTimer > 3` at L49718. */
export const SYMPTOM_REVEAL_INTERVAL_SEC = 3;

/** Per-tick chance to surface a hidden fault symptom when the
 *  3-second check fires. The player has to be moving (|pSpeed| > 5)
 *  AND lucky for any given check to hit. Matches monolith
 *  `Math.random() < 0.25` at L49725. */
export const SYMPTOM_REVEAL_CHANCE = 0.25;

/** Minimum |pSpeed| (gu/s) for the symptom stream to fire. Slower
 *  than this and the player can't feel anything wrong — the symptom
 *  is supposed to surface through DRIVING, not idling. Matches
 *  monolith `Math.abs(pSpeed) > 5` at L49721. */
export const SYMPTOM_REVEAL_SPEED_GATE = 5;

/** Fallback hint text when a fault has no FAULT_EFFECTS desc string.
 *  Defensive: every fault id in the modular tree's FAULT_EFFECTS
 *  table has a desc, but if a save carries a fault id from a future
 *  monolith version we don't recognize, this generic line keeps the
 *  symptom stream observable. Matches monolith fallback at L49729. */
export const SYMPTOM_REVEAL_GENERIC_HINT = 'Something feels off...';

/** Per-frame timer decrement + symptom stream + auto-end on timer
 *  expiry. Mirrors monolith updateTestDrive at L49710-L49734.
 *
 *  SYMPTOM STREAM (H514): every 3 seconds, while the player is
 *  driving above the 5 gu/s gate, roll 25% for a hidden-fault
 *  reveal. On a hit, pick a random undetected+unrevealed fault from
 *  life.faults, mark `_revealed = true` so it doesn't double-fire,
 *  and surface its FAULT_EFFECTS desc as a `⚠ <hint>` notif.
 *
 *  WHY READ life.faults (not sv.preFaults): startTestDrive copies
 *  sv.preFaults into life.faults at test-drive entry (so the test
 *  car's faults drive the live physics + audio + render effects
 *  during the drive). The symptom stream reads from life.faults to
 *  catch THOSE active fault entries; the _revealed mutations write
 *  to the copy and get discarded when endTestDrive restores
 *  saved.faults. Matches the monolith's `LIFE.faults.filter(...)`
 *  at L49720.
 *
 *  Caller passes life + sv + player so endTestDrive can restore
 *  state when the timer hits zero. */
export function tickTestDrive(
  life: LifeState,
  sv: SellerVisitState | null | undefined,
  player: PlayerState,
  dt: number,
  showNotif: (msg: string) => void,
): void {
  if (!sv || sv.phase !== 'testdrive') return;
  sv.testDriveTimer -= dt;

  // H1265: distance driven, and whether you have actually left the meeting
  // point yet. tdLeftMeet exists so the drive cannot "complete" on the spot
  // where it started — you have to go somewhere and come back, not idle past
  // the minimum distance doing donuts next to the seller.
  const movedM = (Math.abs(player.pSpeed) * dt) / WPX_PER_M;
  sv.tdDistanceM = (sv.tdDistanceM ?? 0) + movedM;
  const dxm = player.px - sv.mapX;
  const dym = player.py - sv.mapY;
  const distToMeet2 = dxm * dxm + dym * dym;
  const returnR = TEST_DRIVE_RETURN_TILES * TILE;
  if (distToMeet2 > (returnR * 1.6) * (returnR * 1.6)) sv.tdLeftMeet = true;

  // Symptom-stream tick.
  sv._revealTimer = (sv._revealTimer ?? 0) + dt;
  if (sv._revealTimer > SYMPTOM_REVEAL_INTERVAL_SEC) {
    sv._revealTimer = 0;
    if (Math.abs(player.pSpeed) > SYMPTOM_REVEAL_SPEED_GATE) {
      const hiddenActive = (life.faults ?? []).filter(
        (f) => !(f as PreFault).detected && !(f as PreFault)._revealed,
      ) as PreFault[];
      if (hiddenActive.length > 0 && Math.random() < SYMPTOM_REVEAL_CHANCE) {
        const hf = hiddenActive[Math.floor(Math.random() * hiddenActive.length)];
        hf._revealed = true;
        const eff = hf.id ? FAULT_EFFECTS[hf.id] : undefined;
        const hint = eff?.desc ?? SYMPTOM_REVEAL_GENERIC_HINT;
        showNotif('⚠ ' + hint);
      }
    }
  }

  // Driven far enough AND brought back to the seller → the drive is over.
  const droveEnough = (sv.tdDistanceM ?? 0) >= TEST_DRIVE_MIN_M;
  const isBack = distToMeet2 <= returnR * returnR;
  if (droveEnough && sv.tdLeftMeet && isBack) {
    endTestDrive(life, sv, player, showNotif);
    return;
  }

  // Backstop only — a normal drive never reaches this.
  if (sv.testDriveTimer <= 0) {
    endTestDrive(life, sv, player, showNotif);
  }
}
