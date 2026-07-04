/**
 * H1014: solo timed track runs with auto-start at the staging line.
 *
 * On a test track (a MapDef with a `race` spec), driving into the staging /
 * start zone at low speed arms a 3-2-1 countdown; on GO a stopwatch runs.
 *   - drag: finishes when the player has travelled the run distance (~quarter
 *     mile) from the launch point -> elapsed time is the ET.
 *   - lap: each re-cross of the start zone (after leaving it) counts a lap;
 *     completing the lap goal finishes the run, tracking the best lap.
 * After a run, returning to the staging zone re-arms it.
 *
 * This is intentionally separate from the city's heavy sim/race.ts (1v1
 * opponent + bets + tier ladder) — H1015 adds the vs-opponent layer that
 * feeds the street-rep progression on top of this timing spine. State lives
 * in a module singleton, reset on map switch (switchMap -> resetTrackRace).
 */
import { getMapDef, type TrackRaceSpec } from '@/world/mapRegistry';
import { getActiveMapId } from '@/world/mapRuntime';
import { TILE, WPX_PER_M } from '@/config/world/tiles';

export type TrackRacePhase = 'idle' | 'countdown' | 'running' | 'done';

export interface TrackRaceRun {
  mapId: string;
  spec: TrackRaceSpec;
  phase: TrackRacePhase;
  /** Seconds left in the 3-2-1 countdown. */
  countdown: number;
  /** Seconds since GO. */
  elapsed: number;
  /** Launch pose snapshot (world px) — drag distance is measured from here. */
  startX: number;
  startY: number;
  /** Laps completed (lap kind). */
  lap: number;
  /** `elapsed` at the last lap crossing, for per-lap timing. */
  lapStart: number;
  bestLap: number | null;
  /** True once the player has left the start zone this lap (lap kind) or
   *  since finishing (done -> re-arm gating). */
  leftStart: boolean;
  /** Human-readable result once finished (ET / lap summary). */
  result: string | null;
}

let run: TrackRaceRun | null = null;

/** Near-stopped threshold to arm the countdown (wpx/s). */
const STAGE_SPEED = 45;
const COUNTDOWN_S = 3;

export function getTrackRaceRun(): TrackRaceRun | null {
  return run;
}
/** Cleared on map switch so a new track starts fresh. */
export function resetTrackRace(): void {
  run = null;
}

/** Per-frame update. No-op (and clears state) on maps with no race spec. */
export function tickTrackRace(
  playerPx: number,
  playerPy: number,
  playerSpeed: number,
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
      leftStart: false, result: null,
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
      if (!inStart) { run.phase = 'idle'; break; } // rolled out of the box
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
      }
      break;

    case 'running':
      run.elapsed += dt;
      if (spec.kind === 'drag') {
        const traveled = Math.hypot(playerPx - run.startX, playerPy - run.startY);
        const goal = (spec.meters ?? 402) * WPX_PER_M;
        if (traveled >= goal) {
          run.result = `ET ${run.elapsed.toFixed(2)}s`;
          run.phase = 'done';
        }
      } else {
        // lap: must leave the start zone before a re-entry counts.
        if (!run.leftStart && dToStart > spec.startRadius * TILE * 2.2) {
          run.leftStart = true;
        }
        if (run.leftStart && inStart) {
          const lapTime = run.elapsed - run.lapStart;
          run.lap += 1;
          if (run.bestLap === null || lapTime < run.bestLap) run.bestLap = lapTime;
          run.lapStart = run.elapsed;
          run.leftStart = false;
          if (run.lap >= (spec.laps ?? 3)) {
            const best = run.bestLap ?? lapTime;
            run.result = `${run.lap} laps · ${run.elapsed.toFixed(2)}s · best ${best.toFixed(2)}s`;
            run.phase = 'done';
          }
        }
      }
      break;

    case 'done':
      // Re-arm: leave the staging zone, then return to it slowly.
      if (!inStart) { run.leftStart = true; }
      else if (run.leftStart && speed < STAGE_SPEED) {
        run.phase = 'countdown';
        run.countdown = COUNTDOWN_S;
        run.result = null;
        run.leftStart = false;
      }
      break;
  }
}
