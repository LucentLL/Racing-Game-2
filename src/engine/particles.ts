export type ParticleType = 'driftSmoke' | 'crashSpark' | 'wreckSmoke';

export interface Particle {
  type: ParticleType;
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
  growthRate?: number;
  decayRate?: number;
  color?: string;
}

const PARTICLE_CAP = 120;

const particles: Particle[] = [];

export function getParticles(): readonly Particle[] {
  return particles;
}

function spawnParticle(p: Particle): void {
  if (particles.length >= PARTICLE_CAP) particles.shift();
  particles.push(p);
}

export function spawnDriftSmoke(x: number, y: number): void {
  const ang = Math.random() * Math.PI * 2;
  const drift = 8 + Math.random() * 6;
  spawnParticle({
    type: 'driftSmoke',
    x, y,
    vx: Math.cos(ang) * drift,
    vy: Math.sin(ang) * drift,
    life: 0,
    maxLife: 500,
    size: 1.4,
    growthRate: 16,
  });
}

export function spawnCrashSparks(x: number, y: number, dmg: number): void {
  const count = Math.min(10, 6 + Math.floor(dmg * 0.8));
  for (let i = 0; i < count; i++) {
    const ang = Math.random() * Math.PI * 2;
    const sp = 25 + Math.random() * 35;
    spawnParticle({
      type: 'crashSpark',
      x, y,
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

export function spawnWreckSmoke(x: number, y: number): void {
  const ang = Math.random() * Math.PI * 2;
  const drift = 4 + Math.random() * 4;
  spawnParticle({
    type: 'wreckSmoke',
    x, y,
    vx: Math.cos(ang) * drift * 0.4,
    vy: Math.sin(ang) * drift * 0.4 - 6,
    life: 0,
    maxLife: 2000,
    size: 2.0,
    growthRate: 7,
  });
}

export function updateParticles(dt: number): void {
  const dtMs = dt * 1000;
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.life += dtMs;
    if (p.life >= p.maxLife) {
      particles.splice(i, 1);
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

export function drawParticles(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  viewR2: number,
): void {
  if (particles.length === 0) return;
  ctx.save();
  for (const p of particles) {
    const dx = p.x - cx;
    const dy = p.y - cy;
    if (dx * dx + dy * dy > viewR2) continue;
    const t = p.life / p.maxLife;
    if (p.type === 'driftSmoke') {
      const a = (1 - t) * 0.55;
      ctx.globalAlpha = a;
      ctx.fillStyle = '#e8e8e8';
      const sz = p.size;
      ctx.fillRect(p.x - sz / 2, p.y - sz / 2, sz, sz);
    } else if (p.type === 'crashSpark') {
      const a = 1 - t * t;
      ctx.globalAlpha = a;
      ctx.fillStyle = p.color ?? '#ffce40';
      ctx.fillRect(p.x - 0.5, p.y - 0.5, 1.5, 1.5);
    } else if (p.type === 'wreckSmoke') {
      const a = (1 - t) * 0.65;
      ctx.globalAlpha = a;
      const shade = Math.floor(50 + t * 40);
      ctx.fillStyle = `rgb(${shade},${shade},${shade})`;
      const sz = p.size;
      ctx.fillRect(p.x - sz / 2, p.y - sz / 2, sz, sz);
    }
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

export function clearParticles(): void {
  particles.length = 0;
}
