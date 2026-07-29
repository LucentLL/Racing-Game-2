// H1284 verify: garage SPECS X-ray inspection.
// Boots headless, opens home -> garage -> SPECS for the active car,
// captures the sheet, taps the X-RAY chip THROUGH the real click router
// (synthetic canvas click at the stashed rect), captures the X-ray panel.
import { writeFileSync } from 'node:fs';
import { bootToPlaying, sleep } from './boot.mjs';

const { send, evaluate, sessionId, kill } = await bootToPlaying();
try {
  await evaluate(`(() => {
    const ctx = window.__dc.ctx;
    ctx.home.open = true; ctx.home.tab = 'garage';
    ctx.life._garageView = 'specs';
    ctx.life._garageSpecsCarId = ctx.life.ownedCars[0];
    ctx.life._garageSpecsXray = false;
    return ctx.life.ownedCars[0];
  })()`).then((id) => console.log('specs car:', id));
  await sleep(800);
  let shot = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
  writeFileSync(new URL('./specs_sheet.png', import.meta.url), Buffer.from(shot.data, 'base64'));

  // Tap the X-RAY chip via its stashed rect -> real click router.
  const tapped = await evaluate(`(() => {
    const dc = window.__dc; const c = dc.hudCanvas;
    const xr = dc.ctx.life._garageSpecsXrayRect;
    if (!xr) return 'NO RECT';
    const r = c.getBoundingClientRect();
    const cx = r.left + (xr.x + xr.w / 2) * (r.width / c.width);
    const cy = r.top + (xr.y + xr.h / 2) * (r.height / c.height);
    c.dispatchEvent(new MouseEvent('click', { clientX: cx, clientY: cy, bubbles: true }));
    return 'tapped';
  })()`);
  console.log('chip:', tapped);
  await sleep(600);
  console.log('xray flag:', await evaluate(`window.__dc.ctx.life._garageSpecsXray === true`));
  shot = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
  writeFileSync(new URL('./specs_xray.png', import.meta.url), Buffer.from(shot.data, 'base64'));
} finally { kill(); }
console.log('done');
