/**
 * H1079 (BL-3): rep-gated BLACKLIST progression — the loop the pager
 * teased since H1068.
 *
 *   race → wins/rep climb → the next rival's gate clears → the PAGER
 *   fires their call-out (one-shot, persisted on life.blacklist.paged)
 *   → their signature car parks at the CAR MEET flagged as a rival →
 *   roll up + CHALLENGE → taunt dialogue → drag race → win records
 *   defeated[] → the ladder's next name pages you when ITS gate clears.
 *
 * Every challenge runs as a meet drag for now (matches the meets'
 * drag-for-now scope); venue-true oval/city rival races land with the
 * later BL slices, as do pink-slip stakes (BL-4). docs/BLACKLIST.md.
 */
import {
  BLACKLIST_RIVALS, ensureBlacklistState, resolveRivalCar, rivalStatus,
  type BlacklistRival,
} from '@/config/blacklist';
import { pushPage } from '@/ui/hud/pager';
import { injectRivalCar } from '@/world/parkedCars';
import { getTrackRaceRun } from '@/sim/trackRace';
import type { LifeState } from '@/state/life';

/** The next undefeated rival going UP the ladder (rank 10 first).
 *  Null once the boss is beaten. */
export function nextRival(life: LifeState): BlacklistRival | null {
  const bl = ensureBlacklistState(life);
  for (const r of [...BLACKLIST_RIVALS].sort((a, b) => b.rank - a.rank)) {
    if (!bl.defeated.includes(r.rank)) return r;
  }
  return null;
}

/** Frames between unlock checks (~1.5 s at 60 fps) — rivalStatus is a
 *  10-element scan, cheap but pointless to run every frame. */
const CHECK_FRAMES = 90;
let _checkCd = 0;

/** Per-frame (self-throttled) unlock watcher. When the next rival's
 *  wins/rep gate clears, fire their call-out page ONCE; while the gate
 *  stays open, keep their car parked at the meet. */
export function tickBlacklistPager(life: LifeState, day: number, slot: string): void {
  if (--_checkCd > 0) return;
  _checkCd = CHECK_FRAMES;
  const rival = nextRival(life);
  if (!rival) return;
  if (rivalStatus(rival, life) !== 'open') return;
  const bl = ensureBlacklistState(life);
  if (!bl.paged.includes(rival.rank)) {
    bl.paged.push(rival.rank);
    pushPage(life, {
      day, slot, type: 'blacklist',
      text: `#${rival.rank} ${rival.alias}: COME TAKE MY SPOT. @ MEET`,
      read: false,
      expiresDay: day + 3,
    });
  }
  // Keep the rival parked while their gate is open: covers the player
  // being AT the meet when the page fires (no map re-entry needed) and
  // re-parks the car after a LOST challenge (it left its stall to
  // race). Skipped while a run is armed/racing — the racing copy and a
  // parked copy would coexist. injectRivalCar no-ops off-meet or when
  // the car is already in a stall.
  const run = getTrackRaceRun();
  if (!run || run.phase === 'idle' || run.phase === 'done') seedRivalAtMeet(life);
}

/** Park the OPEN next rival's signature car at the meet, flagged so the
 *  CHALLENGE flow recognizes it. Call after rebuildParkedCars on map
 *  switch (no-op on maps without stalls / when no rival is open). */
export function seedRivalAtMeet(life: LifeState): void {
  const rival = nextRival(life);
  if (!rival || rivalStatus(rival, life) !== 'open') return;
  const car = resolveRivalCar(rival);
  if (!car) return;
  injectRivalCar(car.id, `${rival.alias}'S ${car.name}`, rival.rank, rival.alias);
}
