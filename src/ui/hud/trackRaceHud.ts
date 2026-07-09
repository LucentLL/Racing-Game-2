/**
 * H1014/H1016/H1019: HUD for the track run — staging prompt, big countdown,
 * live timer + rival line, and a result banner with RETURN HOME / RACE AGAIN
 * buttons. Drawn in screen space during the playing HUD pass; pulls the run
 * state itself and no-ops off a test track.
 */
import { getTrackRaceRun } from '@/sim/trackRace';

const AMBER = '255, 180, 60';

/** GT4-style lap/elapsed readout: m'ss.sss (always minutes + 3-decimal seconds,
 *  e.g. 1'38.516, 0'12.340) — matches the Gran Turismo timing font. */
function fmtLapGt4(s: number): string {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const rem = s - m * 60;
  return `${m}'${rem < 10 ? '0' : ''}${rem.toFixed(3)}`;
}

interface Rect { x: number; y: number; w: number; h: number }
/** Result-screen button rects, live only while phase === 'done'. */
let _homeBtn: Rect | null = null;
let _againBtn: Rect | null = null;

function panel(ctx: CanvasRenderingContext2D, cx: number, y: number, w: number, h: number): void {
  ctx.fillStyle = 'rgba(10, 8, 2, 0.72)';
  ctx.fillRect(cx - w / 2, y, w, h);
  ctx.strokeStyle = `rgba(${AMBER}, 0.9)`;
  ctx.lineWidth = 2;
  ctx.strokeRect(cx - w / 2, y, w, h);
}

function button(ctx: CanvasRenderingContext2D, r: Rect, label: string, rgb: string): void {
  ctx.fillStyle = `rgba(${rgb}, 0.20)`;
  ctx.fillRect(r.x, r.y, r.w, r.h);
  ctx.strokeStyle = `rgba(${rgb}, 1)`;
  ctx.lineWidth = 2;
  ctx.strokeRect(r.x, r.y, r.w, r.h);
  ctx.fillStyle = `rgba(${rgb}, 1)`;
  ctx.font = 'bold 12px monospace';
  ctx.textAlign = 'center';
  ctx.fillText(label, r.x + r.w / 2, r.y + r.h / 2 + 4);
}

/** Small stopwatch glyph for the GT4 current-time readout (crown stem + two
 *  hands), stroked in amber. Centre (x,y), face radius r. */
function drawStopwatch(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.strokeStyle = `rgba(${AMBER}, 0.95)`;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x, y - r - 1); ctx.lineTo(x, y - r - 4);         // crown stem
  ctx.moveTo(x - 3, y - r - 4); ctx.lineTo(x + 3, y - r - 4); // crown bar
  ctx.moveTo(x, y); ctx.lineTo(x, y - r * 0.6);               // hand up
  ctx.moveTo(x, y); ctx.lineTo(x + r * 0.45, y + r * 0.15);   // second hand
  ctx.stroke();
}

interface Gt4RaceOpts {
  /** race rank; falls back to 1 (GT4 shows POSITION 1 even solo). */
  position?: number | null;
  lap?: number | null;
  laps?: number | null;
  /** replaces the LAP field when set (e.g. '402 m', 'DESCENT'). */
  modeTag?: string | null;
  curTime: number;
  bestLap?: number | null;
  lastLap?: number | null;
  vs?: string | null;
}

/** GT4 race readout: POSITION + LAP top-LEFT, current time top-CENTRE with a
 *  stopwatch, BEST + LAST lap top-RIGHT. Screen space, top band, drop-shadowed
 *  so it stays legible over the world without a boxy panel. */
