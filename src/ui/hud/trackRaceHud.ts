/**
 * H1014: HUD for the solo timed track run (see sim/trackRace.ts). Drawn in
 * screen space during the playing HUD pass; pulls the run state itself and
 * no-ops off a test track. Amber GT2-ish styling.
 */
import { getTrackRaceRun } from '@/sim/trackRace';

const AMBER = '255, 180, 60';

function panel(
  ctx: CanvasRenderingContext2D, cx: number, y: number, w: number, h: number,
): void {
  ctx.fillStyle = `rgba(10, 8, 2, 0.72)`;
  ctx.fillRect(cx - w / 2, y, w, h);
  ctx.strokeStyle = `rgba(${AMBER}, 0.9)`;
  ctx.lineWidth = 2;
  ctx.strokeRect(cx - w / 2, y, w, h);
}

export function drawTrackRaceHud(ctx: CanvasRenderingContext2D, GW: number, GH: number): void {
  const run = getTrackRaceRun();
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
    const sub = run.spec.kind === 'drag'
      ? `Quarter mile · ${run.spec.meters ?? 402} m timed run`
      : `${run.spec.laps ?? 3} laps · best-lap timed`;
    ctx.fillText(sub, cx, 92);
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
    const line = run.spec.kind === 'drag'
      ? `${run.spec.meters ?? 402} m`
      : `LAP ${Math.min(run.lap + 1, run.spec.laps ?? 3)}/${run.spec.laps ?? 3}`
        + (run.bestLap != null ? ` · best ${run.bestLap.toFixed(2)}s` : '');
    ctx.fillText(line, cx, 102);
    if (run.opp) {
      ctx.fillStyle = 'rgba(255,120,120,0.9)';
      ctx.font = '10px monospace';
      ctx.fillText(`vs ${run.opp.name}`, cx, 118);
    }
  } else if (run.phase === 'done') {
    panel(ctx, cx, 50, 420, 56);
    // Green win / red loss / amber solo time.
    ctx.fillStyle = run.winner === 'player' ? 'rgba(120,255,140,1)'
      : run.winner === 'opponent' ? 'rgba(255,110,110,1)'
      : `rgba(${AMBER},1)`;
    ctx.font = 'bold 17px monospace';
    ctx.fillText(run.result ?? 'FINISH', cx, 76);
    ctx.fillStyle = 'rgba(220,220,200,0.8)';
    ctx.font = '10px monospace';
    ctx.fillText('Return to staging to run again', cx, 94);
  }

  ctx.restore();
}
