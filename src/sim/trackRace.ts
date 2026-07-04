/**
 * H1014/H1016: track races on the test maps — a timed run (solo) that becomes
 * a head-to-head vs an AI rival with street-rep progression.
 *
 * Auto-starts at the staging line: drive in slow -> 3-2-1 -> GO. A tier-matched
 * opponent (generateRaceOpponent) launches alongside, driven by the player's
 * EXACT longitudinal physics (advanceOppPhysics) and steered along the track
 * geometry (straight down the drag strip / around the oval ellipse). First to
 * the finish wins; the result feeds the SAME street-rep ladder the city races
 * use (getStreetTier + tier-gated rep gain). Returning to staging re-arms.
 *
 * Separate from the city's sim/race.ts (bets/stakes/RACE-tab). State is a
 * module singleton, reset on map switch (switchMap -> resetTrackRace).
 */
import { getMapDef, type TrackRaceSpec } from '@/world/mapRegistry';
import { getActiveMapId } from '@/world/mapRuntime';
import { TILE, WPX_PER_M } from '@/config/world/tiles';
import { generateRaceOpponent, advanceOppPhysics, type OppPhysState } from '@/sim/race';
import { CAR_CATALOG } from '@/config/cars/catalog';
import { getStreetTier, STREET_TIER_WIN_REP_GAIN, STREET_TIER_LOSS_REP_GAIN } from '@/sim/streetTier';
import type { LifeState } from '@/state/life';

export type TrackRacePhase = 'idle' | 'countdown' | 'running' | 'done';

export interface TrackRaceOpp {
  id: string;
  name: string;
  x: number; y: number; angle: number; // world px / radians
  phys: OppPhysState;
  topSpeed: number;
  dist: number;   // drag: distance travelled from launch (wpx)
  theta: number;  // oval: angle around the ellipse
  lap: number;    // oval
  finished: boolean;
}

export interface TrackRaceRun {
  mapId: string;
  spec: TrackRaceSpec;
  phase: TrackRacePhase;
  countdown: number;
  elapsed: number;
  startX: number;
  startY: number;
  lap: number;
  lapStart: number;
  bestLap: number | null;
  leftStart: boolean;
  result: string | null;
  /** H1016 */
  opp: TrackRaceOpp | null;
  winner: 'player' | 'opponent' | null;
  repGain: number;
}

let run: TrackRaceRun | null = null;

const STAGE_SPEED = 45;      // near-stopped to arm (wpx/s)
const COUNTDOWN_S = 3;
const DRAG_LANE_OFFSET = 0.9 * TILE;  // opponent sits in the adjacent lane (wpx)
/** Oval opponent cornering cap (fraction of its top speed) so a tight loop is
 *  beatable — the AI follows the ellipse on rails, so without this it would
 *  corner at top speed. Tunable. */
const OVAL_SPEED_FRAC = 0.6;

export function getTrackRaceRun(): TrackRaceRun | null {
  return run;
}
export function resetTrackRace(): void {
  run = null;
}

function playerCarIdOf(life: LifeState | null): string {
  return life?.ownedCars?.[0] ?? '';
}

/** Spawn the tier-matched rival at the staging line. Null if no match. */
function spawnOpponent(spec: TrackRaceSpec, launchX: number, launchY: number, life: LifeState | null): TrackRaceOpp | null {
  const oppId = generateRaceOpponent(playerCarIdOf(life));
  if (!oppId) return null;
  const car = CAR_CATALOG[oppId];
  if (!car) return null;
  const opp: TrackRaceOpp = {
    id: oppId,
    name: car.name,
    x: launchX, y: launchY, angle: Math.PI / 2,
    phys: { speed: 0, rpm: 800, gear: 1, shiftTimer: 0 },
    topSpeed: car.topSpeed,
    dist: 0,
    theta: 0,
    lap: 0,
    finished: false,
  };
  if (spec.kind === 'drag') {
    opp.x = launchX + DRAG_LANE_OFFSET; // beside the player, +y heading
  } else if (spec.ovalCenter) {
    // Start at the rightmost point (theta 0), tangent = +y.
    opp.x = (spec.ovalCenter[0] + (spec.ovalRx ?? 0)) * TILE;
    opp.y = spec.ovalCenter[1] * TILE;
    opp.theta = 0;
    opp.angle = Math.PI / 2;
  }
  return opp;
}

/** Advance the rival one frame (physics + steering along the track). */
function advanceOpp(o: TrackRaceOpp, spec: TrackRaceSpec, launchY: number, dt: number): void {
  const car = CAR_CATALOG[o.id];
  if (!car) return;
  advanceOppPhysics(o.phys, car, dt);
  if (spec.kind === 'drag') {
    o.angle = Math.PI / 2;
    o.y += o.phys.speed * dt;
    o.dist = o.y - launchY;
    if (o.dist >= (spec.meters ?? 402) * WPX_PER_M) o.finished = true;
    return;
  }
  // oval: advance along the ellipse by arc length, capped for cornering.
  if (!spec.ovalCenter) return;
  const cx = spec.ovalCenter[0] * TILE, cy = spec.ovalCenter[1] * TILE;
  const rx = (spec.ovalRx ?? 60) * TILE, ry = (spec.ovalRy ?? 40) * TILE;
  const cap = o.topSpeed * OVAL_SPEED_FRAC;
  if (o.phys.speed > cap) o.phys.speed = cap;
  const st = Math.sin(o.theta), ct = Math.cos(o.theta);
  const dsdTheta = Math.hypot(rx * st, ry * ct) || 1;
  o.theta += (o.phys.speed * dt) / dsdTheta;
  o.x = cx + rx * Math.cos(o.theta);
  o.y = cy + ry * Math.sin(o.theta);
  o.angle = Math.atan2(ry * Math.cos(o.theta), -rx * Math.sin(o.theta));
  const laps = Math.floor(o.theta / (Math.PI * 2));
  if (laps > o.lap) o.lap = laps;
  if (o.lap >= (spec.laps ?? 3)) o.finished = true;
}

