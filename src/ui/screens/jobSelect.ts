/**
 * Job select screen — second step of character creation.
 *
 * Shown after name entry. Header strip with portrait + alias/age + money
 * + housing + skill summary, then a scrollable list of 9 job cards. Tap
 * a job to commit playerJob, roll job-tiered starting savings (v8.99.42),
 * generate the starting-car choices, and advance to carSelect.
 *
 * Layout constants are exported so the click handler shares the same
 * hit-box math as the renderer (v8.99.39 fix — header expanded to 84px,
 * bottom strip reserved for scroll hint to avoid layering on the last
 * partially-visible card).
 *
 * Ported from monolith L44935-45072.
 *
 * SCAFFOLD status: type contract + entry points stubbed with TODO line
 * refs. The 9-job catalog + per-job pay/bonus copy lives in the body.
 */

import type { JobName } from '../../config/jobs';

/** Top of the scrollable list, in canvas y. Below the player-info strip. */
export const JOB_LIST_TOP = 84;
/** Bottom strip reserved for the scroll-hint chrome. */
export const JOB_BOTTOM_STRIP = 20;

/** Per-frame inputs for the job-select draw pass. */
export interface JobSelectOpts {
  /** Player display state — alias, age, money, housing, skill, fitness. */
  playerAlias: string;
  age: number;
  money: number;
  gender: 'M' | 'F';
  fitness: number;
  skinTone: number;
  /** Housing tier name (HOUSING_TIERS[housingType].name). */
  housingName: string;
  mechSkill: number;
  /** Scroll offset for the list. Caller owns + clamps. */
  scrollY: number;
  /** Canvas internal width / height. */
  GW: number;
  GH: number;
}

/** Caller-supplied callbacks invoked on a successful job selection. */
export interface JobSelectDeps {
  /** Called when the player taps a job card. The screen has already
   *  validated the hit-box and resolved the job name. The caller is
   *  responsible for setting LIFE.playerJob, rolling savings, generating
   *  the starting-car choices, and switching gameState. */
  onPick(jobName: JobName): void;
}

/** Draws the header strip + scrollable job-card list + scroll hint /
 *  scroll bar. TODO(D28-followup): port from L44935-45022. */
export function drawJobSelect(
  _ctx: CanvasRenderingContext2D,
  _opts: JobSelectOpts,
): void {
  // TODO: L44935-45022. 9 jobs: FOOD DELIVERY, AUTO PARTS RUN, PACKAGE
  // COURIER, PARAMEDIC, TOW TRUCK, TRAFFIC COP, TRUCK DRIVER, FUEL
  // TANKER, OFFICE JOB. rowH=50.
}

/** Routes a tap to the right job card. Rejects taps outside the list
 *  clip (the bottom scroll-hint strip mustn't fire selection on the last
 *  partially-visible row — v8.99.39).
 *  TODO(D28-followup): port from L45031-45072. */
export function handleJobSelectClick(
  _tx: number,
  _ty: number,
  _opts: JobSelectOpts,
  _deps: JobSelectDeps,
): void {
  // TODO: L45031-45072.
}
