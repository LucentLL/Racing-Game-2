/**
 * H17 traffic render — paints each TrafficCar as a colored rounded
 * rectangle (matching the player triangle's CAR_LEN/CAR_W ratio) in
 * world space. Caller has applied the camera translate already.
 *
 * Per-frame cost: ~24 rotate + 1 fillRect + 1 strokeRect per car ≈
 * trivial. No culling — the world is big but the cost is bounded.
 */

import type { TrafficCar } from '@/state/traffic';

const TRAFFIC_LEN = 16;
const TRAFFIC_W = 10;

export function drawTraffic(ctx: CanvasRenderingContext2D, cars: readonly TrafficCar[]): void {
  ctx.lineWidth = 1;
  for (const car of cars) {
    ctx.save();
    ctx.translate(car.px, car.py);
    ctx.rotate(car.pAngle);
    ctx.fillStyle = car.color;
    ctx.fillRect(-TRAFFIC_LEN / 2, -TRAFFIC_W / 2, TRAFFIC_LEN, TRAFFIC_W);
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.strokeRect(-TRAFFIC_LEN / 2, -TRAFFIC_W / 2, TRAFFIC_LEN, TRAFFIC_W);
    // Small windshield strip up-front so heading is unambiguous.
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.fillRect(TRAFFIC_LEN / 2 - 4, -TRAFFIC_W / 2 + 1, 2, TRAFFIC_W - 2);
    ctx.restore();
  }
}
