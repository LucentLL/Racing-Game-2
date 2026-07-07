/**
 * H1067 (BL-1): the BLACKLIST board — view-only rival ladder.
 *
 * Lives as a sub-view of the pause-menu RACE tab (life._blacklistOpen
 * flips it; the tab's draw + tap handlers route here). Ten mugshot
 * cards, MW-style: rank, alias, signature car, and the gate — locked
 * cards show wins/rep progress, open cards taunt you when tapped
 * (challenge races land in BL-3), beaten cards get the stamp.
 *
 * GT2 chrome + rect-cache tap pattern (pauseMenu convention).
 * Design: docs/BLACKLIST.md.
 */

import type { LifeState } from '@/state/life';
import { GT2_COLORS } from '@/ui/gt2Chrome';
import { CAR_CATALOG } from '@/config/cars/catalog';
import { drawCharacterBase } from '@/render/characterBase';
import { showNotif } from '@/ui/notif';
import {
  BLACKLIST_RIVALS, resolveRivalCar, rivalStatus, tauntFor,
  ensureBlacklistState, type BlacklistRival,
} from '@/config/blacklist';

interface BlRect { x: number; y: number; w: number; h: number; rank: number }

interface BlacklistUiCache {
  _blacklistOpen?: boolean;
  _blCardRects?: BlRect[];
  _blBackRect?: { x: number; y: number; w: number; h: number } | null;
}

export function drawBlacklistBoard(
  ctx: CanvasRenderingContext2D,
  life: LifeState,
  GW: number,
  GH: number,
  cy: number,
): void {
  const cache = life as unknown as BlacklistUiCache;
  ensureBlacklistState(life as { blacklist?: never });

  ctx.textAlign = 'center';
  ctx.fillStyle = GT2_COLORS.active;
  ctx.font = 'bold 14px monospace';
  ctx.fillText('THE BLACKLIST', GW / 2, cy);
  ctx.fillStyle = GT2_COLORS.textMute;
  ctx.font = '9px monospace';
  ctx.fillText(
    'WINS ' + (life.streetRacesWon ?? 0) + ' · REP ' + (life.streetRep ?? 0) + '/100 — beat every name below a rival to call them out',
    GW / 2, cy + 14,
  );

  // 5×2 card grid between the header and the CLOSE pill.
  const gridTop = cy + 24;
  const gridBot = GH - 42;
  const cols = 5;
  const gap = 6;
  const cardW = Math.floor((GW - 24 - gap * (cols - 1)) / cols);
  const cardH = Math.floor((gridBot - gridTop - gap) / 2);
  const rects: BlRect[] = [];

  // Rank 10 (entry) top-left → rank 1 (boss) bottom-right.
  const ordered = [...BLACKLIST_RIVALS].sort((a, b) => b.rank - a.rank);
  ordered.forEach((rival, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = 12 + col * (cardW + gap);
    const y = gridTop + row * (cardH + gap);
    drawRivalCard(ctx, life, rival, x, y, cardW, cardH);
    rects.push({ x, y, w: cardW, h: cardH, rank: rival.rank });
  });
  cache._blCardRects = rects;

  // BACK pill (top-left, mirrors sub-view convention).
  const bx = 12; const by = cy - 12; const bw = 64; const bh = 18;
  ctx.fillStyle = 'rgba(247,166,35,0.12)';
  ctx.fillRect(bx, by, bw, bh);
  ctx.strokeStyle = GT2_COLORS.amberDark;
  ctx.lineWidth = 1;
  ctx.strokeRect(bx + 0.5, by + 0.5, bw - 1, bh - 1);
  ctx.fillStyle = GT2_COLORS.amber;
  ctx.font = 'bold 9px monospace';
  ctx.fillText('← BACK', bx + bw / 2, by + 12);
  cache._blBackRect = { x: bx, y: by, w: bw, h: bh };
  ctx.textAlign = 'left';
}

