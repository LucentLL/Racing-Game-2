/**
 * H1073 (BL-2): the NPC dialogue box — PS1 anatomy per
 * docs/BLACKLIST.md and the style-guide artifact:
 *
 *   - bevelled charcoal panel across the bottom of the screen
 *   - portrait slot left (modular avatar — NPCs share the player's
 *     base sheets via render/avatar.ts)
 *   - amber name tag; '???' until the speaker is known
 *   - typewriter reveal, 2-4 line pages; tap = reveal all, tap
 *     again = next page / close; blinking ▼ more-indicator
 *
 * State lives at life.dialogue (JSON-safe, wholesale-saved — a save
 * mid-conversation reopens on the same page). The reveal counter is
 * transient (_dlgChars). The box eats every tap while open; the
 * gameLoop tap router checks isDialogueOpen() before other playing-
 * state routes.
 *
 * Consumers: the new-game meet intro (H1074), blacklist pre/post-race
 * taunts (BL-3), and any future face-to-face NPC beat.
 */

import type { LifeState } from '@/state/life';
import { GT2_COLORS } from '@/ui/gt2Chrome';
import { drawAvatar, type AvatarPose } from '@/render/avatar';

export interface DialogueSpeaker extends AvatarPose {
  /** Display name; null renders as '???' (unknown stranger). */
  name: string | null;
}

export interface DialogueState {
  speaker: DialogueSpeaker;
  /** Pre-split pages — keep each to what fits in ~3 lines. */
  pages: string[];
  page: number;
}

interface DlgLife {
  dialogue?: DialogueState | null;
  _dlgChars?: number;
}

/** Characters revealed per frame (~120/s — brisk typewriter). */
const REVEAL_PER_FRAME = 2;

export function openDialogue(
  life: LifeState,
  speaker: DialogueSpeaker,
  pages: string[],
): void {
  const lf = life as unknown as DlgLife;
  const clean = pages.filter((p) => !!p && p.length > 0);
  if (clean.length === 0) return;
  lf.dialogue = { speaker, pages: clean, page: 0 };
  lf._dlgChars = 0;
}

export function isDialogueOpen(life: LifeState): boolean {
  return !!(life as unknown as DlgLife).dialogue;
}

/** Word-wrap helper (monospace, measured). */
function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxW: number,
): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    const t = line ? line + ' ' + w : w;
    if (ctx.measureText(t).width > maxW && line) {
      lines.push(line);
      line = w;
    } else {
      line = t;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** Paint the box + advance the typewriter. Call every frame from the
 *  HUD pass; no-op while closed. */
export function drawDialogue(
  ctx: CanvasRenderingContext2D,
  life: LifeState,
  GW: number,
  GH: number,
): void {
  const lf = life as unknown as DlgLife;
  const d = lf.dialogue;
  if (!d) return;
  const text = d.pages[d.page] ?? '';
  const shown = Math.min(text.length, (lf._dlgChars ?? 0) + REVEAL_PER_FRAME);
  lf._dlgChars = shown;

  const h = 78;
  const x = 8;
  const y = GH - h - 8;
  const w = GW - 16;

  // Bevelled charcoal panel (PS1 1px bevel: light top/left, dark
  // bottom/right) over a deep backdrop strip.
  ctx.fillStyle = 'rgba(20,20,20,0.55)';
  ctx.fillRect(x - 2, y - 12, w + 4, h + 16);
  ctx.fillStyle = GT2_COLORS.panel;
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = '#3a3a3a';
  ctx.fillRect(x, y, w, 1);
  ctx.fillRect(x, y, 1, h);
  ctx.fillStyle = '#0d0d0d';
  ctx.fillRect(x, y + h - 1, w, 1);
  ctx.fillRect(x + w - 1, y, 1, h);

  // Portrait slot.
  const ps = h - 20;
  ctx.fillStyle = GT2_COLORS.bgDeep;
  ctx.fillRect(x + 8, y + 10, ps, ps);
  ctx.strokeStyle = '#3a3a3a';
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 8.5, y + 10.5, ps - 1, ps - 1);
  drawAvatar(ctx, d.speaker, x + 8, y + 10, ps);

  // Name tag — amber plate on the top edge, '???' when unknown.
  const name = d.speaker.name ?? '???';
  ctx.font = 'bold 9px monospace';
  const tagW = ctx.measureText(name).width + 14;
  ctx.fillStyle = GT2_COLORS.amber;
  ctx.fillRect(x + ps + 16, y - 7, tagW, 15);
  ctx.fillStyle = GT2_COLORS.bgDeep;
  ctx.textAlign = 'left';
  ctx.fillText(name, x + ps + 23, y + 4);

  // Text — typewriter substring, wrapped.
  const tx = x + ps + 18;
  const maxW = w - ps - 30;
  ctx.font = '10px monospace';
  ctx.fillStyle = GT2_COLORS.text;
  const lines = wrapText(ctx, text.slice(0, shown), maxW);
  let ly = y + 24;
  for (const line of lines.slice(0, 4)) {
    ctx.fillText(line, tx, ly);
    ly += 13;
  }

  // More-indicator: blinking ▼ once the page is fully revealed.
  if (shown >= text.length && Math.floor(Date.now() / 500) % 2 === 0) {
    ctx.fillStyle = GT2_COLORS.amber;
    ctx.font = 'bold 10px monospace';
    const more = d.page + 1 < d.pages.length;
    ctx.fillText(more ? '▼' : '✕', x + w - 16, y + h - 8);
  }
}

/** Tap routing: reveal-all → next page → close. Returns true while
 *  the box is open (it swallows the tap either way). */
export function handleDialogueTap(life: LifeState): boolean {
  const lf = life as unknown as DlgLife;
  const d = lf.dialogue;
  if (!d) return false;
  const text = d.pages[d.page] ?? '';
  if ((lf._dlgChars ?? 0) < text.length) {
    lf._dlgChars = text.length;
    return true;
  }
  if (d.page + 1 < d.pages.length) {
    d.page++;
    lf._dlgChars = 0;
    return true;
  }
  lf.dialogue = null;
  lf._dlgChars = 0;
  return true;
}
