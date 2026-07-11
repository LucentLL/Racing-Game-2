/**
 * Daily job rollers — populate the JOBS tab's two branches:
 *   - generateJobListings(): 1..3 random openings for an unemployed
 *     player to apply for. Pulls from the 9-job catalog and
 *     randomly trims. 1:1 port of monolith L47046-47062.
 *   - generateDailyJob(playerJob, tileMap, opts): the per-day
 *     assignment for a player who already has a playerJob. Returns
 *     a single-element array of available jobs. The H200 port
 *     covers the "random pickup → random delivery" branch (4
 *     job types). OFFICE JOB commute (H217) and TRAFFIC COP
 *     patrol (H1126 — no coords, the copJob state machine owns
 *     the shift) and FUEL TANKER depot→station (H1128) are
 *     special-cased. For non-handled job names the function
 *     falls through to the FOOD DELIVERY pay-band, matching
 *     monolith L45235 fallback.
 *
 * Both functions are pure. Caller stores the results on LIFE.
 */

import { TILE } from '@/config/world/tiles';
import type { JobName } from '@/config/jobs';
import { resolveTarget, type TargetKind } from '@/sim/jobTargets';

/** Pickable opening for the unemployed UI. Shape mirrors the
 *  monolith's L47048 row schema. */
export interface JobOpening {
  name: JobName;
  pay: string;
  perk: string;
}

/** Today's available job assignment. Mirrors the LIFE.job shape
 *  (subset of monolith fields — `fromX/fromY/toX/toY` for the
 *  destination, `pickedUp` toggled at pickup-arrival time).
 *  H1127 grew the DeliveryTask fields: labels + target kind come
 *  from the sim/jobTargets resolver; all optional so pre-H1127
 *  saves (LIFE persists wholesale) load clean. */
export interface DailyJob {
  type: string;
  pay: number;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  pickedUp: boolean;
  /** H1127: pickup display name (station/building label; undefined
   *  for anonymous road points). */
  fromLabel?: string;
  /** H1127: delivery display name. */
  toLabel?: string;
  /** H1127: what the DELIVERY point anchors to. Drives kind-aware
   *  marker art / arrival flavor as venues plug in. */
  targetKind?: TargetKind;
  /** H1127: reserved for multi-stop runs (restaurant→house loops).
   *  No logic consumes it yet — the arrival machine grows a leg
   *  cursor when FOOD DELIVERY goes venue-true. */
  legs?: Array<{ x: number; y: number; kind: TargetKind; label?: string }>;
}

const ALL_OPENINGS: readonly JobOpening[] = [
  { name: 'FOOD DELIVERY',   pay: '$2-10/tip',     perk: 'Free meal' },
  { name: 'AUTO PARTS RUN',  pay: '$20-30k/yr',    perk: '10% part discount' },
  { name: 'PACKAGE COURIER', pay: '$50-60k/yr',    perk: '' },
  { name: 'PARAMEDIC',       pay: '$35-45k/yr',    perk: '' },
  { name: 'TOW TRUCK',       pay: '$30-40k/yr',    perk: '' },
  { name: 'TRAFFIC COP',     pay: '$30-40k/yr',    perk: 'Ticket bonuses' },
  { name: 'TRUCK DRIVER',    pay: '$40-60k/yr',    perk: '' },
  { name: 'FUEL TANKER',     pay: '$60-80k/yr',    perk: 'Free fuel' },
  { name: 'OFFICE JOB',      pay: '$40-80k/yr',    perk: '' },
];

/** 1:1 port of monolith L47046-47062. Shuffles the 9-job catalog
 *  and returns 1..3 entries. Caller drops the result on
 *  life._jobListings. */
export function generateJobListings(): JobOpening[] {
  const shuffled = [...ALL_OPENINGS].sort(() => Math.random() - 0.5);
  const count = 1 + Math.floor(Math.random() * 3);
  return shuffled.slice(0, count);
}

/** Per-job pay band. 1:1 with monolith L45225-45234. Special-case
 *  branches (TRAFFIC COP / FUEL TANKER / OFFICE JOB) handle pay
 *  separately in the monolith — listed here so the shared roller
 *  can route them once the special cases land. */
const PAY_BANDS: Record<JobName, { min: number; max: number }> = {
  'FOOD DELIVERY':   { min: 2,   max: 10 },
  'AUTO PARTS RUN':  { min: 50,  max: 120 },
  'PACKAGE COURIER': { min: 40,  max: 100 },
  'PARAMEDIC':       { min: 80,  max: 200 },
  'TOW TRUCK':       { min: 50,  max: 50 },
  'TRAFFIC COP':     { min: 50,  max: 200 },
  'TRUCK DRIVER':    { min: 100, max: 250 },
  'FUEL TANKER':     { min: 120, max: 280 },
  'OFFICE JOB':      { min: 0,   max: 0 },
};

/** Tile-map shape the random-road-pickup loop needs. Same interface
 *  contract as src/world/tileMap.ts (decoupled here so this module
 *  stays test-friendly). */
export interface JobsTileMap {
  getTile(tx: number, ty: number): number;
}

