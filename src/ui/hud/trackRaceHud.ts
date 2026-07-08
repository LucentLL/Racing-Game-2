/**
 * H1014/H1016/H1019: HUD for the track run — staging prompt, big countdown,
 * live timer + rival line, and a result banner with RETURN HOME / RACE AGAIN
 * buttons. Drawn in screen space during the playing HUD pass; pulls the run
 * state itself and no-ops off a test track.
 */
import { getTrackRaceRun } from '@/sim/trackRace';

const AMBER = '255, 180, 60';

/** Lap/elapsed time as m:ss.ss (or ss.ss under a minute) — racing-readout style. */
function fmtTime(s: number): string {
  if (s < 60) return `${s.toFixed(2)}s`;
  const m = Math.floor(s / 60);
  const rem = s - m * 60;
  return `${m}:${rem < 10 ? '0' : ''}${rem.toFixed(2)}`;
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

export function drawTrackRaceHud(ctx: CanvasRenderingContext2D, GW: number, GH: number): void {
  const run = getTrackRaceRun();
  if (!run || run.phase !== 'done') { _homeBtn = null; _againBtn = null; }
  if (!run) return;
  const cx = GW / 2;
  ctx.save();
  ctx.textAlign = 'center';

  if (run.phase === 'idle') {
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
  } else if (run.phase === 'running' && run.spec.solo) {
    // H1086: solo best-lap timer — big CURRENT lap time + lap count + best/last.
    const cur = run.elapsed - run.lapStart;
    panel(ctx, cx, 50, 260, 80);
    ctx.fillStyle = `rgba(${AMBER}, 1)`;
    ctx.font = 'bold 30px monospace';
    ctx.fillText(fmtTime(cur), cx, 84);
    ctx.fillStyle = 'rgba(220,220,200,0.85)';
    ctx.font = 'bold 11px monospace';
    ctx.fillText(`LAP ${run.lap + 1}`, cx, 102);
    ctx.font = '10px monospace';
    const best = run.bestLap != null ? fmtTime(run.bestLap) : '—';
    const last = run.lastLap != null ? fmtTime(run.lastLap) : '—';
    ctx.fillStyle = 'rgba(120,255,140,0.92)';
    ctx.fillText(`BEST ${best}    LAST ${last}`, cx, 118);
  } else if (run.phase === 'running') {
    const h = run.opp ? 78 : 62;
    panel(ctx, cx, 50, 260, h);
    ctx.fillStyle = `rgba(${AMBER}, 1)`;
    ctx.font = 'bold 30px monospace';
    ctx.fillText(`${run.elapsed.toFixed(2)}s`, cx, 84);
    ctx.fillStyle = 'rgba(220,220,200,0.85)';
    ctx.font = 'bold 11px monospace';
    ctx.fillText(run.spec.kind === 'drag'
      ? `${run.spec.meters ?? 402} m`
      : `LAP ${Math.min(run.lap + 1, run.spec.laps ?? 3)}/${run.spec.laps ?? 3}`
        + (run.bestLap != null ? ` · best ${run.bestLap.toFixed(2)}s` : ''), cx, 102);
    if (run.opp) {
      ctx.fillStyle = 'rgba(255,120,120,0.9)';
      ctx.font = '10px monospace';
      ctx.fillText(`vs ${run.opp.name}`, cx, 118);
    }
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
