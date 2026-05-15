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
 * Wreck smoke + dust puffs from the monolith's particle catalog are
 * deferred (no wreck or off-road dust trigger ports yet).
 */

export type ParticleType = 'driftSmoke' | 'crashSpark';

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
}

export function createParticleState(): ParticleState {
  return { particles: [] };
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
    }
  }
  ctx.globalAlpha = prevAlpha;
}