/** Generate today's assignment for an employed player.
 *
 *  H200 SCOPE: random pickup + random delivery branch only (the
 *  4 mainline job types: FOOD DELIVERY, AUTO PARTS RUN, PACKAGE
 *  COURIER, PARAMEDIC, plus TOW TRUCK + TRUCK DRIVER which share
 *  the same shape). Special-case branches in the monolith:
 *    - TRAFFIC COP (L45240) — patrol mode, no pickup/delivery (H1126)
 *    - FUEL TANKER (L45244) — depot → random gas station (H1128)
 *    - OFFICE JOB (L45256) — home → office commute (H217)
 *  All three return the same `DailyJob[]` shape but skip the
 *  random-road walk.
 *
 *  Dispatcher-trust bonus: 1:1 with monolith L45237 — when
 *  `dispatcherTrust=true`, the pay roll is biased upward (0.4 +
 *  rand*0.6 of the band instead of full rand). */
export function generateDailyJob(
  playerJob: JobName | '',
  tileMap: JobsTileMap,
  opts: { dispatcherTrust?: boolean; homeX?: number; homeY?: number; officeX?: number; officeY?: number } = {},
): DailyJob[] {
  // Resolve job + pay band. Fallback to FOOD DELIVERY band when the
  // playerJob isn't recognized — same as monolith L45235.
  const job = (playerJob && playerJob in PAY_BANDS ? playerJob : 'FOOD DELIVERY') as JobName;
  const band = PAY_BANDS[job];
  const payRoll = opts.dispatcherTrust ? 0.4 + Math.random() * 0.6 : Math.random();
  const pay = band.min + Math.floor(payRoll * (band.max - band.min));

  // H1126: TRAFFIC COP is patrol mode — NO pickup/delivery (monolith
  // L45240). Before this branch the cop fell through to the random
  // A/B road walk below, and since jobArrival/jobMarkers treated
  // those coords as a mainline delivery, a cop could "complete the
  // shift" by driving A→B for band pay, bypassing the whole
  // radar→chase→ticket loop. Zero coords are the no-target sentinel
  // (jobArrival's `!fromX || !toX` guard); the ticket flow ends the
  // shift via issueTrafficTicket instead.
  if (job === 'TRAFFIC COP') {
    return [{
      type: 'TRAFFIC COP',
      pay,
      fromX: 0,
      fromY: 0,
      toX: 0,
      toY: 0,
      pickedUp: false,
    }];
  }

  // H1128: FUEL TANKER — fuel depot → random gas station. 1:1 port of
  // monolith L45244-45252: destination is a random GAS_STATIONS entry
  // (via the H1127 resolver, which snaps to the nearest road tile —
  // intentional adaptation: the H13-era station coords sit up to ~69
  // tiles off-road in the current world export); the depot pickup is
  // a random road tile re-rolled until it sits ≥200 world-px Manhattan
  // from the station (monolith `Math.abs(ax*TILE-gs.cx)+...<200` loop).
  if (job === 'FUEL TANKER') {
    const to = resolveTarget('gasStation', tileMap);
    let from = resolveTarget('road', tileMap);
    for (let tries = 0; tries < 20; tries++) {
      if (Math.abs(from.x - to.x) + Math.abs(from.y - to.y) >= 200) break;
      from = resolveTarget('road', tileMap);
    }
    return [{
      type: 'FUEL TANKER',
      pay,
      fromX: from.x,
      fromY: from.y,
      toX: to.x,
      toY: to.y,
      pickedUp: false,
      fromLabel: 'Fuel Depot',
      toLabel: to.name,
      targetKind: to.kind,
    }];
  }

  // H217: OFFICE JOB commute — home → office. 1:1 port of monolith
  // L45256-45259. Skips the random-pickup walk; pickedUp=false so
  // the in-world A marker still lights up at the player's home as
  // the "morning starting point" cue. Pay is 0 here because OFFICE
  // salary accrues monthly (PR per-shift pay would double-count
  // against the monthly pay cycle).
  if (job === 'OFFICE JOB' && opts.homeX != null && opts.officeX != null) {
    return [{
      type: 'OFFICE JOB',
      pay: 0,
      fromX: opts.homeX * TILE + TILE / 2,
      fromY: (opts.homeY ?? 0) * TILE + TILE / 2,
      toX: opts.officeX * TILE + TILE / 2,
      toY: (opts.officeY ?? 0) * TILE + TILE / 2,
      pickedUp: false,
    }];
  }

  // H1127: both walks now route through the DeliveryTask resolver —
  // the 4 mainline jobs (+ TOW/TRUCK) keep their H200 random-road
  // behavior via kind:'road'; venue-true pickups/drop-offs
  // (restaurant → house, depot → gas station) become data-only
  // swaps of these two kinds.
  const from = resolveTarget('road', tileMap);
  const to = resolveTarget('road', tileMap);

  return [{
    type: job,
    pay,
    fromX: from.x,
    fromY: from.y,
    toX: to.x,
    toY: to.y,
    pickedUp: false,
    fromLabel: from.name,
    toLabel: to.name,
    targetKind: to.kind,
  }];
}