function drawGt4RaceBar(ctx: CanvasRenderingContext2D, GW: number, o: Gt4RaceOpts): void {
  const cx = GW / 2;
  const M = 16, topY = 16;
  const dim = 'rgba(228,228,214,0.72)';
  const white = 'rgba(255,255,255,0.96)';
  const amber = `rgba(${AMBER}, 1)`;
  const green = 'rgba(150,255,170,0.95)';
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.9)';
  ctx.shadowBlur = 4;

  // LEFT — position + lap/mode
  ctx.textAlign = 'left';
  ctx.fillStyle = dim; ctx.font = 'bold 9px monospace';
  ctx.fillText('POSITION', M, topY + 8);
  const posLabelW = ctx.measureText('POSITION').width;
  ctx.fillStyle = amber; ctx.font = 'bold 30px monospace';
  const posStr = String(o.position ?? 1);
  ctx.fillText(posStr, M, topY + 37);
  // second column clears BOTH the big number and the (wider) POSITION label.
  const rx = M + Math.max(ctx.measureText(posStr).width, posLabelW) + 16;
  const secLabel = o.modeTag != null ? '' : 'LAP';
  const secVal = o.modeTag != null ? o.modeTag
    : o.laps != null ? `${o.lap ?? 1}/${o.laps}`
      : o.lap != null ? String(o.lap) : '';
  if (secLabel) {
    ctx.fillStyle = dim; ctx.font = 'bold 9px monospace';
    ctx.fillText(secLabel, rx, topY + 8);
  }
  if (secVal) {
    ctx.fillStyle = white; ctx.font = 'bold 18px monospace';
    ctx.fillText(secVal, rx, topY + 31);
  }

  // CENTRE — stopwatch + current time (the hero)
  const t = fmtLapGt4(o.curTime);
  ctx.font = 'bold 30px monospace';
  const tw = ctx.measureText(t).width;
  const iconR = 8, gap = 12;
  const blockW = iconR * 2 + gap + tw;
  const startX = cx - blockW / 2;
  drawStopwatch(ctx, startX + iconR, topY + 22, iconR);
  ctx.textAlign = 'left';
  ctx.fillStyle = amber;
  ctx.fillText(t, startX + iconR * 2 + gap, topY + 32);
  if (o.vs) {
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255,140,140,0.92)';
    ctx.font = '10px monospace';
    ctx.fillText(`vs ${o.vs}`, cx, topY + 48);
  }

  // RIGHT — best + last lap
  ctx.textAlign = 'right';
  ctx.fillStyle = dim; ctx.font = 'bold 9px monospace';
  ctx.fillText('BEST LAP', GW - M, topY + 8);
  ctx.font = 'bold 15px monospace';
  ctx.fillStyle = o.bestLap != null ? green : dim;
  ctx.fillText(o.bestLap != null ? fmtLapGt4(o.bestLap) : "--'--.---", GW - M, topY + 24);
  ctx.fillStyle = dim; ctx.font = 'bold 9px monospace';
  ctx.fillText('LAST LAP', GW - M, topY + 42);
  ctx.font = 'bold 15px monospace';
  ctx.fillStyle = o.lastLap != null ? white : dim;
  ctx.fillText(o.lastLap != null ? fmtLapGt4(o.lastLap) : "--'--.---", GW - M, topY + 58);

  ctx.restore();
}

