// H1281 verification: wobbly-finger taps on the UPGRADE category chips.
// Boots the dev build in headless Edge (mobile emulation), walks the REAL
// new-game flow, enters the garage UPGRADE view, then dispatches REAL CDP
// touch sequences. Covers BOTH fixed bugs:
//   1. scroll-drag classifier eating wobbly taps on the non-scrolling view
//   2. invisible pager badge zone under the overlay stealing chip taps
import { writeFileSync } from 'node:fs';
import { bootToPlaying, sleep } from './boot.mjs';

const { send, evaluate, sessionId, kill } = await bootToPlaying();
const results = [];
try {
  await evaluate(`(() => { const ctx = window.__dc.ctx;
    ctx.home.open = true; ctx.home.tab = 'garage';
    ctx.life._garageView = 'tune'; ctx.life._garageTuneCarId = ctx.life.ownedCars[0];
    return 'x'; })()`);
  let haveRects = false;
  for (let i = 0; i < 25 && !haveRects; i++) {
    await sleep(200);
    haveRects = await evaluate(`(window.__dc.ctx.life._garageTuneCatHits?.length ?? 0) > 0`);
  }
  if (!haveRects) throw new Error('tune view never painted its hit rects');
  // the fresh-game JUICE page arms the pager pop-in — exactly the state that
  // used to steal these taps; keep it armed for the test.
  await evaluate(`window.__dc.ctx.life._pagerPopFrames = 300; 'armed'`);

  const chipCenter = (idx) => evaluate(`(() => {
    const dc = window.__dc; const c = dc.hudCanvas; const r = c.getBoundingClientRect();
    const h = dc.ctx.life._garageTuneCatHits[${idx}];
    const sx = r.width / c.width, sy = r.height / c.height;
    return { x: r.left + (h.vx + h.vw / 2) * sx, y: r.top + (h.vy + h.vh / 2) * sy, kind: h.kind };
  })()`);

  // wobbly tap: down, drift +10 CSS px in Y (past DRAG_PX=8), back -4, up
  async function wobblyTap(x, y) {
    const pt = (yy) => [{ x, y: yy, id: 1 }];
    await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt(y) }, sessionId);
    await sleep(40);
    await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pt(y + 6) }, sessionId);
    await sleep(30);
    await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pt(y + 10) }, sessionId);
    await sleep(30);
    await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pt(y + 6) }, sessionId);
    await sleep(40);
    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }, sessionId);
    await sleep(150);
  }

  await evaluate(`window.__dc.ctx.life._tuneCategory = 'tires'`);
  for (const [idx, want] of [[0, 'power'], [1, 'weight']]) {
    const c = await chipCenter(idx);
    await wobblyTap(c.x, c.y);
    const got = await evaluate(`window.__dc.ctx.life._tuneCategory`);
    const pager = await evaluate(`window.__dc.ctx.life._pagerOpen === true`);
    results.push({ tap: `wobbly tap ${want} chip`, got: got + (pager ? ' (PAGER STOLE IT)' : ''), pass: got === want && !pager });
  }
  // clean tap (no wobble) sanity
  const b = await chipCenter(2);
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: b.x, y: b.y, id: 1 }] }, sessionId);
  await sleep(60);
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }, sessionId);
  await sleep(150);
  const gotB = await evaluate(`window.__dc.ctx.life._tuneCategory`);
  results.push({ tap: 'clean tap brakes chip', got: gotB, pass: gotB === 'brakes' });

  // BACK button by touch — leaves tune for the list
  const back = await evaluate(`(() => {
    const dc = window.__dc; const c = dc.hudCanvas; const r = c.getBoundingClientRect();
    const bb = dc.ctx.life._garageTuneBackRect;
    return { x: r.left + (bb.x + bb.w/2) * (r.width / c.width), y: r.top + (bb.y + bb.h/2) * (r.height / c.height) };
  })()`);
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: back.x, y: back.y, id: 1 }] }, sessionId);
  await sleep(60);
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }, sessionId);
  await sleep(200);
  const viewAfterBack = await evaluate(`window.__dc.ctx.life._garageView`);
  results.push({ tap: 'touch BACK -> garage list', got: viewAfterBack, pass: viewAfterBack === 'list' });

  // pager badge still works where it IS drawn (drive HUD, no overlay)
  await evaluate(`(() => { const ctx = window.__dc.ctx;
    ctx.home.open = false; ctx.menu.open = false;
    ctx.life._pagerPopFrames = 300; window.__dc.ctx.life._pagerOpen = false; return 'x'; })()`);
  await sleep(400);
  const badge = await evaluate(`(() => {
    const c = window.__dc.hudCanvas; const r = c.getBoundingClientRect();
    const GW = c.width, GH = c.height;
    const box = Math.max(60, Math.min(400, GW * 0.5 - 24, GH * 0.42));
    const y = Math.round(4 + box * (78 / 110) + 14) + 10;
    return { x: r.left + 30 * (r.width / GW), y: r.top + y * (r.height / GH) };
  })()`);
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: badge.x, y: badge.y, id: 1 }] }, sessionId);
  await sleep(60);
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }, sessionId);
  await sleep(200);
  const pagerOpened = await evaluate(`window.__dc.ctx.life._pagerOpen === true`);
  results.push({ tap: 'pager badge on drive HUD', got: 'open=' + pagerOpened, pass: pagerOpened === true });
  await evaluate(`window.__dc.ctx.life._pagerOpen = false; 'x'`);

  // regression: tune drag does not move hidden list scroll
  await evaluate(`(() => { const ctx = window.__dc.ctx;
    ctx.home.open = true; ctx.home.tab = 'garage'; ctx.life._garageView = 'tune'; return 'x'; })()`);
  await sleep(500);
  const before = await evaluate(`window.__dc.ctx.life._garageScrollY ?? 0`);
  const p = await chipCenter(2);
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y + 60, id: 1 }] }, sessionId);
  for (let dy = 10; dy <= 80; dy += 10) {
    await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: p.x, y: p.y + 60 - dy, id: 1 }] }, sessionId);
    await sleep(16);
  }
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }, sessionId);
  await sleep(150);
  const after = await evaluate(`window.__dc.ctx.life._garageScrollY ?? 0`);
  results.push({ tap: 'tune drag -> hidden list scroll', got: `${before} -> ${after}`, pass: before === after });

  // regression: OPT tab still drag-scrolls
  await evaluate(`(() => { const ctx = window.__dc.ctx;
    ctx.home.open = false; ctx.menu.open = true; ctx.menu.tab = 'opt'; return 'x'; })()`);
  await sleep(400);
  const optBefore = await evaluate(`window.__dc.ctx.life._menuTabScrollY ?? 0`);
  const mid = await evaluate(`(() => {
    const r = window.__dc.hudCanvas.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height * 0.6 };
  })()`);
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: mid.x, y: mid.y, id: 1 }] }, sessionId);
  for (let dy = 12; dy <= 120; dy += 12) {
    await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: mid.x, y: mid.y - dy, id: 1 }] }, sessionId);
    await sleep(16);
  }
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }, sessionId);
  await sleep(200);
  const optAfter = await evaluate(`window.__dc.ctx.life._menuTabScrollY ?? 0`);
  results.push({ tap: 'OPT drag scroll', got: `${optBefore} -> ${optAfter}`, pass: optAfter > optBefore });

  // proof screenshot: tune view, POWER selected via the wobbly tap path
  await evaluate(`(() => { const ctx = window.__dc.ctx;
    ctx.menu.open = false; ctx.home.open = true; ctx.home.tab = 'garage';
    ctx.life._garageView = 'tune'; return 'x'; })()`);
  await sleep(400);
  const c0 = await chipCenter(0);
  await wobblyTap(c0.x, c0.y);
  await sleep(400);
  const shot = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
  writeFileSync(new URL('./tune_after_fix.png', import.meta.url), Buffer.from(shot.data, 'base64'));
} finally { kill(); }

let fail = false;
for (const r of results) {
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.tap.padEnd(34)} -> ${r.got}`);
  if (!r.pass) fail = true;
}
console.log(fail ? 'VERIFY FAIL' : 'VERIFY OK');
process.exitCode = fail ? 1 : 0;
