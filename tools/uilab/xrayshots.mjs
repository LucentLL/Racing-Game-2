// H1282 visual verify: sprite vs X-ray registration.
// Boots the dev build headless (tools/uilab/boot.mjs), swaps the active car
// through a list of catalog ids, and captures a tight screenshot pair per
// car — sprite view and X-ray view at the SAME pose — so the traced outline
// can be eyeballed against the art it claims to match.
// Usage: npm run dev, then  node tools/uilab/xrayshots.mjs [outDir]
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { bootToPlaying, sleep } from './boot.mjs';

const OUT = process.argv[2] ?? '.';
const CARS = [
  ['nsx', 'acura_nsx__91'],
  ['r34', 'nissan_skyline_gt_r__r34___99'],
  ['quattro', 'audi_quattro__82'],
  ['ae86', 'toyota_sprinter_trueno_gt_apex__ae86___83'],
];

const { send, evaluate, sessionId, kill } = await bootToPlaying();
try {
  // Daylight, overlay closed, rolling slowly on open ground (a moving car
  // keeps the PARK/START-ENGINE bar out of frame; the chase camera pins the
  // car to the same screen anchor regardless).
  await evaluate(`(() => {
    const ctx = window.__dc.ctx;
    ctx.home.open = false;
    ctx.clock.timeOfDay = 0.5;
    ctx.player.px += 260; ctx.player.py += 40;
    ctx.player.pSpeed = 0; ctx.player.pAngle = 0;
    if (ctx.life) ctx.life.engineOff = false;
    ctx.inputHeld.gas = true;
    return 'ok';
  })()`);
  await sleep(900);

  // The drive camera anchors the car at (0.5, ~0.675) of the viewport.
  const clip = await evaluate(`(() => {
    const r = window.__dc.hudCanvas.getBoundingClientRect();
    return { x: Math.max(0, r.left + r.width / 2 - 130), y: Math.max(0, r.top + r.height * 0.675 - 130) };
  })()`);

  for (const [label, id] of CARS) {
    const okId = await evaluate(`(() => {
      const ctx = window.__dc.ctx;
      ctx.life.ownedCars[0] = '${id}';
      return ctx.life.ownedCars[0];
    })()`);
    for (const [suffix, xray] of [['sprite', false], ['xray', true]]) {
      await evaluate(`window.__dc.ctx.life.gameplaySettings.xrayBody = ${xray}; 'x'`);
      await sleep(500);
      const shot = await send('Page.captureScreenshot', {
        format: 'png',
        clip: { x: clip.x, y: clip.y, width: 260, height: 260, scale: 2 },
      }, sessionId);
      writeFileSync(path.join(OUT, `xray_${label}_${suffix}.png`), Buffer.from(shot.data, 'base64'));
    }
    console.log(`captured ${label} (${okId})`);
  }
} finally { kill(); }
console.log('done ->', OUT);
