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
 * Ported from monolith L44853-44990.
 *
 * H4 status: body live. Portrait rendering still placeholder (same as
 * nameEntry — character base sprite sheet hasn't ported yet). Money
 * formatting uses the $$ helper port (src-side). onPick deps receive
 * the job name; LIFE side effects (workRep init, savings roll, car-
 * choice generation, credit-score persistence) happen in caller via
 * subsequent H commits.
 */

import type { JobName } from '../../config/jobs';
import { drawCharacterBase } from '@/render/characterBase';
import { GT2_COLORS, drawGt2Backdrop } from '@/ui/gt2Chrome';

/** Top of the scrollable list, in canvas y. Below the player-info strip. */
export const JOB_LIST_TOP = 84;
/** Bottom strip reserved for the scroll-hint chrome. */
export const JOB_BOTTOM_STRIP = 20;
/** Per-row height. Shared with the click hit-test. */
export const JOB_ROW_H = 50;

/** The 9 jobs the player can pick. Ordering drives both draw and hit-test. */
const JOB_NAMES: readonly JobName[] = [
  'FOOD DELIVERY',
  'AUTO PARTS RUN',
  'PACKAGE COURIER',
  'PARAMEDIC',
  'TOW TRUCK',
  'TRAFFIC COP',
  'TRUCK DRIVER',
  'FUEL TANKER',
  'OFFICE JOB',
] as const;

/** Per-job display copy. */
interface JobCardCopy {
  name: JobName;
  desc: string;
  pay: string;
  bonus: string;
  icon: string;
}

const JOB_CARDS: readonly JobCardCopy[] = [
  { name: 'FOOD DELIVERY',   desc: 'Deliver meals across town',         pay: '$2-10/tip',  bonus: 'Free meal',        icon: '🍔' },
  { name: 'AUTO PARTS RUN',  desc: 'Deliver car parts to shops',        pay: '$20-30k/yr', bonus: '10% part discount',icon: '🔧' },
  { name: 'PACKAGE COURIER', desc: 'Deliver packages',                  pay: '$50-60k/yr', bonus: '',                 icon: '📦' },
  { name: 'PARAMEDIC',       desc: 'Emergency transport',               pay: '$35-45k/yr', bonus: '',                 icon: '🚑' },
  { name: 'TOW TRUCK',       desc: 'Tow broken cars',                   pay: '$30-40k/yr', bonus: '',                 icon: '🚛' },
  { name: 'TRAFFIC COP',     desc: 'Radar trap',                        pay: '$30-40k/yr', bonus: 'Ticket bonuses',   icon: '🚔' },
  { name: 'TRUCK DRIVER',    desc: 'Haul freight',                      pay: '$40-60k/yr', bonus: '',                 icon: '🚛' },
  { name: 'FUEL TANKER',     desc: 'Resupply gas stations',             pay: '$60-80k/yr', bonus: 'Free fuel',        icon: '⛽' },
  { name: 'OFFICE JOB',      desc: 'Drive to office AM, drive home PM', pay: '$40-80k/yr', bonus: '',                 icon: '🏢' },
];

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

/** Format money with 2 decimal places — mirrors monolith's $$ helper
 *  (L7935). */
function formatMoney(v: number): string {
  return '$' + v.toFixed(2);
}

/** Returns the max scrollY for a given screen height. Exported so the
 *  caller can clamp wheel/drag adjustments. */
export function maxJobScroll(GH: number): number {
  const listBot = GH - JOB_BOTTOM_STRIP;
  const visibleHeight = listBot - JOB_LIST_TOP;
  return Math.max(0, JOB_CARDS.length * JOB_ROW_H - visibleHeight);
}

/** Draws the header strip + scrollable job-card list + scroll hint /
 *  scroll bar. Ported from monolith L44853-44940. */
export function drawJobSelect(
  ctx: CanvasRenderingContext2D,
  opts: JobSelectOpts,
): void {
  const { playerAlias, age, money, gender, housingName, mechSkill, fitness, skinTone, scrollY, GW, GH } = opts;

  ctx.fillStyle = GT2_COLORS.bg;
  ctx.fillRect(0, 0, GW, GH);
  // H780: GT2 grid backdrop overlay so this screen reads as the same
  // surface family as the dealer/garage flow.
  drawGt2Backdrop(ctx, GW, GH);
  ctx.textAlign = 'center';

  // Safe-top inset (max(5 % vh, 4 px)). Pushes the title and portrait
  // out of the upper 5 % band so devices with a top-center camera punch
  // (Samsung S24+ etc.) or curved-corner display clipping don't sit
  // under the header text. Original positions used y=4 / y=18 — too
  // close to the top edge per user feedback. Δ is added to every
  // header line so the spacing within the strip is preserved.
  const safeTop = Math.max(GH * 0.05, 4);
  const dy = safeTop - 4;

  // H763: GT2 palette — amber title on charcoal, matches the rest of
  // the menu chrome (gt2Chrome.ts). v8.99.39: 84px header strip with
  // 3-4 short lines instead of two overflow-prone single-line summaries.
  ctx.fillStyle = GT2_COLORS.amber;
  ctx.font = 'bold 15px monospace';
  ctx.fillText('CHOOSE YOUR JOB', GW / 2, 18 + dy);

  // Portrait — wired to drawCharacterBase in H199 (was a colored
  // rect with ♂/♀ glyph placeholder).
  drawCharacterBase(ctx, gender, fitness, skinTone, 4, 4 + dy, 26);
  ctx.strokeStyle = GT2_COLORS.amber;
  ctx.lineWidth = 1;
  ctx.strokeRect(4, 4 + dy, 26, 26);

  // Line 1: Alias + Age
  ctx.fillStyle = GT2_COLORS.text;
  ctx.font = 'bold 10px monospace';
  ctx.fillText(playerAlias + ' • AGE ' + age, GW / 2, 38 + dy);
  // Line 2: Money + housing
  ctx.fillStyle = GT2_COLORS.amber;
  ctx.font = 'bold 10px monospace';
  ctx.fillText(formatMoney(money) + ' • ' + housingName, GW / 2, 52 + dy);
  // Line 3: Skill / fitness summary
  ctx.fillStyle = GT2_COLORS.textMute;
  ctx.font = '9px monospace';
  ctx.fillText('Mech skill: ' + mechSkill + '  •  Fitness: ' + fitness, GW / 2, 65 + dy);
  // Line 4: Hint about next step
  ctx.fillStyle = GT2_COLORS.textDim;
  ctx.font = '8px monospace';
  ctx.fillText('Pick a job. Next: choose your starting car.', GW / 2, 77 + dy);

  const listTop = JOB_LIST_TOP + dy;
  const bottomStrip = JOB_BOTTOM_STRIP;
  const listBot = GH - bottomStrip;
  const rowH = JOB_ROW_H;
  const maxScroll = Math.max(0, JOB_CARDS.length * rowH - (listBot - listTop));
  const clampedScroll = Math.max(0, Math.min(scrollY, maxScroll));

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, listTop, GW, listBot - listTop);
  ctx.clip();
  JOB_CARDS.forEach((j, i) => {
    const yy = listTop + i * rowH - clampedScroll;
    if (yy + 48 < listTop || yy > listBot) return;
    ctx.fillStyle = GT2_COLORS.panel;
    ctx.fillRect(15, yy, GW - 30, 46);
    ctx.strokeStyle = GT2_COLORS.amberDark;
    ctx.lineWidth = 1;
    ctx.strokeRect(15, yy, GW - 30, 46);
    ctx.fillStyle = GT2_COLORS.amber;
    ctx.font = 'bold 12px monospace';
    ctx.fillText(j.icon + ' ' + j.name, GW / 2, yy + 14);
    ctx.fillStyle = GT2_COLORS.text;
    ctx.font = '10px monospace';
    ctx.fillText(j.desc, GW / 2, yy + 26);
    ctx.fillStyle = GT2_COLORS.active;
    ctx.font = 'bold 10px monospace';
    const sep = j.bonus ? '  •  ' : '';
    ctx.fillText(j.pay + sep + j.bonus, GW / 2, yy + 39);
  });
  ctx.restore();

  // Bottom strip — scroll hints + subtle separator. Opaque so the
  // partially-clipped row fades cleanly into it.
  ctx.fillStyle = GT2_COLORS.bg;
  ctx.fillRect(0, listBot, GW, bottomStrip);
  ctx.strokeStyle = GT2_COLORS.panel;
  ctx.beginPath();
  ctx.moveTo(0, listBot);
  ctx.lineTo(GW, listBot);
  ctx.stroke();
  if (maxScroll > 0) {
    ctx.fillStyle = GT2_COLORS.textMute;
    ctx.font = 'bold 9px monospace';
    if (clampedScroll < maxScroll) {
      ctx.fillText('▼ scroll down ▼', GW / 2, GH - 6);
    } else {
      ctx.fillText('▲ scroll up ▲', GW / 2, GH - 6);
    }
  }
  // Right-edge scroll bar
  if (maxScroll > 0) {
    const barH = Math.max(20, (listBot - listTop) * ((listBot - listTop) / (JOB_CARDS.length * rowH)));
    const barY = listTop + (clampedScroll / maxScroll) * (listBot - listTop - barH);
    ctx.fillStyle = GT2_COLORS.amberDark;
    ctx.fillRect(GW - 4, barY, 3, barH);
  }
  ctx.textAlign = 'left';
}

/** Routes a tap to the right job card. Rejects taps outside the list
 *  clip (the bottom scroll-hint strip mustn't fire selection on the last
 *  partially-visible row — v8.99.39). Ported from monolith L44949-44989. */
export function handleJobSelectClick(
  tx: number,
  ty: number,
  opts: JobSelectOpts,
  deps: JobSelectDeps,
): void {
  // Match the safe-top inset applied in drawJobSelect so hit-testing
  // hits the visually-shifted cards. Without this the player would tap
  // a card but the click would resolve against the original positions
  // and either miss the card or trigger the wrong row.
  const safeTop = Math.max(opts.GH * 0.05, 4);
  const dy = safeTop - 4;
  const listTop = JOB_LIST_TOP + dy;
  const listBot = opts.GH - JOB_BOTTOM_STRIP;
  if (ty < listTop || ty > listBot) return;

  for (let i = 0; i < JOB_NAMES.length; i++) {
    const yy = listTop + i * JOB_ROW_H - opts.scrollY;
    if (ty >= yy && ty <= yy + 46 && tx >= 15 && tx <= opts.GW - 15) {
      deps.onPick(JOB_NAMES[i]);
      return;
    }
  }
}
