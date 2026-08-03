// H1315 visual verify: the HUD city map's zoom ladder.
// Walks CITY / x2 / x4 / x8 via the real G key (not by poking the flag), shots
// each, and times the road re-bake at the deepest level - that bake is the one
// cost the zoom adds, and it must stay a one-off on the zoom press rather than
// a per-frame tax while driving.
// Usage: npm run dev, then  node tools/uilab/citymapzoom.mjs [outDir]
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { bootToPlaying, sleep } from './boot.mjs';

const OUT = process.argv[2] ?? '.';

const { send, evaluate, sessionId, kill } = await bootToPlaying();
try {
  await send('Emulation.setDeviceMetricsOverride',
    { width: 880, height: 460, deviceScaleFactor: 2, mobile: true }, sessionId);
  await sleep(1000);
  // The layout the request came from, and a spot with real street density
  // around it so zoom has something to reveal.
  await evaluate(`(() => {
    const ctx = window.__dc.ctx;
    const gp = ctx.life.gameplaySettings;
    ctx.home.open = false; ctx.clock.timeOfDay = 0.5;
    ctx.life._pagerPopFrames = 0;
    gp.steeringOrientation = 1; gp.hudScale = 0.55;
    gp.hudMapOpen = false; gp.hudMapClear = false; gp.hudMapZoom = 0;
    ctx.player.pSpeed = 0;
    return 'ok';
  })()`);
  await sleep(900);

  // Dispatch on window ONLY. A document-target event bubbles up to window too,
  // so sending both fires the handler twice and silently double-steps the walk.
  const key = (k) => evaluate(`(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '${k}', bubbles: true }));
    return 'x';
  })()`);
  const state = () => evaluate(`(() => {
    const gp = window.__dc.ctx.life.gameplaySettings;
    return (gp.hudMapOpen === true ? 'open' : 'closed') + ' zoom=' + (gp.hudMapZoom ?? 'default');
  })()`);

  const clip = await evaluate(`(() => {
    const r = window.__dc.hudCanvas.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width * 0.4, h: r.height };
  })()`);
  const shot = async (name) => {
    const s = await send('Page.captureScreenshot', {
      format: 'png', clip: { x: clip.x, y: clip.y, width: clip.w, height: clip.h, scale: 2 },
    }, sessionId);
    writeFileSync(path.join(OUT, `zoom_${name}.png`), Buffer.from(s.data, 'base64'));
    console.log('captured', name, '->', await state());
  };

  await key('g');                       // closed -> open at CITY
  await sleep(600);
  await shot('1_city');
  for (const [i, name] of [[1, '2_x2'], [2, '3_x4'], [3, '4_x8']]) {
    await key('g');
    await sleep(700);
    await shot(name);
    if (i === 3) break;
  }
  // One more press must close it (the Diablo walk wraps off the end).
  await key('g');
  await sleep(400);
  console.log('after final G ->', await state());

  // Re-bake cost. Sample frame deltas across a jump straight to the deepest
  // zoom: the spike frame IS the bake, and every frame after it must be back to
  // baseline or the "bake once, blit a window" claim is wrong.
  await evaluate(`(() => {
    const gp = window.__dc.ctx.life.gameplaySettings;
    gp.hudMapOpen = true; gp.hudMapZoom = 0;
    window.__probe = { deltas: [], bakeAt: -1 };
    let last = performance.now(); let n = 0;
    const tick = () => {
      const now = performance.now();
      window.__probe.deltas.push(+(now - last).toFixed(1));
      last = now; n++;
      if (n === 6) { gp.hudMapZoom = 3; window.__probe.bakeAt = n; }
      if (n < 26) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return 'armed';
  })()`);
  await sleep(1600);
  console.log('frame deltas (bake fires after sample 6):',
    await evaluate(`JSON.stringify(window.__probe)`));
} finally { kill(); }
console.log('done ->', OUT);
