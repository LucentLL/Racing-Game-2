/**
 * Race HUD overlay — four sub-phases driven off RACE.phase.
 *
 *   - 'ready' (v8.99.112) — pre-race confirmation modal. Player can
 *     open menus / map / garage to prep their car; nothing ticks until
 *     they tap START COUNTDOWN. Suppressed when menuOpen / carSelectOpen
 *     / fullMapOpen / homeScreenOpen so the prep surfaces are reachable.
 *     Buttons: START COUNTDOWN (green) + FORFEIT (red) — emit hit-rects
 *     into RACE._readyBtnRect / RACE._readyAbortRect.
 *
 *   - 'countdown' — big 3-2-1-GO! at center. No interaction.
 *
 *   - 'racing' — top status bar with position indicator (YOU LEAD /
 *     OPPONENT LEADS), per-side progress bars (cyan you, red opp), and
 *     a distance-to-finish readout in the player's preferred unit.
 *     Distance line in feet under 1 mile, miles otherwise.
 *
 *   - 'result' — win/loss screen with bet payout or pink-slip outcome
 *     (winning a pink-slip race adds the opponent's car to your garage;
 *     losing forfeits LIFE.lostCar permanently). Dismiss button below.
 *
 * Distance display respects v8.99.126.87 unit system: getEffectiveUnit
 * (active car) drives mph vs km/h labeling on race-distance lines.
 *
 * Ported from monolith L36109+ (the inline race HUD block at the tail
 * of render()).
 *
 * SCAFFOLD status: type contract + entry points stubbed with TODO line
 * refs.
 */

/** Active race lifecycle phase. */
export type RacePhase =
  | 'setup'
  | 'ready'
  | 'countdown'
  | 'racing'
  | 'result'
  | '';

/** Per-frame inputs for the race HUD. */
export interface RaceHudOpts {
  /** Active phase — drives which sub-overlay renders. */
  phase: RacePhase;
  /** Opponent display name. */
  oppName: string;
  /** Bet amount ($). */
  bet: number;
  /** True for pink-slip races (visual treatment + result-screen copy). */
  pinkSlip: boolean;
  /** Race distance in tiles (drives the distance label when set). */
  raceDistance: number | null;
  /** Player display unit ('mph' | 'km'). */
  useMph: boolean;
  /** Tile size in world units (for distance conversion). */
  TILE: number;
  /** Countdown integer (3,2,1) or 0 (renders as 'GO!'). */
  countdown: number;
  /** Player + opponent world coords, finish + start (drive 'racing' bars). */
  px: number;
  py: number;
  oppX: number;
  oppY: number;
  startX: number;
  startY: number;
  finishX: number;
  finishY: number;
  /** Result phase: 'player' | 'opponent'. */
  winner: 'player' | 'opponent' | null;
  /** Pink-slip won-car name (when winner==='player' && pinkSlip). */
  wonCarName: string | null;
  /** Pink-slip lost-car id (when winner==='opponent' && pinkSlip). */
  lostCarId: string | null;
  /** Suppress flags — 'ready' phase hides when ANY of these are true. */
  menuOpen: boolean;
  carSelectOpen: boolean;
  fullMapOpen: boolean;
  homeScreenOpen: boolean;
  /** Canvas internal width / height. */
  GW: number;
  GH: number;
}

/** Tap rects emitted by the 'ready' phase. */
export interface RaceHudRects {
  startCountdown: { x: number; y: number; w: number; h: number } | null;
  forfeit: { x: number; y: number; w: number; h: number } | null;
  /** Result-screen dismiss button. */
  dismiss: { x: number; y: number; w: number; h: number } | null;
}

/** Side effects of taps in 'ready' / 'result' phases. */
export interface RaceHudDeps {
  /** START COUNTDOWN — flips RACE.phase to 'countdown'. */
  startCountdown(): void;
  /** FORFEIT — clears RACE.active, RACE.phase. */
  forfeit(): void;
  /** Result-screen dismiss — clears RACE / returns to gameplay. */
  dismissResult(): void;
}

/** Draws the active sub-overlay (one of ready / countdown / racing /
 *  result). Emits the 'ready' button rects into the supplied rects bag.
 *  TODO(D32-followup): port from L36109+. */
export function drawRaceHud(
  _ctx: CanvasRenderingContext2D,
  _opts: RaceHudOpts,
  _rects: RaceHudRects,
): void {
  // TODO: L36109+. 'ready' suppressed when any UI surface is up so prep
  // affordances stay reachable. 'racing' top status bar at y=0 (20px).
}

/** Routes a tap through the rects bag to the right side-effect.
 *  Returns true when consumed. TODO(D32-followup): port from monolith
 *  L21717-21727 (mouse) + L22135-22147 (touch). */
export function handleRaceHudTap(
  _tx: number,
  _ty: number,
  _rects: RaceHudRects,
  _deps: RaceHudDeps,
): boolean {
  // TODO: L21717-21727 + L22135-22147.
  return false;
}
