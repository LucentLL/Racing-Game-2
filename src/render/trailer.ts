/**
 * 53' trailer (TRUCK DRIVER job). Renders the trailer body behind the
 * player's semi cab when LIFE.trailer is non-null. Two body variants —
 * tanker (cylindrical with bands + catwalk + valve box + FLAMMABLE
 * diamond) and box (corrugated van with rear doors + DOT reflectors).
 *
 * X-Ray Body mode (LIFE.gameplaySettings.xrayBody) hides the body,
 * shadow, and undercarriage and keeps only the dashed cyan outline +
 * yellow tires — for diagnosing tire/axle alignment without the body
 * occluding the view.
 *
 * Ported from render() L32148–32357 of the v8.99.126.89 monolith. The
 * trailer's taillight glow + headlight beams + bridge interactions live
 * with the night pass (C18b).
 */

export type TrailerType = 'tanker' | 'box' | string;

export interface TrailerState {
  /** World heading of the trailer body (independent of cab pAngle
   *  during jackknife). */
  angle: number;
  /** Length and width in world units. 53' trailer = ~58 × 9 world units. */
  length: number;
  width: number;
  /** 'tanker' = cylindrical fluid trailer with FLAMMABLE diamond;
   *  'box' (and anything else) = van trailer. */
  trailerType: TrailerType;
}

export interface TrailerDeps {
  trailer: TrailerState | null;
  /** Player cab draw position (= drawX/drawY in monolith). */
  drawX: number;
  drawY: number;
  pAngle: number;
  /** Player's cab size [length, width] (CAR().size). */
  cabSize: readonly [number, number];
  /** Night factor 0..1 — drives taillight glow alpha when emitted by the
   *  body. v126.89 trailer.ts renders taillights inside each variant. */
  nf: number;
  /** True when player is on the brake pedal OR e-brake. Brightens
   *  taillights and adds the wide center brake bar. */
  braking: boolean;
  /** X-ray body mode (LIFE.gameplaySettings.xrayBody). */
  xrayBody: boolean;
}

export function drawTrailer(
  ctx: CanvasRenderingContext2D,
  deps: TrailerDeps,
): void {
  const tr = deps.trailer;
  if (!tr) return;

  const { drawX, drawY, pAngle, nf, braking, xrayBody } = deps;
  // Fifth-wheel mount: 6 world units behind the cab pivot.
  const fwX = drawX - Math.cos(pAngle) * 6;
  const fwY = drawY - Math.sin(pAngle) * 6;
  const trCX = fwX - Math.cos(tr.angle) * (tr.length / 2);
  const trCY = fwY - Math.sin(tr.angle) * (tr.length / 2);

  ctx.save();
  ctx.translate(trCX, trCY);
  ctx.rotate(tr.angle);
  const tL = tr.length;
  const tW = tr.width;
  const tHL = tL / 2;
  const tHW = tW / 2;

  // ---- Shadow + undercarriage (skipped in xray) -------------------------
  if (!xrayBody) {
    ctx.fillStyle = 'rgba(0,0,0,0.2)';
    ctx.fillRect(-tHL + 1, -tHW + 1, tL, tW);
    // Landing gear (front, near fifth wheel).
    ctx.fillStyle = '#555';
    ctx.fillRect(tHL - 3, -tHW - 1, 2, 2);
    ctx.fillRect(tHL - 3,  tHW - 1, 2, 2);
    // Side undercarriage rails.
    ctx.fillStyle = '#444';
    ctx.fillRect(-tHL + 5, -tHW - 0.5, tL * 0.3, 1.5);
    ctx.fillRect(-tHL + 5,  tHW - 1,   tL * 0.3, 1.5);
  }

  // ---- Wheels (tandem axles, 295/75R22.5 duals) -------------------------
  const dtDia = 4.5;
  const dtSingleW = xrayBody ? 2 : 1.4;
  const dtGap = 0.3;
  const dtInset = 0.3;
  if (!xrayBody) {
    ctx.fillStyle = '#444';
    for (const ax of [-tHL + 8 + dtDia * 0.4, -tHL + 14 + dtDia * 0.4]) {
      ctx.fillRect(ax, -tHW + dtInset, 0.6, tW - dtInset * 2);
    }
  }
  ctx.fillStyle = xrayBody ? '#ff0' : '#111';
  for (const ax of [-tHL + 8, -tHL + 14]) {
    ctx.fillRect(ax, -tHW + dtInset, dtDia, dtSingleW);
    ctx.fillRect(ax, -tHW + dtInset + dtSingleW + dtGap, dtDia, dtSingleW);
    ctx.fillRect(ax, tHW - dtInset - dtSingleW, dtDia, dtSingleW);
    ctx.fillRect(ax, tHW - dtInset - dtSingleW * 2 - dtGap, dtDia, dtSingleW);
  }

  // ---- Body — type-specific rendering -----------------------------------
  const isTanker = tr.trailerType === 'tanker';

  if (xrayBody) {
    // Dashed cyan outline only.
    ctx.strokeStyle = 'rgba(0,255,255,0.35)';
    ctx.lineWidth = 0.5;
    ctx.setLineDash([2, 2]);
    if (isTanker) {
      const tankR = tHW * 0.85;
      const tankFL = tHL - tankR;
      ctx.beginPath();
      ctx.moveTo(-tankFL, -tankR);
      ctx.lineTo( tankFL, -tankR);
      ctx.arc( tankFL, 0, tankR, -Math.PI / 2, Math.PI / 2);
      ctx.lineTo(-tankFL, tankR);
      ctx.arc(-tankFL, 0, tankR,  Math.PI / 2, Math.PI * 1.5);
      ctx.closePath();
      ctx.stroke();
    } else {
      ctx.strokeRect(-tHL, -tHW, tL, tW);
    }
    ctx.setLineDash([]);
  } else if (isTanker) {
    drawTankerBody(ctx, tHL, tHW, tL, tW, nf, braking);
  } else {
    drawBoxBody(ctx, tHL, tHW, tL, tW, nf, braking);
  }

  ctx.restore();

  // ---- Fifth-wheel coupling line (in world space) ------------------------
  ctx.strokeStyle = '#555';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(fwX, fwY);
  ctx.lineTo(fwX - Math.cos(tr.angle) * 4, fwY - Math.sin(tr.angle) * 4);
  ctx.stroke();
}

