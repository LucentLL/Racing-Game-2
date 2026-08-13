// H1317 OSM-B verify: boot to 'playing', switch to charlotte-osm via the
// statically-bound __dc.switchMap hook, assert world state, measure frame
// time, screenshot the spawn (I-485 mid-beltway).
//   node tools/uilab/osmmapshot.mjs
import { writeFileSync } from 'node:fs';
import { bootToPlaying, sleep } from './boot.mjs';

// optional: node osmmapshot.mjs <tileX> <tileY> <name> — teleport before shot
const [TX, TY, NAME = 'osm_spawn'] = process.argv.slice(2);
const { send, evaluate, sessionId, kill } = await bootToPlaying({ port: 9231, profile: 'h1317-edge' });
try {
  console.log('gameState:', await evaluate(`window.__dc.ctx.gameState`));

  const t0 = Date.now();
  await evaluate(`window.__dc.switchMap('charlotte-osm'); 'ok'`);
  console.log('switchMap wall time:', Date.now() - t0, 'ms');
  await sleep(1200);

  const state = await evaluate(`(() => {
    const wm = window.__dcWorld;
    const ctx = window.__dc.ctx;
    const entries = wm.RENDER_ENTRIES;
    let z4 = 0; for (const e of entries) if ((e.row[3]|0) >= 2) z4++;
    return {
      gameState: ctx.gameState,
      entries: entries.length,
      elevated: z4,
      traffic: ctx.traffic.length,
      px: Math.round(ctx.player.px / 18), py: Math.round(ctx.player.py / 18),
      crossings: (globalThis.__crossN ?? -1),
    };
  })()`);
  console.log('after switch:', JSON.stringify(state));

  // close the HOME overlay the boot walk leaves open + force noon for a
  // readable screenshot (render-only clock poke, dev harness only)
  await evaluate(`(() => {
    window.__dc.ctx.home.open = false;
    window.__dc.ctx.clock.hour = 12;
    return 'ok';
  })()`);

  // rough frame time: rAF delta sampling (awaitPromise via raw CDP send)
  const fr = await send('Runtime.evaluate', {
    expression: `new Promise((res) => {
      const ds = [];
      let last = performance.now(); let n = 0;
      const step = (t) => { ds.push(t - last); last = t; if (++n < 120) requestAnimationFrame(step); else res(ds); };
      requestAnimationFrame(step);
    }).then((ds) => { ds.sort((a,b)=>a-b); return JSON.stringify({ p50: +ds[60].toFixed(1), p90: +ds[108].toFixed(1), max: +ds[119].toFixed(1) }); })`,
    awaitPromise: true, returnByValue: true,
  }, sessionId);
  console.log('frame ms (p50/p90/max):', fr.result?.value);

  const errs = await evaluate(`(window.__errs ?? []).slice(0,5)`);
  console.log('page errors:', JSON.stringify(errs));

  if (TX && TY) {
    await evaluate(`(() => {
      window.__dc.ctx.player.px = ${Number(TX)} * 18;
      window.__dc.ctx.player.py = ${Number(TY)} * 18;
      return 'ok';
    })()`);
    await sleep(600);
  } else {
    // hold W so the car moves down the beltway
    await evaluate(`window.__dc.ctx.inputHeld.up = true; 'ok'`);
    await sleep(4000);
  }
  const shot = await send('Page.captureScreenshot', { format: 'jpeg', quality: 82 }, sessionId);
  writeFileSync(new URL(`./${NAME}.jpg`, import.meta.url), Buffer.from(shot.data, 'base64'));
  console.log(`wrote tools/uilab/${NAME}.jpg`);
} finally {
  kill();
}
