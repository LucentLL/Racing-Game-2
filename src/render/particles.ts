/**
 * H50 — particle pool: drift smoke + crash sparks.
 *
 * Ported from monolith _particles array + _spawnParticle / _spawnDriftSmoke /
 * _spawnCrashSparks / _updateParticles / _drawParticles
 * (L17712-17849).
 *
 * Two particle types so far:
 *   - driftSmoke: white puffs from the rear axle when braking hard or
 *                 burning out, paired with skid marks. ~500 ms life,
 *                 grows + fades.
 *   - crashSpark: yellow/orange single-pixel sparks at collision point,
 *                 6-10 per impact, decay exponentially over ~300 ms.
 *
 * Storage: a flat array, capped via age-out (no fixed cap — each
 * particle dies after maxLife and gets spliced out). Typical steady-
 * state count is small (~30-50 mid-brake), so the splice cost is
 * fine.
 *
 * H509: wreckSmoke ported (the dark rising plume from a broken
 * car's hood). Off-road dust was already wired in an earlier hop;
 * this finishes the catalog. The monolith also has hovercraft /
 * snowmobile / boat particles for special vehicles — those depend
 * on per-vehicle special-mode triggers that haven't ported yet.
 */

export type ParticleType = 'driftSmoke' | 'crashSpark' | 'offRoadDust' | 'wreckSmoke';

export interface Particle {
  type: ParticleType;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** ms elapsed since spawn. */
  life: number;
  /** ms total before particle is recycled. */
  maxLife: number;
  /** Current draw size (px). Mutated each frame when growthRate set. */
  size: number;
  /** Growth in size per second. */
  growthRate?: number;
  /** Exponential velocity decay per second. */
  decayRate?: number;
  /** Fixed color for sparks (smoke types pick their own gradient). */
  color?: string;
}

export interface ParticleState {
  particles: Particle[];
  /** H509: wall-clock timestamp (Date.now() ms) of the last
   *  wreck-smoke emission. The hood plume throttles to ~1 Hz so
   *  the column reads as a slow rising stack of puffs rather than
   *  a dense burst. Initialized to 0 — the first eligible frame
   *  fires immediately. Caller compares against Date.now() and
   *  bumps when a spawn fires. Matches monolith
   *  `_lastWreckSmokeT` at L17750. */
  lastWreckSmokeMs: number;
}

export function createParticleState(): ParticleState {
  return { particles: [], lastWreckSmokeMs: 0 };
}

/** White-ish drift smoke puff at (x, y). Pair with skid mark spawns. */
export function spawnDriftSmoke(state: ParticleState, x: number, y: number): void {
  const ang = Math.random() * Math.PI * 2;
  const drift = 8 + Math.random() * 6;
  state.particles.push({
    type: 'driftSmoke',
    x,
    y,
    vx: Math.cos(ang) * drift,
    vy: Math.sin(ang) * drift,
    life: 0,
    maxLife: 500,
    size: 1.4,
    growthRate: 16,
  });
}

/** H55 — tan/brown dust puff from a tire kicking up dirt off-road.
 *  Slightly slower drift than driftSmoke, longer life (700 ms), so the
 *  off-road trail reads as a brown cloud rather than a sharp white
 *  burst. */
export function spawnOffRoadDust(state: ParticleState, x: number, y: number): void {
  const ang = Math.random() * Math.PI * 2;
  const drift = 5 + Math.random() * 4;
  state.particles.push({
    type: 'offRoadDust',
    x,
    y,
    vx: Math.cos(ang) * drift,
    vy: Math.sin(ang) * drift,
    life: 0,
    maxLife: 700,
    size: 1.6,
    growthRate: 18,
  });
}

/** H509: dark-gray rising plume from a broken car's hood. The
 *  `LIFE.broken` breakdown state ticks ~1 Hz emission from a hood
 *  anchor point (35 % along the car's length toward the nose); the
 *  resulting plume rises upward (vy bias = -6) and disperses over
 *  ~2 s, reading as "smoke rising slowly off the engine bay" rather
 *  than the sharp white burst of [[spawnDriftSmoke]] or the
 *  warm-tan kick of [[spawnOffRoadDust]].
 *
 *  Caller responsibilities (in gameLoop's particle pass):
 *    - gate on LIFE.broken
 *    - throttle to ~1 Hz (next-spawn timestamp via Date.now())
 *    - resolve hood anchor (drawX + cos(pAngle) × bodyLen × 0.35)
 *
 *  Ported 1:1 from monolith _spawnWreckSmoke at L17751-L17766. */
