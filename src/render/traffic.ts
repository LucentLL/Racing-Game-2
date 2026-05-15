/**
 * H17/H28 traffic render — paints each TrafficCar as its picked /cars/
 * PNG sprite when the image is loaded, else falls back to the H17
 * colored rectangle (matching the player triangle's CAR_LEN/CAR_W
 * ratio) in world space. Caller has applied the camera translate
 * already.
 *
 * Per-frame cost: ~24 rotate + 1 drawImage (or 1 fillRect + 1
 * strokeRect) per car ≈ trivial. No culling — the world is big but
 * the cost is bounded.
 */

import type { TrafficCar } from '@/state/traffic';
import { getCarSprite } from './carSprites';

const TRAFFIC_LEN = 16;
const TRAFFIC_W = 10;

export function drawTraffic(ctx: CanvasRenderingContext2D, cars: readonly TrafficCar[]): void {
  ctx.lineWidth = 1;
  for (const car of cars) {
    ctx.save();
    ctx.translate(car.px, car.py);
    ctx.rotate(car.pAngle);

    // Sprite path when the picked PNG is ready.
    const sprite = car.spriteFile ? getCarSprite(car.spriteFile) : null;
    if (sprite && sprite.complete && sprite.naturalWidth > 0) {
      const smPrev = ctx.imageSmoothingEnabled;
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(sprite, -TRAFFIC_LEN / 2, -TRAFFIC_W / 2, TRAFFIC_LEN, TRAFFIC_W);
      ctx.imageSmoothingEnabled = smPrev;
      ctx.restore();
      continue;
    }

    // H17 fallback: colored rect with windshield strip.
    ctx.fillStyle = car.color;
    ctx.fillRect(-TRAFFIC_LEN / 2, -TRAFFIC_W / 2, TRAFFIC_LEN, TRAFFIC_W);
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.strokeRect(-TRAFFIC_LEN / 2, -TRAFFIC_W / 2, TRAFFIC_LEN, TRAFFIC_W);
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.fillRect(TRAFFIC_LEN / 2 - 4, -TRAFFIC_W / 2 + 1, 2, TRAFFIC_W - 2);
    ctx.restore();
  }
}
