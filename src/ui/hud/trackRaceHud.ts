/**
 * H1014/H1016/H1019: HUD for the track run — staging prompt, big countdown,
 * live timer + rival line, and a result banner with RETURN HOME / RACE AGAIN
 * buttons. Drawn in screen space during the playing HUD pass; pulls the run
 * state itself and no-ops off a test track.
 */
import { getTrackRaceRun } from '@/sim/trackRace';

const AMBER = '255, 180, 60';

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
    panel(ctx, cx, 58, 340, 42);
    ctx.fillStyle = `rgba(${AMBER}, 0.98)`;
    ctx.font = 'bold 13px monospace';
    ctx.fillText('🏁 DRIVE INTO STAGING TO START', cx, 78);
    ctx.fillStyle = 'rgba(220,220,200,0.8)';
    ctx.font = '10px monospace';
    ctx.fillText(run.spec.kind === 'drag'
      ? `Quarter mile · ${run.spec.meters ?? 402} m timed run`
      : `${run.spec.laps ?? 3} laps · best-lap timed`, cx, 92);
  } else if (run.phase === 'countdown') {
    const n = Math.max(1, Math.ceil(run.countdown));
    ctx.fillStyle = `rgba(${AMBER}, 0.98)`;
    ctx.font = 'bold 72px monospace';
    ctx.fillText(String(n), cx, GH * 0.42);
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
    _homeBtn = { x: cx - gap / 2 - bw, y: by, w: bw, h: bh };
    _againBtn = { x: cx + gap / 2, y: by, w: bw, h: bh };
    button(ctx, _homeBtn, '🏠 RETURN HOME', '90,190,255');
    button(ctx, _againBtn, '🏁 RACE AGAIN', '120,255,140');
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