/** Apply street-rep progression for a completed head-to-head. Returns the rep
 *  gained (for the HUD). */
function applyProgression(life: LifeState, day: number, win: boolean): number {
  const tier = getStreetTier(life);
  life.streetRacesTotal = (life.streetRacesTotal ?? 0) + 1;
  life.lastRaceDay = day;
  let gain: number;
  if (win) {
    life.streetRacesWon = (life.streetRacesWon ?? 0) + 1;
    gain = STREET_TIER_WIN_REP_GAIN[tier.idx as 0 | 1 | 2 | 3];
  } else {
    gain = STREET_TIER_LOSS_REP_GAIN;
  }
  life.streetRep = Math.min(100, (life.streetRep ?? 0) + gain);
  return gain;
}

/** Finish the run: decide winner (if a rival ran), apply progression, and
 *  compose the result banner. */
function finishRun(r: TrackRaceRun, life: LifeState | null, day: number, playerWon: boolean): void {
  const timeStr = r.spec.kind === 'drag'
    ? `${r.elapsed.toFixed(2)}s`
    : `${r.elapsed.toFixed(2)}s · best ${(r.bestLap ?? r.elapsed).toFixed(2)}s`;
  if (r.opp && life) {
    r.winner = playerWon ? 'player' : 'opponent';
    r.repGain = applyProgression(life, day, playerWon);
    const head = playerWon ? `WIN vs ${r.opp.name}` : `LOSS vs ${r.opp.name}`;
    r.result = `${head} · ${timeStr} · +${r.repGain} rep`;
  } else {
    // Solo (no eligible rival) — timing only.
    r.winner = null;
    r.repGain = 0;
    r.result = r.spec.kind === 'drag' ? `ET ${timeStr}` : `${r.lap} laps · ${timeStr}`;
  }
  r.phase = 'done';
}

export function tickTrackRace(
  playerPx: number,
  playerPy: number,
  playerSpeed: number,
  life: LifeState | null,
  day: number,
  dt: number,
  blocked: boolean,
): void {
  const mapId = getActiveMapId();
  const spec = getMapDef(mapId).race;
  if (!spec) { run = null; return; }
  if (blocked || dt <= 0) return;

  if (!run || run.mapId !== mapId) {
    run = {
      mapId, spec, phase: 'idle', countdown: 0, elapsed: 0,
      startX: 0, startY: 0, lap: 0, lapStart: 0, bestLap: null,
      leftStart: false, result: null, opp: null, winner: null, repGain: 0,
    };
  }

  const sx = (spec.startTile[0] + 0.5) * TILE;
  const sy = (spec.startTile[1] + 0.5) * TILE;
  const dToStart = Math.hypot(playerPx - sx, playerPy - sy);
  const inStart = dToStart <= spec.startRadius * TILE;
  const speed = Math.abs(playerSpeed);

  switch (run.phase) {
    case 'idle':
      if (inStart && speed < STAGE_SPEED) {
        run.phase = 'countdown';
        run.countdown = COUNTDOWN_S;
      }
      break;

    case 'countdown':
      if (!inStart) { run.phase = 'idle'; break; }
      run.countdown -= dt;
      if (run.countdown <= 0) {
        run.phase = 'running';
        run.elapsed = 0;
        run.lap = 0;
        run.lapStart = 0;
        run.bestLap = null;
        run.leftStart = false;
        run.startX = playerPx;
        run.startY = playerPy;
        run.winner = null;
        run.repGain = 0;
        run.opp = spawnOpponent(spec, playerPx, playerPy, life);
      }
      break;

    case 'running': {
      run.elapsed += dt;
      if (run.opp && !run.opp.finished) advanceOpp(run.opp, spec, run.startY, dt);

      let playerFinished = false;
      if (spec.kind === 'drag') {
        const traveled = Math.hypot(playerPx - run.startX, playerPy - run.startY);
        if (traveled >= (spec.meters ?? 402) * WPX_PER_M) playerFinished = true;
      } else {
        if (!run.leftStart && dToStart > spec.startRadius * TILE * 2.2) run.leftStart = true;
        if (run.leftStart && inStart) {
          const lapTime = run.elapsed - run.lapStart;
          run.lap += 1;
          if (run.bestLap === null || lapTime < run.bestLap) run.bestLap = lapTime;
          run.lapStart = run.elapsed;
          run.leftStart = false;
          if (run.lap >= (spec.laps ?? 3)) playerFinished = true;
        }
      }

      const oppFinished = run.opp?.finished ?? false;
      if (playerFinished || oppFinished) {
        // First across wins; if both same frame, the player takes it.
        finishRun(run, life, day, playerFinished);
      }
      break;
    }

    case 'done':
      if (!inStart) { run.leftStart = true; }
      else if (run.leftStart && speed < STAGE_SPEED) {
        run.phase = 'countdown';
        run.countdown = COUNTDOWN_S;
        run.result = null;
        run.leftStart = false;
        run.opp = null;
        run.winner = null;
        run.repGain = 0;
      }
      break;
  }
}