function drawTankerBody(
  ctx: CanvasRenderingContext2D,
  tHL: number, tHW: number, tL: number, tW: number,
  nf: number, braking: boolean,
): void {
  // Frame rails behind tank.
  ctx.fillStyle = '#3a3a3a';
  ctx.fillRect(-tHL, -tHW * 0.4, tL, tW * 0.4);
  // Cylindrical body (rounded rectangle with semicircle ends).
  const tankR = tHW * 0.85;
  const tankFL = tHL - tankR;
  ctx.fillStyle = '#c8c8c8';
  ctx.beginPath();
  ctx.moveTo(-tankFL, -tankR);
  ctx.lineTo( tankFL, -tankR);
  ctx.arc( tankFL, 0, tankR, -Math.PI / 2, Math.PI / 2);
  ctx.lineTo(-tankFL, tankR);
  ctx.arc(-tankFL, 0, tankR,  Math.PI / 2, Math.PI * 1.5);
  ctx.closePath();
  ctx.fill();
  // Top reflection strip.
  ctx.fillStyle = '#e0e0e0';
  ctx.fillRect(-tankFL, -tankR * 0.45, tankFL * 2, tankR * 0.35);
  // Circumferential bands.
  ctx.strokeStyle = '#999';
  ctx.lineWidth = 0.5;
  for (let i = -tHL + 10; i < tHL - 6; i += 8) {
    ctx.beginPath();
    ctx.moveTo(i, -tHW * 0.8);
    ctx.lineTo(i,  tHW * 0.8);
    ctx.stroke();
  }
  // End-cap weld seams.
  ctx.strokeStyle = '#aaa';
  ctx.lineWidth = 0.5;
  ctx.beginPath(); ctx.moveTo(-tankFL, -tankR); ctx.lineTo(-tankFL, tankR); ctx.stroke();
  ctx.beginPath(); ctx.moveTo( tankFL, -tankR); ctx.lineTo( tankFL, tankR); ctx.stroke();
  // Catwalk on top.
  ctx.fillStyle = '#777';
  ctx.fillRect(-tHL * 0.3, -1, tHL * 0.6, 2);
  // Manhole/dome cover.
  ctx.fillStyle = '#888';
  ctx.beginPath();
  ctx.arc(tHL * 0.2, 0, 1.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#666';
  ctx.lineWidth = 0.3;
  ctx.stroke();
  // Valve box (rear).
  ctx.fillStyle = '#555';
  ctx.fillRect(-tHL + 1, -2, 2, 4);
  // Rear bumper.
  ctx.fillStyle = '#666';
  ctx.fillRect(-tHL - 1, -tHW * 0.6, 1.5, tW * 0.6);
  // Brake / tail lights.
  ctx.fillStyle = braking ? '#f44' : (nf > 0.05 ? '#ff3300' : '#aa0000');
  ctx.fillRect(-tHL - 1, -tHW * 0.7, 2, 1.5);
  ctx.fillRect(-tHL - 1,  tHW * 0.7 - 1.5, 2, 1.5);
  if (braking) {
    ctx.fillStyle = '#f44';
    ctx.fillRect(-tHL - 1, -tHW * 0.2, 2, tW * 0.2);
  }
  // Taillight glow.
  if (nf > 0.05 || braking) {
    const ttlR = 2 + nf * 4 + (braking ? 4 : 0);
    const ttlA = braking ? 0.6 : nf * 0.35;
    const ttlC = braking ? '255,60,40' : '255,40,0';
    for (const ts of [-1, 1]) {
      const tgy = ts * (tHW * 0.7);
      const tgrd = ctx.createRadialGradient(-tHL, tgy, 0, -tHL, tgy, ttlR);
      tgrd.addColorStop(0, `rgba(${ttlC},${ttlA})`);
      tgrd.addColorStop(1, `rgba(${ttlC},0)`);
      ctx.fillStyle = tgrd;
      ctx.fillRect(-tHL - ttlR, tgy - ttlR, ttlR * 2, ttlR * 2);
    }
  }
  // DOT reflectors.
  ctx.fillStyle = 'rgba(255,50,0,0.6)';
  ctx.fillRect(-tHL + 18, -tHW * 0.8, 1, 1);
  ctx.fillRect(-tHL + 18,  tHW * 0.8 - 1, 1, 1);
  ctx.fillRect(-tHL + 36, -tHW * 0.8, 1, 1);
  ctx.fillRect(-tHL + 36,  tHW * 0.8 - 1, 1, 1);
  // Mud flaps.
  ctx.fillStyle = '#222';
  ctx.fillRect(-tHL + 4, -tHW * 0.85 - 2, 1, 2);
  ctx.fillRect(-tHL + 4,  tHW * 0.85,     1, 2);
  // FLAMMABLE diamond placeholder.
  ctx.fillStyle = '#e22';
  ctx.save();
  ctx.translate(tHL * 0.5, 0);
  ctx.rotate(Math.PI / 4);
  ctx.fillRect(-1.2, -1.2, 2.4, 2.4);
  ctx.restore();
}

function drawBoxBody(
  ctx: CanvasRenderingContext2D,
  tHL: number, tHW: number, tL: number, tW: number,
  nf: number, braking: boolean,
): void {
  // Body fill.
  ctx.fillStyle = '#ddd';
  ctx.fillRect(-tHL, -tHW, tL, tW);
  // Darker side panels.
  ctx.fillStyle = '#bbb';
  ctx.fillRect(-tHL, -tHW,        tL, 1.5);
  ctx.fillRect(-tHL,  tHW - 1.5,  tL, 1.5);
  // Corrugated side lines.
  ctx.strokeStyle = '#aaa';
  ctx.lineWidth = 0.3;
  for (let i = -tHL + 6; i < tHL - 4; i += 5) {
    ctx.beginPath();
    ctx.moveTo(i, -tHW + 1.5);
    ctx.lineTo(i,  tHW - 1.5);
    ctx.stroke();
  }
  // Rear doors.
  ctx.fillStyle = '#999';
  ctx.fillRect(-tHL, -tHW + 1, 3, tW - 2);
  ctx.strokeStyle = '#777';
  ctx.lineWidth = 0.5;
  ctx.strokeRect(-tHL, -tHW + 1, 3, tW / 2 - 1);
  ctx.strokeRect(-tHL,  0,        3, tW / 2 - 1);
  // Door handles.
  ctx.fillStyle = '#666';
  ctx.fillRect(-tHL + 2, -2, 1, 1);
  ctx.fillRect(-tHL + 2,  1, 1, 1);
  // Brake / tail lights.
  ctx.fillStyle = braking ? '#f44' : (nf > 0.05 ? '#ff3300' : '#aa0000');
  ctx.fillRect(-tHL - 1, -tHW,        2, 1.5);
  ctx.fillRect(-tHL - 1,  tHW - 1.5,  2, 1.5);
  if (braking) {
    ctx.fillStyle = '#f44';
    ctx.fillRect(-tHL - 1, -tHW * 0.3, 2, tW * 0.3);
  }
  // Taillight glow.
  if (nf > 0.05 || braking) {
    const btlR = 2 + nf * 4 + (braking ? 4 : 0);
    const btlA = braking ? 0.6 : nf * 0.35;
    const btlC = braking ? '255,60,40' : '255,40,0';
    for (const bs of [-1, 1]) {
      const bgy = bs * tHW;
      const bgrd = ctx.createRadialGradient(-tHL, bgy, 0, -tHL, bgy, btlR);
      bgrd.addColorStop(0, `rgba(${btlC},${btlA})`);
      bgrd.addColorStop(1, `rgba(${btlC},0)`);
      ctx.fillStyle = bgrd;
      ctx.fillRect(-tHL - btlR, bgy - btlR, btlR * 2, btlR * 2);
    }
  }
  // DOT reflectors.
  ctx.fillStyle = 'rgba(255,50,0,0.6)';
  ctx.fillRect(-tHL + 22, -tHW + 0.3, 1, 1);
  ctx.fillRect(-tHL + 22,  tHW - 1.3, 1, 1);
  ctx.fillRect(-tHL + 44, -tHW + 0.3, 1, 1);
  ctx.fillRect(-tHL + 44,  tHW - 1.3, 1, 1);
  // Mud flaps.
  ctx.fillStyle = '#222';
  ctx.fillRect(-tHL + 4, -tHW - 2, 1, 2);
  ctx.fillRect(-tHL + 4,  tHW,     1, 2);
}
