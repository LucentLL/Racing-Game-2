/**
 * H1247: START-LINE confirm bar.
 *
 * The player picks a session in the pit garage (Test Lap / Qualify / Start
 * Race), drives out, and stops on the start/finish line. This is the button
 * that actually begins it — the same tick → rect → draw → hit-test contract
 * every other drive prompt uses (ui/hud/parkHint.ts is the model).
 *
 * Deliberately NOT automatic: the session used to arm the moment you rolled
 * slowly through the zone, which meant crossing the line at walking pace
 * during a lap could start a race you hadn't asked for.
 */

export type TrackStartMode = 'testlap' | 'qualify' | 'race';

export interface TrackStartLife {
  _trackStartPrompt?: TrackStartMode | null;
  _trackStartArm?: boolean;
}

const LABEL: Record<TrackStartMode, string> = {
  testlap: '🏁 BEGIN TEST LAP  (ENTER)',
  qualify: '⏱ BEGIN QUALIFYING  (ENTER)',
  race: '🚦 START RACE  (ENTER)',
};

/** Sits just above the PARK band (which is at max(GH*0.6, GH*0.5+32)) so the
 *  two can never collide on a short landscape viewport. */
export function trackStartRect(GW: number, GH: number): {
  x: number; y: number; w: number; h: number;
} {
  return {
    x: GW / 2 - 104,
    y: Math.max(GH * 0.6, GH * 0.5 + 32) - 32,
    w: 208,
    h: 26,
  };
}

export function drawTrackStartHint(
  ctx: CanvasRenderingContext2D,
  life: TrackStartLife | null,
  GW: number,
  GH: number,
  blocked: boolean,
): void {
  const mode = life?._trackStartPrompt;
  if (!mode || blocked) return;
  const hb = Math.sin(Date.now() * 0.005) > 0;
  if (!hb) return;
  const { x, y, w, h } = trackStartRect(GW, GH);
  ctx.fillStyle = 'rgba(120, 220, 90, 0.25)';
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = '#78dc5a';
  ctx.lineWidth = 2;
  ctx.strokeRect(x, y, w, h);
  ctx.fillStyle = 'rgba(170, 255, 140, 0.97)';
  ctx.font = 'bold 11px monospace';
  ctx.textAlign = 'center';
  ctx.fillText(LABEL[mode], GW / 2, y + 17);
  ctx.textAlign = 'left';
  ctx.lineWidth = 1;
}

export function isTrackStartHit(tx: number, ty: number, GW: number, GH: number): boolean {
  const { x, y, w, h } = trackStartRect(GW, GH);
  return tx >= x && tx <= x + w && ty >= y && ty <= y + h;
}