export function spawnWreckSmoke(state: ParticleState, x: number, y: number): void {
  const ang = Math.random() * Math.PI * 2;
  const drift = 4 + Math.random() * 4;
  state.particles.push({
    type: 'wreckSmoke',
    x,
    y,
    vx: Math.cos(ang) * drift * 0.4,
    vy: Math.sin(ang) * drift * 0.4 - 6, // upward bias — plume rises
    life: 0,
    maxLife: 2000,
    size: 2.0,
    growthRate: 7,
  });
}

/** 6-10 sparks at a collision point. dmg in 0..1 (player.pSpeed /
 *  MAX_SPEED at impact). High-speed hits emit more sparks. */
export function spawnCrashSparks(state: ParticleState, x: number, y: number, dmg: number): void {
  const count = Math.min(10, 6 + Math.floor(dmg * 4));
  for (let i = 0; i < count; i++) {
    const ang = Math.random() * Math.PI * 2;
    const sp = 25 + Math.random() * 35;
    state.particles.push({
      type: 'crashSpark',
      x,
      y,
      vx: Math.cos(ang) * sp,
      vy: Math.sin(ang) * sp,
      life: 0,
      maxLife: 280 + Math.random() * 100,
      size: 1,
      decayRate: 4.0,
      color: Math.random() < 0.5 ? '#ffce40' : '#ff8020',
    });
  }
}

/** Per-frame tick — integrate position + size, decrement life, splice
 *  dead. dt in seconds. */
export function updateParticles(state: ParticleState, dt: number): void {
  const dtMs = dt * 1000;
  const list = state.particles;
  // Reverse iter so splice doesn't break index walking.
  for (let i = list.length - 1; i >= 0; i--) {
    const p = list[i];
    p.life += dtMs;
    if (p.life >= p.maxLife) {
      list.splice(i, 1);
      continue;
    }
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    if (p.decayRate) {
      const k = Math.exp(-p.decayRate * dt);
      p.vx *= k;
      p.vy *= k;
    }
    if (p.growthRate) {
      p.size += p.growthRate * dt;
    }
  }
}

/** Paint all particles within `radius` of (cx, cy). */
export function drawParticles(
  ctx: CanvasRenderingContext2D,
  state: ParticleState,
  cx: number,
  cy: number,
  radius: number,
): void {
  if (state.particles.length === 0) return;
  const r2 = radius * radius;
  const prevAlpha = ctx.globalAlpha;
  for (const p of state.particles) {
    const dx = p.x - cx;
    const dy = p.y - cy;
    if (dx * dx + dy * dy > r2) continue;
    const t = p.life / p.maxLife;
    if (p.type === 'driftSmoke') {
      ctx.globalAlpha = (1 - t) * 0.55;
      ctx.fillStyle = '#e8e8e8';
      const sz = p.size;
      ctx.fillRect(p.x - sz / 2, p.y - sz / 2, sz, sz);
    } else if (p.type === 'crashSpark') {
      ctx.globalAlpha = 1 - t * t;
      ctx.fillStyle = p.color ?? '#ffce40';
      ctx.fillRect(p.x - 0.5, p.y - 0.5, 1.5, 1.5);
    } else if (p.type === 'offRoadDust') {
      // Tan-brown puff, similar fade curve to drift smoke. Slightly
      // warmer color so it reads as kicked-up dirt vs tire smoke.
      ctx.globalAlpha = (1 - t) * 0.5;
      // Shade shifts from warm tan to cooler taupe as the puff drifts.
      const r = Math.round(170 - t * 30);
      const g = Math.round(140 - t * 30);
      const b = Math.round(90  - t * 30);
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      const sz = p.size;
      ctx.fillRect(p.x - sz / 2, p.y - sz / 2, sz, sz);
    } else if (p.type === 'wreckSmoke') {
      // H509: dark gray, slower fade than drift, more opaque early.
      // Color shifts slightly lighter (cooler) as the plume disperses
      // — reads as wisps thinning out vs the dense hood-emission core.
      // Matches monolith L17811-L17821:
      //   alpha = (1 - t) × 0.65
      //   shade = 50 + t × 40           (50 dark → 90 lighter)
      ctx.globalAlpha = (1 - t) * 0.65;
      const shade = Math.floor(50 + t * 40);
      ctx.fillStyle = `rgb(${shade},${shade},${shade})`;
      const sz = p.size;
      ctx.fillRect(p.x - sz / 2, p.y - sz / 2, sz, sz);
    }
  }
  ctx.globalAlpha = prevAlpha;
}