function drawRivalCard(
  ctx: CanvasRenderingContext2D,
  life: LifeState,
  rival: BlacklistRival,
  x: number, y: number, w: number, h: number,
): void {
  const status = rivalStatus(rival, life);
  const dim = status === 'locked';

  ctx.fillStyle = GT2_COLORS.panel;
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = status === 'open' ? GT2_COLORS.active
    : status === 'beaten' ? '#3d7a4f' : '#3a3a3a';
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);

  ctx.globalAlpha = dim ? 0.55 : 1;
  ctx.textAlign = 'center';

  // Rank badge.
  ctx.fillStyle = status === 'open' ? GT2_COLORS.active : GT2_COLORS.amberDark;
  ctx.font = 'bold 13px monospace';
  ctx.textAlign = 'left';
  ctx.fillText('#' + rival.rank, x + 6, y + 15);

  // Mugshot.
  const mug = Math.min(34, h - 56);
  drawCharacterBase(ctx, rival.gender, rival.fitness, 1, x + w / 2 - mug / 2, y + 6, mug);

  // Alias + car.
  ctx.textAlign = 'center';
  ctx.fillStyle = GT2_COLORS.text;
  ctx.font = 'bold 10px monospace';
  ctx.fillText(rival.alias, x + w / 2, y + mug + 17);
  ctx.fillStyle = GT2_COLORS.textMute;
  ctx.font = '8px monospace';
  const carName = resolveRivalCar(rival)?.name ?? rival.carLabel;
  ctx.fillText(truncate(ctx, carName, w - 10), x + w / 2, y + mug + 28);

  // Status line.
  ctx.font = 'bold 8px monospace';
  if (status === 'beaten') {
    ctx.fillStyle = '#7fe5a8';
    ctx.fillText('✔ DEFEATED', x + w / 2, y + h - 8);
  } else if (status === 'open') {
    ctx.fillStyle = GT2_COLORS.active;
    ctx.fillText('▶ CHALLENGE', x + w / 2, y + h - 8);
  } else {
    ctx.fillStyle = GT2_COLORS.textDim;
    const wins = life.streetRacesWon ?? 0;
    const rep = life.streetRep ?? 0;
    ctx.fillText(
      'W ' + Math.min(wins, rival.gate.wins) + '/' + rival.gate.wins
      + ' · REP ' + Math.min(rep, rival.gate.rep) + '/' + rival.gate.rep,
      x + w / 2, y + h - 8,
    );
  }
  ctx.globalAlpha = 1;
}

function truncate(ctx: CanvasRenderingContext2D, s: string, maxW: number): string {
  if (ctx.measureText(s).width <= maxW) return s;
  let t = s;
  while (t.length > 3 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
  return t + '…';
}

/** Tap routing while the board is open. Returns true when consumed. */
export function handleBlacklistBoardTap(
  tx: number,
  ty: number,
  life: LifeState,
): boolean {
  const cache = life as unknown as BlacklistUiCache;
  const back = cache._blBackRect;
  if (back && tx >= back.x && tx <= back.x + back.w && ty >= back.y && ty <= back.y + back.h) {
    cache._blacklistOpen = false;
    return true;
  }
  const rects = cache._blCardRects ?? [];
  for (const r of rects) {
    if (tx < r.x || tx > r.x + r.w || ty < r.y || ty > r.y + r.h) continue;
    const rival = BLACKLIST_RIVALS.find((rv) => rv.rank === r.rank);
    if (!rival) return true;
    const status = rivalStatus(rival, life);
    if (status === 'open') {
      // BL-1 is view-only — the rival talks; the race lands in BL-3.
      const playerCar = life.ownedCars[0] ? CAR_CATALOG[life.ownedCars[0]] : undefined;
      showNotif(life, rival.alias + ': "' + tauntFor(rival, playerCar, !!life.isManual) + '"', 300);
    } else if (status === 'locked') {
      showNotif(life, '#' + rival.rank + ' ' + rival.alias + ' — need ' + rival.gate.wins + ' wins, rep ' + rival.gate.rep + ', and every rank below beaten', 240);
    }
    return true;
  }
  return true; // board swallows stray taps
}