export function drawTrackRaceHud(ctx: CanvasRenderingContext2D, GW: number, GH: number): void {
  const run = getTrackRaceRun();
  if (!run || run.phase !== 'done') { _homeBtn = null; _againBtn = null; }
  if (!run) return;
  const cx = GW / 2;
  ctx.save();
  ctx.textAlign = 'center';

  if (run.phase === 'idle') {
    // H1087: touge sprint — staged at the summit; prompt to descend.
    if (run.spec.kind === 'sprint') {
      panel(ctx, cx, 58, 360, 42);
      ctx.fillStyle = `rgba(${AMBER}, 0.98)`;
      ctx.font = 'bold 13px monospace';
      ctx.fillText('▼ DESCEND — LEAVE THE SUMMIT TO START', cx, 78);
      ctx.fillStyle = 'rgba(220,220,200,0.8)';
      ctx.font = '10px monospace';
      ctx.fillText('Point-to-point run · reach the base to stop the clock', cx, 92);
      ctx.restore();
      return;
    }
    // H1034: the car meet (autoStage:false) has no staging zone — you race by
    // CHALLENGING a parked car, so skip the "drive into staging" prompt (the
    // CHALLENGE button is the prompt). No idle banner there.
    if (run.spec.autoStage === false) {
      ctx.restore();
      return;
    }
    if (run.racedToday) {
      // H1029: daily race already used.
      panel(ctx, cx, 58, 380, 42);
      ctx.fillStyle = 'rgba(255,180,60,0.98)';
      ctx.font = 'bold 12px monospace';
      ctx.fillText('✅ ALREADY RACED TODAY', cx, 76);
      ctx.fillStyle = 'rgba(220,220,200,0.8)';
      ctx.font = '10px monospace';
      ctx.fillText('Come back tomorrow — upgrade or repair meanwhile', cx, 90);
    } else {
      panel(ctx, cx, 58, 340, 42);
      ctx.fillStyle = `rgba(${AMBER}, 0.98)`;
      ctx.font = 'bold 13px monospace';
      ctx.fillText('🏁 DRIVE INTO STAGING TO START', cx, 78);
      ctx.fillStyle = 'rgba(220,220,200,0.8)';
      ctx.font = '10px monospace';
      ctx.fillText(run.spec.kind === 'drag'
        ? `Quarter mile · ${run.spec.meters ?? 402} m timed run`
        : `${run.spec.laps ?? 3} laps · best-lap timed`, cx, 92);
    }
  } else if (run.phase === 'countdown') {
    const n = Math.max(1, Math.ceil(run.countdown));
    ctx.fillStyle = `rgba(${AMBER}, 0.98)`;
    ctx.font = 'bold 72px monospace';
    ctx.fillText(String(n), cx, GH * 0.42);
    if (run.warnTimer > 0 && run.warning) {
      ctx.fillStyle = 'rgba(255,90,90,1)';
      ctx.font = 'bold 22px monospace';
      ctx.fillText(run.warning, cx, GH * 0.42 - 64);
    }
  } else if (run.phase === 'running' && run.spec.kind === 'sprint') {
    // H1092: touge descent — GT4 corner layout, point-to-point (no laps).
    drawGt4RaceBar(ctx, GW, {
      modeTag: 'DESCENT',
      curTime: run.elapsed,
      bestLap: run.bestLap,
      lastLap: run.lastLap,
    });
  } else if (run.phase === 'running' && run.spec.solo) {
    // H1092: solo best-lap timer — GT4 corner layout.
    drawGt4RaceBar(ctx, GW, {
      lap: run.lap + 1,
      laps: run.spec.laps ?? null,
      curTime: run.elapsed - run.lapStart,
      bestLap: run.bestLap,
      lastLap: run.lastLap,
    });
  } else if (run.phase === 'running') {
    // H1092: drag time / lap race / 1v1 — GT4 corner layout. Position is coarse
    // (lap-count compare) for 1v1 until per-car track progress is exposed here.
    const isDrag = run.spec.kind === 'drag';
    const laps = run.spec.laps ?? 3;
    drawGt4RaceBar(ctx, GW, {
      position: run.opp ? (run.lap >= run.opp.lap ? 1 : 2) : 1,
      lap: isDrag ? null : Math.min(run.lap + 1, laps),
      laps: isDrag ? null : laps,
      modeTag: isDrag ? `${run.spec.meters ?? 402} m` : null,
      curTime: isDrag ? run.elapsed : run.elapsed - run.lapStart,
      bestLap: run.bestLap,
      lastLap: run.lastLap,
      vs: run.opp ? run.opp.name : null,
    });
  } else if (run.phase === 'done') {
    const pw = 440, ph = 96, py = 46;
    panel(ctx, cx, py, pw, ph);
    ctx.fillStyle = run.winner === 'player' ? 'rgba(120,255,140,1)'
      : run.winner === 'opponent' ? 'rgba(255,110,110,1)'
      : `rgba(${AMBER},1)`;
    ctx.font = 'bold 17px monospace';
    ctx.fillText(run.result ?? 'FINISH', cx, py + 28);
    const bw = 160, bh = 32, gap = 18, by = py + 48;
    if (run.racedToday) {
      // H1029: one race per day used — only RETURN HOME.
      _homeBtn = { x: cx - bw / 2, y: by, w: bw, h: bh };
      _againBtn = null;
      button(ctx, _homeBtn, '🏠 RETURN HOME', '90,190,255');
    } else {
      _homeBtn = { x: cx - gap / 2 - bw, y: by, w: bw, h: bh };
      _againBtn = { x: cx + gap / 2, y: by, w: bw, h: bh };
      button(ctx, _homeBtn, '🏠 RETURN HOME', '90,190,255');
      button(ctx, _againBtn, '🏁 RACE AGAIN', '120,255,140');
    }
  }

  ctx.restore();
}

/** Hit-test the result-screen buttons (screen coords). Returns which action
 *  was tapped, or null. Only live while the result banner is up. */
export function trackRaceDoneButtonAt(tx: number, ty: number): 'home' | 'again' | null {
  // Only live while the result banner is actually up (guards against a stale
  // rect matching a tap after the run resets).
  if (getTrackRaceRun()?.phase !== 'done') return null;
  const hit = (r: Rect | null): boolean =>
    !!r && tx >= r.x && tx <= r.x + r.w && ty >= r.y && ty <= r.y + r.h;
  if (hit(_homeBtn)) return 'home';
  if (hit(_againBtn)) return 'again';
  return null;
}
